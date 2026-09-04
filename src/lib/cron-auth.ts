import { timingSafeEqual } from "node:crypto";

/**
 * Bearer auth for cron/ops endpoints.
 *
 * Two rules, both learned the hard way:
 *
 *  - FAIL CLOSED. The older `if (process.env.VERCEL_ENV && ...)` shape only
 *    checked the secret where VERCEL_ENV happened to be set, so the endpoint
 *    was wide open in any runtime that did not define it (a self-hosted build,
 *    a container, a preview whose env drifted). Authentication is now required
 *    everywhere except an explicit local `NODE_ENV === "development"`, and a
 *    MISSING CRON_SECRET rejects rather than waves traffic through.
 *
 *  - Constant time. A `!==` on a secret leaks it a byte at a time to anyone who
 *    can measure the response.
 */

/** Length-checked constant-time compare of an Authorization header. */
export function bearerMatches(header: string | null | undefined, secret: string | undefined): boolean {
    if (!secret || !header) return false;
    const expected = Buffer.from(`Bearer ${secret}`, "utf8");
    const actual = Buffer.from(header, "utf8");
    // timingSafeEqual throws on a length mismatch, so the lengths must be
    // compared first — length is not the secret, the bytes are.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(actual, expected);
}

/** True when the request carries the cron secret. No environment escape hatch. */
export function hasCronSecret(request: Request): boolean {
    return bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET);
}

/**
 * Cron-route gate: the secret, or an explicitly local dev run. Anything else —
 * including a deployment that forgot to set CRON_SECRET — is rejected.
 */
export function isCronAuthorized(request: Request): boolean {
    if (hasCronSecret(request)) return true;
    return process.env.NODE_ENV === "development";
}
