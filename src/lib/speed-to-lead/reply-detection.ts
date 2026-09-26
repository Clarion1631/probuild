import { OPT_OUT_PHRASES } from "./constants";
import type { RawHeader } from "./authentication";

/**
 * Spec Intake handler order #3 ("Replies and opt-outs"): "Auto-replies
 * (Auto-Submitted) and bounces are logged, and a bounce marks the address
 * undeliverable; neither counts as a reply or opt-out. For everything else,
 * opt-out words ... in the new text, with quoted parts stripped, create a
 * suppression. Anything else counts as a reply."
 */

function header(headers: RawHeader[], name: string): string | undefined {
    return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** RFC 3834: absent, or exactly "no", means NOT auto-submitted. Anything else IS. */
export function isAutoSubmitted(headers: RawHeader[]): boolean {
    const value = header(headers, "Auto-Submitted");
    return !!value && value.trim().toLowerCase() !== "no";
}

const BOUNCE_FROM_PATTERN = /^(mailer-daemon|postmaster|bounce[s]?)@/i;

export function isBounce(fromAddress: string, headers: RawHeader[]): boolean {
    if (BOUNCE_FROM_PATTERN.test(fromAddress.trim())) return true;
    const contentType = header(headers, "Content-Type") ?? "";
    return /report-type\s*=\s*delivery-status/i.test(contentType);
}

/** Strips quoted reply content: ">" quote lines, and everything from a common "On ... wrote:" / "-----Original Message-----" boundary onward. */
export function stripQuotedText(body: string): string {
    const boundaryPatterns = [
        /^-{2,}\s*Original Message\s*-{2,}/im,
        /^On .{0,200}wrote:\s*$/im,
        /^From:\s.*$/im,
    ];
    let cut = body;
    for (const pattern of boundaryPatterns) {
        const match = pattern.exec(cut);
        if (match && match.index !== undefined) cut = cut.slice(0, match.index);
    }
    return cut
        .split("\n")
        .filter(line => !line.trim().startsWith(">"))
        .join("\n")
        .trim();
}

/** Word-boundary match, never a bare substring — "stop" as plain `.includes()` also matches inside an ordinary word like "nonstop" or "doorstop", turning a reply that never opted out into a false one. */
export function containsOptOutPhrase(strippedText: string): boolean {
    const lower = strippedText.toLowerCase();
    return OPT_OUT_PHRASES.some(phrase => {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(lower);
    });
}

export type ReplyClassification = "auto-reply" | "bounce" | "opt-out" | "reply";

export function classifyInboundMessage(input: { fromAddress: string; headers: RawHeader[]; bodyText: string }): ReplyClassification {
    // Bounce first: a real MAILER-DAEMON bounce very often ALSO carries
    // Auto-Submitted: auto-generated, and a bounce needs its own side effect
    // (marking the endpoint undeliverable) that a plain auto-reply does not.
    if (isBounce(input.fromAddress, input.headers)) return "bounce";
    if (isAutoSubmitted(input.headers)) return "auto-reply";
    const stripped = stripQuotedText(input.bodyText);
    if (containsOptOutPhrase(stripped)) return "opt-out";
    return "reply";
}
