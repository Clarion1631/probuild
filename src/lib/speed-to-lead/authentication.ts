import { z } from "zod";

/**
 * Inbox poll authentication (docs/plans/SPEED-TO-LEAD-V1A.md "(3) Codex
 * findings ... Authentication rules (finding 1)").
 *
 * Two trust rules, both required to be built-in defaults (R0's "replace not
 * merge" footgun otherwise silently drops Voice trust the moment someone
 * only means to override the website pattern):
 *
 *  - Voice (direct): voice-noreply@google.com mails gtrsupport@ with no
 *    Group hop. Trust its own top Authentication-Results outright.
 *  - Website (Group relay): the site's Resend-sent mail reaches connect@ (a
 *    Google Group), which re-signs everything it relays with its OWN key
 *    before forwarding to gtrsupport@. The Group's re-signature (`dkim=pass
 *    s=google`) therefore says nothing about the ORIGINAL sender — R0 found
 *    goldentouchremodeling.com publishes DMARC `p=NONE`, so a spoofed
 *    `From: website@...` posted straight to connect@ is not rejected on the
 *    way in, and would show `dkim=pass`/`dmarc=pass` at the boundary exactly
 *    like a real one. Trust instead requires Google's OWN chain-validity
 *    verdict (`arc=pass` on the receiving header) PLUS reading the FIRST
 *    (i=1) ARC set — the hop architecturally required to be Google-
 *    controlled — never a later instance any relay could have added.
 *
 * KNOWN OPEN ITEM (flagged in the spec, not resolved by this branch): the
 * exact `d=` value Google stamps on a real `ARC-Seal i=1` for this domain's
 * mail was not captured at R0 (R0 recorded `cv=` but not `d=` on sample
 * 1a0cfd52fb38aade). This file implements the rule as specified
 * (`d=google.com`); Justin's R2/R3 production acceptance tests are what
 * actually exercises it against a real Google-relayed message, and if that
 * value differs the fix is a one-line constant change here, not a redesign.
 */

export interface RawHeader {
    name: string;
    value: string;
}

export interface TrustedSenderPattern {
    /** Exact From address this pattern applies to, lowercase. */
    fromAddress: string;
    /** The signing domain a trusted message's DKIM/DMARC must show. */
    signingDomain: string;
}

const DEFAULT_WEBSITE_FROM = "website@goldentouchremodeling.com";
const DEFAULT_WEBSITE_SIGNING_DOMAIN = "goldentouchremodeling.com";
const DEFAULT_VOICE_FROM = "voice-noreply@google.com";
const DEFAULT_VOICE_SIGNING_DOMAIN = "google.com";

const DEFAULT_PATTERNS: TrustedSenderPattern[] = [
    { fromAddress: DEFAULT_WEBSITE_FROM, signingDomain: DEFAULT_WEBSITE_SIGNING_DOMAIN },
    { fromAddress: DEFAULT_VOICE_FROM, signingDomain: DEFAULT_VOICE_SIGNING_DOMAIN },
];

const trustedSenderPatternSchema = z
    .array(z.object({ fromAddress: z.string().trim().min(1), signingDomain: z.string().trim().min(1) }))
    .min(1);

/**
 * `SPEED_TO_LEAD_TRUSTED_SENDERS` REPLACES the defaults wholesale when set —
 * it must be valid JSON matching the schema, or the built-in defaults apply
 * and an error is logged (never a silent partial config, never a crash).
 */
export function trustedSenderPatterns(env: NodeJS.ProcessEnv = process.env): TrustedSenderPattern[] {
    const raw = env.SPEED_TO_LEAD_TRUSTED_SENDERS;
    if (!raw || !raw.trim()) return DEFAULT_PATTERNS;
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch {
        console.error("[speed-to-lead] SPEED_TO_LEAD_TRUSTED_SENDERS is not valid JSON; using defaults");
        return DEFAULT_PATTERNS;
    }
    const result = trustedSenderPatternSchema.safeParse(parsedJson);
    if (!result.success) {
        console.error("[speed-to-lead] SPEED_TO_LEAD_TRUSTED_SENDERS failed schema validation; using defaults", result.error.message);
        return DEFAULT_PATTERNS;
    }
    return result.data.map(p => ({ fromAddress: p.fromAddress.trim().toLowerCase(), signingDomain: p.signingDomain.trim().toLowerCase() }));
}

