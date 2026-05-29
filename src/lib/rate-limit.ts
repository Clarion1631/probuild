/**
 * Best-effort in-memory sliding-window rate limiter.
 *
 * NOTE: state lives per serverless instance, so this is not a hard guarantee under fan-out —
 * it meaningfully slows credential-stuffing / brute-force but for strict limits back it with
 * a shared store (Upstash/Redis or a DB table). Mirrors the existing limiter in
 * purchase-orders/extract-pdf, centralized so other routes can reuse it.
 */
const buckets = new Map<string, number[]>();
const MAX_KEYS = 10_000; // backstop against unbounded growth from key-spraying

// Drop keys whose timestamps have all aged out. Called opportunistically when the map grows.
function sweep(now: number, windowMs: number) {
    for (const [k, ts] of buckets) {
        if (ts.length === 0 || now - ts[ts.length - 1] >= windowMs) buckets.delete(k);
    }
}

export type RateLimitResult = { allowed: boolean; retryAfterMs: number; remaining: number };

export function rateLimit(key: string, max: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    if (buckets.size > MAX_KEYS) sweep(now, windowMs);

    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
        buckets.set(key, hits);
        return { allowed: false, retryAfterMs: windowMs - (now - hits[0]), remaining: 0 };
    }
    hits.push(now);
    buckets.set(key, hits);
    return { allowed: true, retryAfterMs: 0, remaining: max - hits.length };
}

/** Extract a best-effort client IP from proxy headers. */
export function clientIp(req: Request): string {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    return req.headers.get("x-real-ip") || "unknown";
}
