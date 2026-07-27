import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { isHttpUrl } from "./url-safety";

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
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // ~2MB cap, cumulative across the whole redirect chain
const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set([80, 443]);
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// =============================================================================
// SSRF guard: IP range denylist + connect-time DNS validation
// =============================================================================
//
// Two layers, both required:
//   1. isSafeExternalUrl() — cheap SYNTACTIC pre-check (protocol, port, and the
//      one case it must resolve itself: a literal IP host, e.g. http://169.254.169.254/,
//      since Node's net.connect skips its `lookup` option entirely when the host
//      is already an IP literal — a custom lookup would simply never run for it).
//   2. The `lookup` option passed to http.request/https.request in fetchOneHop()
//      below — for hostname-based URLs, this is what actually gets called during
//      the real connect, and it validates every resolved address before handing
//      ONE of them back to Node to connect to. Because the validated address is
//      the exact address connected to (no second DNS resolution happens after),
//      this closes the DNS-rebinding window a check-then-fetch design would have
//      (resolve+validate at check time, then fetch() re-resolves at connect time
//      — an attacker's DNS server can answer differently the second time).

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return ((parts[0] * 16777216) + (parts[1] * 65536) + (parts[2] * 256) + parts[3]) >>> 0;
}

function inCidrInt(ipInt: number, base: string, prefixLen: number): boolean {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) return false;
    const mask = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
    return ((ipInt >>> 0) & mask) === (baseInt & mask);
}

// Every non-global IPv4 range: RFC1918 privates, loopback, link-local, CGNAT,
// the IANA special-purpose blocks (this-network, IETF protocol assignments,
// TEST-NET-1/2/3, 6to4 relay anycast, benchmarking), multicast, reserved, and
// the limited broadcast address.
const IPV4_BLOCKED_RANGES: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
    ["255.255.255.255", 32],
];

function isBlockedIPv4Int(ipInt: number): boolean {
    return IPV4_BLOCKED_RANGES.some(([base, len]) => inCidrInt(ipInt, base, len));
}

function isBlockedIPv4(ip: string): boolean {
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) return true; // fail closed
    return isBlockedIPv4Int(ipInt);
}

/**
 * Expand any valid IPv6 literal (including "::" compression and an embedded
 * trailing IPv4 like "::ffff:127.0.0.1") into a 128-bit integer for numeric
 * prefix comparisons. Returns null for anything that doesn't parse.
 */
function ipv6ToBigInt(ip: string): bigint | null {
    if (!net.isIPv6(ip)) return null;
    let head = ip;
    let tail = "";
    let hasDoubleColon = false;
    if (ip.includes("::")) {
        hasDoubleColon = true;
        const idx = ip.indexOf("::");
        head = ip.slice(0, idx);
        tail = ip.slice(idx + 2);
    }
    const expand = (s: string) => (s ? s.split(":") : []);
    let headParts = expand(head);
    let tailParts = expand(tail);

    function v4Embedded(parts: string[]): string[] {
        if (parts.length === 0) return parts;
        const last = parts[parts.length - 1];
        if (last.includes(".")) {
            const octets = last.split(".").map(Number);
            if (octets.length === 4 && octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
                const hi = ((octets[0] << 8) | octets[1]).toString(16);
                const lo = ((octets[2] << 8) | octets[3]).toString(16);
                return [...parts.slice(0, -1), hi, lo];
            }
        }
        return parts;
    }
    headParts = v4Embedded(headParts);
    tailParts = v4Embedded(tailParts);

    let allParts: string[];
    if (hasDoubleColon) {
        const missing = 8 - (headParts.length + tailParts.length);
        if (missing < 0) return null;
        allParts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
    } else {
        allParts = headParts;
    }
    if (allParts.length !== 8) return null;

    let result = BigInt(0);
    for (const part of allParts) {
        if (part === "") return null;
        const val = parseInt(part, 16);
        if (!Number.isInteger(val) || val < 0 || val > 0xFFFF) return null;
        result = (result << BigInt(16)) | BigInt(val);
    }
    return result;
}

function ipv6InCidr(ipBig: bigint, base: string, prefixLen: number): boolean {
    const baseBig = ipv6ToBigInt(base);
    if (baseBig === null) return false;
    const shift = BigInt(128 - prefixLen);
    const mask = prefixLen === 0 ? BigInt(0) : ((BigInt(1) << BigInt(prefixLen)) - BigInt(1)) << shift;
    return (ipBig & mask) === (baseBig & mask);
}

// fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (deprecated
// site-local), ff00::/8 (multicast), 2001:db8::/32 (documentation). :: and ::1
// are checked as exact values below; ::ffff:0:0/96 and 64:ff9b::/96 decode
// their embedded IPv4 and re-run the IPv4 check.
const IPV6_BLOCKED_RANGES: Array<[string, number]> = [
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
];