// ── Header parsing (comments stripped BEFORE any key=value is read) ────────

/** Repeatedly strips balanced `(...)` groups so a `dmarc=` (etc.) written INSIDE a comment — e.g. `arc=pass (i=2 ... dmarc=pass ...)` — is never read as a top-level result. */
function stripComments(value: string): string {
    let prev = value;
    let cur = value.replace(/\([^()]*\)/g, " ");
    while (cur !== prev) {
        prev = cur;
        cur = cur.replace(/\([^()]*\)/g, " ");
    }
    return cur;
}

interface MethodResult {
    method: string;
    result: string;
    tags: Record<string, string>;
}

/** Parses one Authentication-Results / ARC-Authentication-Results header VALUE (with any leading `i=<n>;` ARC-set prefix already stripped by the caller) into its authserv-id plus each top-level `method=result tag=value ...` segment. */
function parseMethodResults(rawValue: string): { authservId: string | null; results: MethodResult[] } {
    const stripped = stripComments(rawValue);
    const authservId = /^\s*([^\s;]+)/.exec(stripped)?.[1]?.toLowerCase() ?? null;
    const rest = stripped.replace(/^\s*[^\s;]+;?/, "");
    const results: MethodResult[] = [];
    for (const segment of rest.split(";").map(s => s.trim()).filter(Boolean)) {
        const head = /^([a-z0-9_-]+)=([a-z0-9_-]+)\s*(.*)$/i.exec(segment);
        if (!head) continue;
        const [, method, result, tagsText] = head;
        const tags: Record<string, string> = {};
        const tagPattern = /([a-z0-9_.-]+)=(\S+)/gi;
        let tagMatch: RegExpExecArray | null;
        while ((tagMatch = tagPattern.exec(tagsText))) {
            tags[tagMatch[1].toLowerCase()] = tagMatch[2];
        }
        results.push({ method: method.toLowerCase(), result: result.toLowerCase(), tags });
    }
    return { authservId, results };
}

/** Domain out of a `header.i=` tag, which is an address-or-`@domain` form — never conflated with `header.d=` (a different mechanism, RFC 6376 vs DMARC alignment). Falls back to `header.d=` when present, since some MTAs emit that tag instead. */
function domainOf(result: MethodResult): string | null {
    const i = result.tags["header.i"];
    if (i) {
        const at = i.lastIndexOf("@");
        if (at >= 0) return i.slice(at + 1).toLowerCase();
    }
    const d = result.tags["header.d"];
    if (d) return d.toLowerCase();
    return null;
}

function fromDomainOf(result: MethodResult): string | null {
    const value = result.tags["header.from"];
    return value ? value.toLowerCase() : null;
}

function findResult(results: MethodResult[], method: string, extraTag?: { tag: string; value: string }): MethodResult | undefined {
    return results.find(r => r.method === method && (!extraTag || r.tags[extraTag.tag]?.toLowerCase() === extraTag.value.toLowerCase()));
}

/** The TOPMOST header of a given name — Gmail prepends new hops, so index 0 is the receiving boundary. */
function topmost(headers: RawHeader[], name: string): RawHeader | undefined {
    return headers.find(h => h.name.toLowerCase() === name.toLowerCase());
}

function headerValue(headers: RawHeader[], name: string): string | null {
    return topmost(headers, name)?.value ?? null;
}

/** A semicolon-separated `tag=value` header (ARC-Seal, DKIM-Signature style) into a tag map — no comments in these header forms, so no stripping needed. */
function parseTagged(rawValue: string): Record<string, string> {
    const tags: Record<string, string> = {};
    for (const part of rawValue.split(";")) {
        const m = /^\s*([a-z0-9_-]+)\s*=\s*(.+?)\s*$/i.exec(part);
        if (m) tags[m[1].toLowerCase()] = m[2];
    }
    return tags;
}

/** Every ARC-Seal header's `{i, d}` pair — needed to prove EXACTLY ONE i=1 exists (a duplicate is a forgery signal, test 11c) and to read its sealing domain. */
function arcSealEntries(headers: RawHeader[]): { instance: number; d: string | null }[] {
    return headers
        .filter(h => h.name.toLowerCase() === "arc-seal")
        .map(h => {
            const tags = parseTagged(h.value);
            const instance = Number(tags.i);
            return { instance: Number.isFinite(instance) ? instance : -1, d: tags.d?.toLowerCase() ?? null };
        });
}

