/**
 * Inbox poll authentication (spec Intake: "Authenticate"). "Trust only the
 * topmost Authentication-Results header whose authserv-id is mx.google.com
 * ... A trusted source needs dkim=pass and dmarc=pass for the expected
 * signing domain, plus the expected From address. For mail relayed through
 * connect@, ARC is accepted only when its first Google hop shows the same
 * pass. The expected patterns come from real samples captured at R0 and are
 * stored as config."
 *
 * R0 has not run yet (it is a human setup step — see the doer's final
 * report), so there is no captured sample to hard-code. The mechanism below
 * is real and testable; SPEED_TO_LEAD_TRUSTED_SENDERS is where the R0
 * samples get configured without a code change.
 */

export interface RawHeader {
    name: string;
    value: string;
}

export interface TrustedSenderPattern {
    /** Exact From address this pattern applies to, lowercase. */
    fromAddress: string;
    /** The signing domain dkim=pass / dmarc=pass (or the ARC first-hop's) must show. */
    signingDomain: string;
}

const DEFAULT_PATTERNS: TrustedSenderPattern[] = [
    { fromAddress: "voice-noreply@google.com", signingDomain: "google.com" },
];

export function trustedSenderPatterns(env: NodeJS.ProcessEnv = process.env): TrustedSenderPattern[] {
    const raw = env.SPEED_TO_LEAD_TRUSTED_SENDERS;
    if (raw && raw.trim()) {
        try {
            const parsed = JSON.parse(raw) as TrustedSenderPattern[];
            if (Array.isArray(parsed)) return parsed.map(p => ({ fromAddress: p.fromAddress.toLowerCase(), signingDomain: p.signingDomain.toLowerCase() }));
        } catch {
            console.error("[speed-to-lead] SPEED_TO_LEAD_TRUSTED_SENDERS is not valid JSON; using defaults");
        }
    }
    return DEFAULT_PATTERNS;
}

interface AuthResultFields {
    authservId: string | null;
    dkim: string | null;
    dmarc: string | null;
    /** Google's own verdict on the ARC chain it received, if it stamped one. */
    arc: string | null;
    /** The DKIM signing domain (header.d=) — independent of dmarcDomain. */
    dkimDomain: string | null;
    /** The DMARC-aligned From domain (header.from=) — independent of dkimDomain. */
    dmarcDomain: string | null;
}

/** Parses one Authentication-Results (or ARC-Authentication-Results) header VALUE. */
function parseAuthResults(rawValue: string): AuthResultFields {
    // ARC-Authentication-Results carries a leading "i=<instance>;" ARC-set
    // number that plain Authentication-Results does not — strip it before
    // reading the authserv-id, or "i=1" gets mistaken for it.
    const value = rawValue.replace(/^\s*i=\d+;\s*/i, "");
    const authservId = /^\s*([^\s;]+)/.exec(value)?.[1]?.toLowerCase() ?? null;
    const dkim = /\bdkim=([a-z]+)/i.exec(value)?.[1]?.toLowerCase() ?? null;
    const dmarc = /\bdmarc=([a-z]+)/i.exec(value)?.[1]?.toLowerCase() ?? null;
    const arc = /\barc=([a-z]+)/i.exec(value)?.[1]?.toLowerCase() ?? null;
    // header.d= (DKIM signing domain) and header.from= (DMARC-aligned From
    // domain) are DIFFERENT fields describing different mechanisms — they
    // must never be conflated into one "whichever is present" value, or a
    // header carrying one mechanism's domain can satisfy a check meant for
    // the other.
    const dkimDomain = (/\bheader\.d=([^\s;]+)/i.exec(value)?.[1] ?? null)?.toLowerCase() ?? null;
    const dmarcDomain = (/\bheader\.from=([^\s;]+)/i.exec(value)?.[1] ?? null)?.toLowerCase() ?? null;
    return { authservId, dkim, dmarc, arc, dkimDomain, dmarcDomain };
}

/** Both DKIM's signing domain and DMARC's aligned From domain must independently match the expected pattern — not "either one." */
function domainsMatch(parsed: AuthResultFields, expected: string): boolean {
    return parsed.dkimDomain === expected && parsed.dmarcDomain === expected;
}

/** The TOPMOST header of a given name — Gmail prepends new hops, so index 0 is the receiving boundary. */
function topmost(headers: RawHeader[], name: string): RawHeader | undefined {
    return headers.find(h => h.name.toLowerCase() === name.toLowerCase());
}

export interface AuthenticationVerdict {
    trusted: boolean;
    reason?: string;
    matchedPattern?: TrustedSenderPattern;
}

/**
 * `headers` must be in RECEIVED ORDER (topmost = newest = the receiving
 * mailbox's own boundary) — Gmail's API returns them that way already.
 */
export function authenticateMessage(headers: RawHeader[], fromAddress: string, env: NodeJS.ProcessEnv = process.env): AuthenticationVerdict {
    const from = fromAddress.trim().toLowerCase();
    const patterns = trustedSenderPatterns(env);
    const pattern = patterns.find(p => p.fromAddress === from);
    if (!pattern) return { trusted: false, reason: "From address is not in the trusted-sender list" };

    const directHeader = topmost(headers, "Authentication-Results");
    const directParsed = directHeader ? parseAuthResults(directHeader.value) : null;
    if (directParsed && directParsed.authservId === "mx.google.com" && directParsed.dkim === "pass" && directParsed.dmarc === "pass" && domainsMatch(directParsed, pattern.signingDomain)) {
        return { trusted: true, matchedPattern: pattern };
    }

    // Relayed through connect@: the direct hop's DKIM breaks on forward, so
    // fall back to the first Google hop recorded in ARC — but an
    // ARC-Authentication-Results header is ordinary message-header TEXT that
    // any upstream relay can forge; it is never itself cryptographically
    // verified here. RFC 8617 §9 makes the RECEIVING server's own chain
    // validation the trust boundary: Google states that verdict as "arc=" in
    // its OWN (direct) Authentication-Results header, so the ARC fallback may
    // only be consulted when Google itself reports "arc=pass" there — never
    // from the unsigned ARC-Authentication-Results text alone, and never when
    // the receiving header is silent on arc= or reports anything but pass.
    if (directParsed?.arc === "pass") {
        const arcHeader = topmost(headers, "ARC-Authentication-Results");
        if (arcHeader) {
            const parsed = parseAuthResults(arcHeader.value);
            if (parsed.authservId === "mx.google.com" && parsed.dkim === "pass" && parsed.dmarc === "pass" && domainsMatch(parsed, pattern.signingDomain)) {
                return { trusted: true, matchedPattern: pattern };
            }
        }
    }

    return { trusted: false, reason: "no matching Google Authentication-Results or ARC-Authentication-Results" };
}