function isBlockedIPv6(ip: string): boolean {
    const big = ipv6ToBigInt(ip);
    if (big === null) return true; // fail closed
    if (big === BigInt(0)) return true; // ::
    if (big === BigInt(1)) return true; // ::1
    if (ipv6InCidr(big, "::ffff:0:0", 96) || ipv6InCidr(big, "64:ff9b::", 96)) {
        // IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) — the real
        // target is the embedded IPv4 address, so validate that instead.
        return isBlockedIPv4Int(Number(big & BigInt(0xFFFFFFFF)));
    }
    return IPV6_BLOCKED_RANGES.some(([base, len]) => ipv6InCidr(big, base, len));
}

function isBlockedIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 4) return isBlockedIPv4(ip);
    if (family === 6) return isBlockedIPv6(ip);
    return true; // not a valid IP literal — fail closed
}

/**
 * Syntactic SSRF pre-check: http/https only, port 80/443 only, and — because
 * Node's connection layer skips the custom `lookup` entirely for literal IP
 * hosts — validates a literal-IP host directly. Hostname-based URLs are NOT
 * resolved here; that happens once, at actual connect time, in fetchOneHop().
 */
export function isSafeExternalUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!parsed.hostname) return false;

    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
    if (!ALLOWED_PORTS.has(port)) return false;

    if (net.isIP(parsed.hostname) !== 0 && isBlockedIp(parsed.hostname)) return false;

    return true;
}

// =============================================================================
// Transport: node:http/https with a validating `lookup`, manual redirects
// =============================================================================

type NodeLookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/** dns.lookup-compatible function that rejects any resolved address in the
 * blocked ranges, and otherwise hands Node the exact address it validated —
 * that address is what Node actually connects to, so there's no window
 * between "validated" and "connected to" for a rebinding DNS server to exploit. */
function validatingLookup(hostname: string, options: unknown, callback: NodeLookupCallback): void {
    const cb: NodeLookupCallback = typeof options === "function" ? (options as NodeLookupCallback) : callback;
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) { cb(err, "", 4); return; }
        const list = addresses as dns.LookupAddress[];
        if (!list.length) { cb(new Error("DNS lookup returned no addresses"), "", 4); return; }
        const blocked = list.find((a) => isBlockedIp(a.address));
        if (blocked) { cb(new Error(`Resolved address ${blocked.address} is not allowed`), "", 4); return; }
        const chosen = list[0];
        cb(null, chosen.address, chosen.family);
    });
}

type HopResult =
    | { kind: "redirect"; location: string }
    | { kind: "body"; text: string }
    | { kind: "fail" };

function fetchOneHop(url: string, deadline: number): Promise<HopResult> {
    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            resolve({ kind: "fail" });
            return;
        }

        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) { resolve({ kind: "fail" }); return; }

        const transport = parsed.protocol === "https:" ? https : http;
        const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);

        let settled = false;
        const settle = (result: HopResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const req = transport.request(
            {
                hostname: parsed.hostname,
                port,
                path: `${parsed.pathname}${parsed.search}`,
                method: "GET",
                // Validated at actual connect time — see validatingLookup() above.
                lookup: validatingLookup as unknown as typeof dns.lookup,
                headers: {
                    "User-Agent": BROWSER_USER_AGENT,
                    Accept: "text/html,application/xhtml+xml",
                },
                timeout: timeLeft,
            },
            (res) => {
                const status = res.statusCode || 0;
                const location = res.headers.location;

                if (status >= 300 && status < 400 && location) {
                    // Drain nothing — destroy immediately so a huge redirect body
                    // can never be used to bypass the response-size cap.
                    res.destroy();
                    settle({ kind: "redirect", location });
                    return;
                }

                if (status < 200 || status >= 300) {
                    res.destroy();
                    settle({ kind: "fail" });
                    return;
                }

                const contentLengthHeader = res.headers["content-length"];
                if (contentLengthHeader && Number(contentLengthHeader) > MAX_RESPONSE_BYTES) {
                    res.destroy();
                    settle({ kind: "fail" });
                    return;
                }

                const chunks: Buffer[] = [];
                let total = 0;
                res.on("data", (chunk: Buffer) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        res.destroy();
                        settle({ kind: "fail" });
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => settle({ kind: "body", text: Buffer.concat(chunks).toString("utf8") }));
                res.on("error", () => settle({ kind: "fail" }));
            },
        );

        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => settle({ kind: "fail" }));
        req.end();
    });
}

/**
 * Fetch a URL with a hard timeout (shared across the whole redirect chain) and
 * a cumulative response-size cap, following redirects MANUALLY. Every hop's
 * URL — the initial one and every Location target, resolved against the
 * current URL — is re-validated via isSafeExternalUrl() before it's requested,
 * and the actual connect for hostname-based hops is validated by
 * validatingLookup() above (see the SSRF guard section for why both layers
 * exist). Capped at MAX_REDIRECTS hops.
 *
 * Returns null on any failure (timeout, unsafe target, too many redirects,
 * non-2xx, oversized body, network error) — never throws.
 */
