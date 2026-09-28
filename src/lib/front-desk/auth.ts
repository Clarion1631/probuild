/**
 * Front Desk v1 — the two signing schemes §0's diagram shows on the
 * "agent tools" and "call ends" arrows: ElevenLabs' post-call HMAC (§1 step
 * 3) and the tool routes' shared secret (§2.0).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { FRONT_DESK_WEBHOOK_SKEW_FUTURE_MS, FRONT_DESK_WEBHOOK_SKEW_PAST_MS } from "./constants";

export interface SignatureVerifyResult {
    ok: boolean;
    reason?: string;
}

/**
 * `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>`, HMAC-SHA256 over
 * `${t}.${rawBody}` (E1/E2). Exactly one `t=`; at least one `v0=` (their docs
 * allow more than one during key rotation — every value present is checked,
 * any match passes). `rawBody` MUST be the exact bytes that were signed,
 * read before any JSON.parse.
 */
export function verifyElevenLabsSignature(
    input: { header: string | null; rawBody: string; secret: string | undefined },
    now: () => Date = () => new Date(),
): SignatureVerifyResult {
    const { header, rawBody, secret } = input;
    if (!secret) return { ok: false, reason: "no shared secret configured" };
    if (!header) return { ok: false, reason: "missing signature header" };

    const parts = header.split(",").map(p => p.trim()).filter(Boolean);
    const tParts = parts.filter(p => p.startsWith("t="));
    const v0Parts = parts.filter(p => p.startsWith("v0="));
    if (tParts.length !== 1) return { ok: false, reason: "expected exactly one t=" };
    if (v0Parts.length < 1) return { ok: false, reason: "expected at least one v0=" };

    const t = tParts[0].slice("t=".length);
    if (!/^\d+$/.test(t)) return { ok: false, reason: "t is not a unix-seconds integer" };
    const tMs = Number(t) * 1000;
    if (!Number.isFinite(tMs)) return { ok: false, reason: "t is not finite" };

    const nowMs = now().getTime();
    if (nowMs - tMs > FRONT_DESK_WEBHOOK_SKEW_PAST_MS) return { ok: false, reason: "t older than 30 minutes" };
    if (tMs - nowMs > FRONT_DESK_WEBHOOK_SKEW_FUTURE_MS) return { ok: false, reason: "t more than 5 minutes in the future" };

    const expectedHex = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");
    let sawValidHex = false;
    for (const part of v0Parts) {
        const v0 = part.slice("v0=".length);
        if (!/^[0-9a-f]+$/i.test(v0)) continue;
        sawValidHex = true;
        const actualBuf = Buffer.from(v0, "hex");
        // A length mismatch is simply unequal, never a throw.
        if (actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf)) {
            return { ok: true };
        }
    }
    return { ok: false, reason: sawValidHex ? "signature mismatch" : "v0 is not hex" };
}

/**
 * §2.0: header `X-Front-Desk-Key`, compared as
 * `timingSafeEqual(sha256(given), sha256(secret))` — both sides always 32
 * bytes (a SHA-256 digest), so there is no length oracle. Runs before mode,
 * parse or any DB access.
 */
export function verifyToolSecret(given: string | null, secret: string | undefined): boolean {
    if (!secret || !given) return false;
    const givenDigest = createHash("sha256").update(given, "utf8").digest();
    const secretDigest = createHash("sha256").update(secret, "utf8").digest();
    return timingSafeEqual(givenDigest, secretDigest);
}