/** Every ARC-Authentication-Results header's `{instance, parsed}` — same "exactly one i=1" requirement as ARC-Seal. */
function arcAuthResultsEntries(headers: RawHeader[]): { instance: number; authservId: string | null; results: MethodResult[] }[] {
    return headers
        .filter(h => h.name.toLowerCase() === "arc-authentication-results")
        .map(h => {
            const instanceMatch = /^\s*i=(\d+)\s*;\s*([\s\S]*)$/i.exec(h.value);
            if (!instanceMatch) return { instance: -1, authservId: null, results: [] };
            const { authservId, results } = parseMethodResults(instanceMatch[2]);
            return { instance: Number(instanceMatch[1]), authservId, results };
        });
}

export interface AuthenticationVerdict {
    trusted: boolean;
    /** Which trust rule matched — stored on the intake row instead of raw headers (V1A: "store the matched trust rule, not raw headers"). */
    rule: "website-group-relay" | "voice-direct" | null;
    reason?: string;
}

const GOOGLE_AUTHSERV_ID = "mx.google.com";
/** Google's own infrastructure is what performs ARC sealing for mail relayed through a Google Group — this is Google's identity, not the website's signing domain, and is not overridable via SPEED_TO_LEAD_TRUSTED_SENDERS. */
const ARC_SEALER_DOMAIN = "google.com";
/** Structural to the connect@ Group itself, not a per-message trust choice. */
const CONNECT_GROUP_ID = "347075611006";
const CONNECT_GROUP_LIST_ID = "<connect.goldentouchremodeling.com>";

const VOICE_SUBJECT_PREFIXES = ["new missed call from", "new voicemail from", "new text message from"];

function authenticateWebsiteGroupRelay(headers: RawHeader[], pattern: TrustedSenderPattern): AuthenticationVerdict {
    const groupId = headerValue(headers, "X-Google-Group-Id");
    const listId = headerValue(headers, "List-ID");
    if (!groupId || groupId.trim() !== CONNECT_GROUP_ID) return { trusted: false, rule: null, reason: "missing or wrong X-Google-Group-Id" };
    if (!listId || listId.trim().toLowerCase() !== CONNECT_GROUP_LIST_ID) return { trusted: false, rule: null, reason: "missing or wrong List-ID" };

    // The top-level boundary result must itself be Google's, and must report
    // the ARC chain unbroken. This is the receiving-boundary check — without
    // it, a crafted top "Authentication-Results: attacker.example; arc=pass"
    // would walk straight into the i=1 branch below with no Google
    // involvement verified at all.
    const topRaw = headerValue(headers, "Authentication-Results");
    if (!topRaw) return { trusted: false, rule: null, reason: "no Authentication-Results header" };
    const top = parseMethodResults(topRaw);
    if (top.authservId !== GOOGLE_AUTHSERV_ID) return { trusted: false, rule: null, reason: "top Authentication-Results is not from mx.google.com" };
    if (findResult(top.results, "arc")?.result !== "pass") return { trusted: false, rule: null, reason: "top-level arc= is not pass" };

    // Exactly one ARC-Seal at i=1, sealed by Google — an attacker-sealed i=1
    // claiming a DIFFERENT d= must fail here even though Google's OWN
    // arc=pass verdict above says the chain (as received) is unbroken:
    // chain validity proves nothing was tampered with SINCE the seal, never
    // that the sealed content is trustworthy (RFC 8617 §9). A duplicate i=1
    // (two ARC-Seal headers both claiming instance 1) is treated the same as
    // missing — never "trust either one".
    const seals = arcSealEntries(headers).filter(s => s.instance === 1);
    if (seals.length !== 1) return { trusted: false, rule: null, reason: "expected exactly one ARC-Seal i=1" };
    if (seals[0].d !== ARC_SEALER_DOMAIN) return { trusted: false, rule: null, reason: "ARC-Seal i=1 was not sealed by google.com" };

    // Exactly one ARC-Authentication-Results at i=1, itself from mx.google.com
    // (the hop architecturally required to be Google-controlled — "its first
    // Google hop"), showing Resend's own dkim=pass (header.s=resend) and
    // dmarc=pass for the website's real signing domain. The top-level
    // dkim=pass (the Group's own s=google re-signature) is NEVER read here —
    // it says nothing about the original sender.
    const aars = arcAuthResultsEntries(headers).filter(a => a.instance === 1);
    if (aars.length !== 1) return { trusted: false, rule: null, reason: "expected exactly one ARC-Authentication-Results i=1" };
    const aar = aars[0];
    if (aar.authservId !== GOOGLE_AUTHSERV_ID) return { trusted: false, rule: null, reason: "ARC-Authentication-Results i=1 is not from mx.google.com" };

    const resendDkim = findResult(aar.results, "dkim", { tag: "header.s", value: "resend" });
    if (!resendDkim || resendDkim.result !== "pass") return { trusted: false, rule: null, reason: "ARC i=1 has no dkim=pass header.s=resend" };
    if (domainOf(resendDkim) !== pattern.signingDomain) return { trusted: false, rule: null, reason: "ARC i=1 dkim signing domain mismatch" };

    const dmarc = findResult(aar.results, "dmarc");
    if (!dmarc || dmarc.result !== "pass") return { trusted: false, rule: null, reason: "ARC i=1 has no dmarc=pass" };
    if (fromDomainOf(dmarc) !== pattern.signingDomain) return { trusted: false, rule: null, reason: "ARC i=1 dmarc From-domain mismatch" };

    return { trusted: true, rule: "website-group-relay" };
}

