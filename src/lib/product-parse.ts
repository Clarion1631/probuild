import dns from "node:dns";
import net from "node:net";

// ─── Product Clipper: url -> {name, price, imageUrl, vendor, description} ───
//
// Capture chain: JSON-LD (schema.org/Product) -> OpenGraph/meta tags -> Gemini
// fallback (arbitrary vendor page, worst case). Never throws — a parse failure
// always degrades to {vendorUrl, name: null} so the caller UI can fall back to
// manual entry. See docs/specs/product-library-portal-selections.md Phase 1.

export type ParsedProduct = {
    vendorUrl: string;
    name: string | null;
    description?: string;
    price?: number;
    imageUrl?: string;
    vendor?: string;
};

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // ~2MB cap
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * SSRF guard for the product clipper. Only public http/https URLs are allowed —
 * this rejects loopback, link-local, private (RFC1918/RFC4193), and other
 * reserved ranges so a pasted "product URL" can never be used to reach internal
 * infrastructure (e.g. cloud metadata at 169.254.169.254). Modeled on the
 * isOwnSignatureStorageUrl allowlist pattern in signature-storage.ts, but this
 * guard is a denylist because — unlike signatures — the whole point of the
 * clipper is fetching arbitrary third-party vendor sites.
 */
export async function isSafeExternalUrl(url: string): Promise<boolean> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!parsed.hostname) return false;

    // Reject bare IP literals AND resolved DNS results that land in a private
    // range — resolve the hostname ourselves rather than trusting fetch() to
    // reject internal targets after the fact.
    let addresses: string[];
    if (net.isIP(parsed.hostname)) {
        addresses = [parsed.hostname];
    } else {
        try {
            const results = await dns.promises.lookup(parsed.hostname, { all: true, verbatim: true });
            addresses = results.map((r) => r.address);
        } catch {
            return false; // unresolvable host — fail closed
        }
    }
    if (addresses.length === 0) return false;
    return addresses.every((addr) => !isPrivateOrReservedIp(addr));
}

function isPrivateOrReservedIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const parts = ip.split(".").map(Number);
        if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
        const [a, b] = parts;
        if (a === 10) return true; // 10.0.0.0/8
        if (a === 127) return true; // loopback
        if (a === 0) return true; // "this" network
        if (a === 169 && b === 254) return true; // link-local
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true; // 192.168.0.0/16
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
        if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
        return false;
    }
    if (net.isIPv6(ip)) {
        const lower = ip.toLowerCase();
        if (lower === "::1") return true; // loopback
        if (lower === "::") return true; // unspecified
        if (lower.startsWith("::ffff:")) {
            // IPv4-mapped IPv6 — check the embedded v4 address.
            const v4 = lower.split(":").pop() || "";
            if (net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
        }
        if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 (unique local)
        if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
        return false;
    }
    // Unknown format — fail closed.
    return true;
}

/**
 * Fetch a URL with a hard timeout and response-size cap. Caller must have
 * already validated the URL via isSafeExternalUrl(). Returns null on any
 * failure (timeout, non-2xx, oversized body, network error) — never throws.
 */
async function guardedFetchText(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            redirect: "follow",
            headers: {
                "User-Agent": BROWSER_USER_AGENT,
                Accept: "text/html,application/xhtml+xml",
            },
        });
        if (!res.ok || !res.body) return null;

        const contentLengthHeader = res.headers.get("content-length");
        if (contentLengthHeader && Number(contentLengthHeader) > MAX_RESPONSE_BYTES) return null;

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                total += value.byteLength;
                if (total > MAX_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => {});
                    return null;
                }
                chunks.push(value);
            }
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

function toNumberOrUndefined(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const cleaned = value.replace(/[^0-9.]/g, "");
        const num = parseFloat(cleaned);
        if (!Number.isNaN(num)) return num;
    }
    return undefined;
}

function firstString(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
        for (const v of value) {
            const s = firstString(v);
            if (s) return s;
        }
    }
    if (value && typeof value === "object" && "name" in (value as any)) {
        return firstString((value as any).name);
    }
    if (value && typeof value === "object" && "url" in (value as any)) {
        return firstString((value as any).url);
    }
    return undefined;
}

/**
 * Extract a schema.org/Product from any JSON-LD <script> blocks on the page.
 * Handles both a bare Product object and an @graph array containing one.
 */
