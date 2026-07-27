// Shared URL-safety helper for rendering stored, user-supplied URLs (product
// vendorUrl/imageUrl, client-suggestion links, etc.) into href/img src. This is
// NOT the SSRF guard (that's isSafeExternalUrl in product-parse.ts, server-only,
// does DNS/IP validation) — this is a cheap, universally-importable check that a
// stored string is a plain http(s) URL and not `javascript:`, `data:`, `vbscript:`,
// or similar, before it's ever handed to the DOM. Has no server-only imports so
// both server components/actions and "use client" components can import it.
export function isHttpUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
        const parsed = new URL(trimmed);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}