function authenticateVoiceDirect(headers: RawHeader[], pattern: TrustedSenderPattern): AuthenticationVerdict {
    if (headerValue(headers, "X-Google-Group-Id")) return { trusted: false, rule: null, reason: "Voice mail unexpectedly carries a Group hop" };

    const topRaw = headerValue(headers, "Authentication-Results");
    if (!topRaw) return { trusted: false, rule: null, reason: "no Authentication-Results header" };
    const top = parseMethodResults(topRaw);
    if (top.authservId !== GOOGLE_AUTHSERV_ID) return { trusted: false, rule: null, reason: "top Authentication-Results is not from mx.google.com" };

    const dkim = findResult(top.results, "dkim");
    if (!dkim || dkim.result !== "pass" || domainOf(dkim) !== pattern.signingDomain) {
        return { trusted: false, rule: null, reason: "top-level dkim=pass google.com is missing" };
    }
    const dmarc = findResult(top.results, "dmarc");
    if (!dmarc || dmarc.result !== "pass" || fromDomainOf(dmarc) !== pattern.signingDomain) {
        return { trusted: false, rule: null, reason: "top-level dmarc=pass google.com is missing" };
    }

    // Subject filter is part of trust for THIS message type, not a separate
    // classification step — "Welcome to Google Voice" (account setup) must
    // never become a lead no matter how well it authenticates.
    const subject = (headerValue(headers, "Subject") ?? "").trim().toLowerCase();
    if (!VOICE_SUBJECT_PREFIXES.some(prefix => subject.startsWith(prefix))) {
        return { trusted: false, rule: null, reason: "subject is not a missed-call/voicemail/text notification" };
    }

    return { trusted: true, rule: "voice-direct" };
}

/**
 * `headers` must be in RECEIVED ORDER (topmost = newest = the receiving
 * mailbox's own boundary) — Gmail's API returns them that way already.
 */
export function authenticateMessage(headers: RawHeader[], fromAddress: string, env: NodeJS.ProcessEnv = process.env): AuthenticationVerdict {
    const from = fromAddress.trim().toLowerCase();
    const patterns = trustedSenderPatterns(env);
    const pattern = patterns.find(p => p.fromAddress === from);
    if (!pattern) return { trusted: false, rule: null, reason: "From address is not in the trusted-sender list" };

    // v1a supports exactly two message shapes (Voice, direct; website, via
    // the connect@ Group relay) — which rule applies is a property of the
    // FROM ADDRESS ITSELF, never of attacker-controlled headers like
    // X-Google-Group-Id, so this dispatch is on the already-matched pattern,
    // not on anything the message body or its other headers claim.
    return from === DEFAULT_VOICE_FROM
        ? authenticateVoiceDirect(headers, pattern)
        : authenticateWebsiteGroupRelay(headers, pattern);
}
