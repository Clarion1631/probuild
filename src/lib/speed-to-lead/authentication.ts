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
    domain: string | null;
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
    const domain = (/\bheader\.d=([^\s;]+)/i.exec(value)?.[1] ?? /\bheader\.from=([^\s;]+)/i.exec(value)?.[1] ?? null)?.toLowerCase() ?? null;
    return { authservId, dkim, dmarc, domain };
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
    if (directHeader) {
        const parsed = parseAuthResults(directHeader.value);
        if (parsed.authservId === "mx.google.com" && parsed.dkim === "pass" && parsed.dmarc === "pass" && parsed.domain === pattern.signingDomain) {
            return { trusted: true, matchedPattern: pattern };
        }
    }

    // Relayed through connect@: the direct hop's DKIM breaks on forward, so
    // fall back to the first Google hop recorded in ARC.
    const arcHeader = topmost(headers, "ARC-Authentication-Results");
    if (arcHeader) {
        const parsed = parseAuthResults(arcHeader.value);
        if (parsed.authservId === "mx.google.com" && parsed.dkim === "pass" && parsed.dmarc === "pass" && parsed.domain === pattern.signingDomain) {
            return { trusted: true, matchedPattern: pattern };
        }
    }

    return { trusted: false, reason: "no matching Google Authentication-Results or ARC-Authentication-Results" };
}
