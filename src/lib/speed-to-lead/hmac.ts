import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SKEW_MS } from "./constants";

/**
 * Web intake signing (spec Goal 1): "The site POSTs a signed payload
 * (HMAC-SHA256 over `timestamp.body`, 5-minute skew, constant-time compare,
 * 2 quick retries)."
 *
 * Headers the site sends alongside the raw JSON body:
 *   X-GTR-Timestamp: unix seconds, string
 *   X-GTR-Signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *   X-GTR-Submission-Id: the same submissionId that also rides in the body
 *     and in the connect@ email header, so all three copies can be tied
 *     together (spec Goal 1).
 */
export const WEBHOOK_TIMESTAMP_HEADER = "x-gtr-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "x-gtr-signature";
export const WEBHOOK_SUBMISSION_ID_HEADER = "x-gtr-submission-id";

export interface WebhookVerifyResult {
    ok: boolean;
    reason?: string;
}

/** Constant-time compare of two hex strings; unequal lengths are simply unequal, never thrown. */
function hexEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a webhook request. `rawBody` MUST be the exact bytes that were
 * signed (read before any JSON.parse) — re-serializing the parsed body can
 * reorder keys or change whitespace and would never verify.
 */
export function verifyWebhookSignature(
    input: { timestamp: string | null; signature: string | null; rawBody: string; secret: string | undefined },
    now: () => Date = () => new Date(),
): WebhookVerifyResult {
    const { timestamp, signature, rawBody, secret } = input;
    if (!secret) return { ok: false, reason: "no shared secret configured" };
    if (!timestamp || !signature) return { ok: false, reason: "missing timestamp or signature header" };
    if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "timestamp header is not a unix-seconds integer" };
    if (!/^[0-9a-f]+$/i.test(signature)) return { ok: false, reason: "signature header is not hex" };

    const tsMs = Number(timestamp) * 1000;
    const skew = Math.abs(now().getTime() - tsMs);
    if (!Number.isFinite(tsMs) || skew > WEBHOOK_SKEW_MS) return { ok: false, reason: "timestamp outside the accepted skew" };

    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    if (!hexEqual(expected, signature)) return { ok: false, reason: "signature mismatch" };
    return { ok: true };
}