function parseJsonLdProduct(html: string): Partial<ParsedProduct> | null {
    const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRe.exec(html))) {
        let data: any;
        try {
            data = JSON.parse(match[1].trim());
        } catch {
            continue;
        }
        const candidates: any[] = Array.isArray(data) ? data : [data];
        for (const candidate of candidates) {
            const nodes: any[] = candidate?.["@graph"] ? candidate["@graph"] : [candidate];
            for (const node of nodes) {
                const types = Array.isArray(node?.["@type"]) ? node["@type"] : [node?.["@type"]];
                if (!types.some((t: unknown) => typeof t === "string" && t.toLowerCase() === "product")) continue;

                const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
                const price = toNumberOrUndefined(offer?.price ?? offer?.lowPrice);
                const name = firstString(node.name);
                if (!name) continue;

                return {
                    name,
                    description: firstString(node.description),
                    imageUrl: firstString(node.image),
                    price,
                    vendor: firstString(node.brand) || firstString(offer?.seller),
                };
            }
        }
    }
    return null;
}

function extractMetaContent(html: string, attr: "property" | "name", key: string): string | undefined {
    const re = new RegExp(
        `<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`,
        "i",
    );
    const reversed = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`,
        "i",
    );
    const match = html.match(re) || html.match(reversed);
    return match?.[1]?.trim() || undefined;
}

function parseOpenGraph(html: string): Partial<ParsedProduct> | null {
    const title = extractMetaContent(html, "property", "og:title");
    const image = extractMetaContent(html, "property", "og:image");
    const priceAmount = extractMetaContent(html, "property", "product:price:amount");
    const siteName = extractMetaContent(html, "property", "og:site_name");
    const description = extractMetaContent(html, "property", "og:description");

    if (!title && !image) return null;

    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const name = title || titleTagMatch?.[1]?.trim();
    if (!name) return null;

    return {
        name,
        description,
        imageUrl: image,
        price: toNumberOrUndefined(priceAmount),
        vendor: siteName,
    };
}

function stripHtmlToText(html: string, maxChars: number): string {
    const withoutScripts = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return withoutScripts.slice(0, maxChars);
}

/**
 * Gemini fallback: give the model stripped page text and ask for strict JSON.
 * Uses the same generativelanguage.googleapis.com REST call pattern as the
 * rest of src/lib/actions.ts (aiGeneratePunchlist, aiGenerateSchedule).
 */
async function parseWithGemini(html: string, url: string): Promise<Partial<ParsedProduct> | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const pageText = stripHtmlToText(html, 8000);
    if (!pageText) return null;

    const prompt = `You are extracting product info from a retail/vendor web page for a remodeling contractor's product library.

PAGE URL: ${url}
PAGE TEXT (stripped of HTML):
${pageText}

Return ONLY strict JSON with this exact shape, no other text:
{"name": string|null, "price": number|null, "imageUrl": string|null, "vendor": string|null, "description": string|null}

Rules:
- "name" is the product's title/name. If you cannot identify a specific product, use null.
- "price" is the numeric list price with no currency symbol (e.g. 129.99). Use null if not found.
- "imageUrl" is the product's main image URL if visible in the text, otherwise null.
- "vendor" is the store/brand name, otherwise null.
- "description" is a one-sentence product description, otherwise null.`;

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
                }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            },
        );
        if (!res.ok) return null;
        const data = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) return null;

        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== "object") return null;
        const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
        if (!name) return null;

        return {
            name,
            description: typeof parsed.description === "string" ? parsed.description : undefined,
            imageUrl: typeof parsed.imageUrl === "string" ? parsed.imageUrl : undefined,
            price: toNumberOrUndefined(parsed.price),
            vendor: typeof parsed.vendor === "string" ? parsed.vendor : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Parse a pasted product URL into structured data for the clipper / client
 * suggestion flows. Never throws — any failure at any stage degrades to
 * {vendorUrl, name: null} so the caller can fall back to manual entry.
 */
export async function parseProductUrl(url: string): Promise<ParsedProduct> {
    const fallback: ParsedProduct = { vendorUrl: url, name: null };

    const safe = await isSafeExternalUrl(url);
    if (!safe) return fallback;

    const html = await guardedFetchText(url);
    if (!html) return fallback;

    const jsonLd = parseJsonLdProduct(html);
    if (jsonLd?.name) {
        return { vendorUrl: url, name: jsonLd.name, description: jsonLd.description, price: jsonLd.price, imageUrl: jsonLd.imageUrl, vendor: jsonLd.vendor };
    }

    const og = parseOpenGraph(html);
    if (og?.name) {
        return { vendorUrl: url, name: og.name, description: og.description, price: og.price, imageUrl: og.imageUrl, vendor: og.vendor };
    }

    const gemini = await parseWithGemini(html, url);
    if (gemini?.name) {
        return { vendorUrl: url, name: gemini.name, description: gemini.description, price: gemini.price, imageUrl: gemini.imageUrl, vendor: gemini.vendor };
    }

    return fallback;
}