async function guardedFetchText(url: string): Promise<string | null> {
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
    let currentUrl = url;

    for (let redirects = 0; ; redirects++) {
        if (!isSafeExternalUrl(currentUrl)) return null;
        if (Date.now() >= deadline) return null;

        const result = await fetchOneHop(currentUrl, deadline);
        if (result.kind === "fail") return null;
        if (result.kind === "redirect") {
            if (redirects >= MAX_REDIRECTS) return null;
            try {
                currentUrl = new URL(result.location, currentUrl).toString();
            } catch {
                return null;
            }
            continue;
        }
        return result.text;
    }
}

// =============================================================================
// Extraction: JSON-LD -> OpenGraph -> Gemini, all normalized by one function
// =============================================================================

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

// Unclamped, unvalidated extraction result — normalizeParsedProduct() below is
// the single place that enforces length limits, price bounds, image-URL safety,
// and currency handling for every extraction path.
type RawExtract = {
    name?: string;
    description?: string;
    imageUrl?: string;
    price?: number;
    priceCurrency?: string;
    vendor?: string;
};

const MAX_NAME_LEN = 200;
const MAX_VENDOR_LEN = 100;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_PRICE = 9_999_999.99;

/**
 * Single normalization point for every extraction path (JSON-LD, OpenGraph,
 * Gemini). Clamps string lengths, rejects a non-finite/out-of-range price,
 * drops an imageUrl that isn't a plain http(s) URL (never persist/return a
 * javascript:/data: URL pulled from a scraped page), and — if the page quoted
 * a non-USD price — nulls the price and folds the original amount/currency
 * into the description instead (no schema change for a currency field).
 * Returns null if there's no usable name.
 */
function normalizeParsedProduct(raw: RawExtract): Omit<ParsedProduct, "vendorUrl"> | null {
    const name = raw.name?.trim().slice(0, MAX_NAME_LEN);
    if (!name) return null;

    let description = raw.description?.trim().slice(0, MAX_DESCRIPTION_LEN) || undefined;
    const vendor = raw.vendor?.trim().slice(0, MAX_VENDOR_LEN) || undefined;
    const imageUrl = raw.imageUrl && isHttpUrl(raw.imageUrl) ? raw.imageUrl : undefined;

    const rawPrice =
        typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price > 0 && raw.price <= MAX_PRICE
            ? raw.price
            : undefined;

    let price: number | undefined = rawPrice;
    const currency = raw.priceCurrency?.trim().toUpperCase();
    if (rawPrice !== undefined && currency && currency !== "USD") {
        price = undefined;
        const note = `Listed price: ${rawPrice} ${currency}`;
        description = description ? `${description}\n${note}` : note;
        description = description.slice(0, MAX_DESCRIPTION_LEN);
    }

    return { name, description, imageUrl, price, vendor };
}

/**
 * Extract a schema.org/Product from any JSON-LD <script> blocks on the page.
 * Handles both a bare Product object and an @graph array containing one.
 */
function parseJsonLdProduct(html: string): RawExtract | null {
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
                    priceCurrency: firstString(offer?.priceCurrency),
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

function parseOpenGraph(html: string): RawExtract | null {
    const title = extractMetaContent(html, "property", "og:title");
    const image = extractMetaContent(html, "property", "og:image");
    const priceAmount = extractMetaContent(html, "property", "product:price:amount");
    const priceCurrency = extractMetaContent(html, "property", "product:price:currency");
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
        priceCurrency,
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
async function parseWithGemini(html: string, url: string): Promise<RawExtract | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const pageText = stripHtmlToText(html, 8000);
    if (!pageText) return null;

    const prompt = `You are extracting product info from a retail/vendor web page for a remodeling contractor's product library.

PAGE URL: ${url}
PAGE TEXT (stripped of HTML):
${pageText}

Return ONLY strict JSON with this exact shape, no other text:
{"name": string|null, "price": number|null, "currency": string|null, "imageUrl": string|null, "vendor": string|null, "description": string|null}

Rules:
- "name" is the product's title/name. If you cannot identify a specific product, use null.
- "price" is the numeric list price with no currency symbol (e.g. 129.99). Use null if not found.
- "currency" is the ISO 4217 currency code (e.g. "USD", "EUR", "GBP") the price is listed in. Assume "USD" for a bare $ sign. Use null if you can't tell.
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
            priceCurrency: typeof parsed.currency === "string" ? parsed.currency : undefined,
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

    if (!isSafeExternalUrl(url)) return fallback;

    const html = await guardedFetchText(url);
    if (!html) return fallback;

    const jsonLd = normalizeParsedProduct(parseJsonLdProduct(html) || {});
    if (jsonLd) return { vendorUrl: url, ...jsonLd };

    const og = normalizeParsedProduct(parseOpenGraph(html) || {});
    if (og) return { vendorUrl: url, ...og };

    const gemini = normalizeParsedProduct((await parseWithGemini(html, url)) || {});
    if (gemini) return { vendorUrl: url, ...gemini };

    return fallback;
}
