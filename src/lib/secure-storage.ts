import { getSupabase, STORAGE_BUCKET } from "./supabase";

/**
 * Private bucket for documents that carry legal or PII weight: e-signatures, executed
 * contract PDFs, signed estimate PDFs, and client tax-exemption certificates.
 *
 * `project-files` stays PUBLIC and keeps serving everything else (job photos, letterhead,
 * takeoffs, room exports, general project files). Supabase's public flag is per-bucket,
 * so separating the sensitive documents is the only way to make them private without
 * breaking every other read path.
 *
 * Stored DB values are bucket-qualified so a row is never ambiguous mid-migration:
 *
 *   secure:signatures/contracts/<id>/client/<ts>_<uuid>.png   → private bucket, signed URL
 *   https://<ref>.supabase.co/storage/v1/object/public/...    → legacy public URL
 *   projects/<id>/signed/<ts>_Signed_Estimate.pdf             → legacy bare path (public bucket)
 *   data:image/png;base64,...                                 → legacy inline signature
 *
 * Every read path goes through resolveDocUrl() (browser) or downloadDocBytes() (server),
 * both of which accept all four shapes. Nothing else should touch these buckets directly.
 */
export const SECURE_BUCKET = "secure-docs";
export const SECURE_SCHEME = "secure:";

/** Signed-URL lifetime for browser rendering. Long enough to load a page, short enough
 *  that a leaked URL (referrer, shared screenshot, proxy log) expires quickly. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 600;

export function toSecureRef(storagePath: string): string {
    return `${SECURE_SCHEME}${storagePath}`;
}

export function isSecureRef(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(SECURE_SCHEME);
}

/** Storage path inside SECURE_BUCKET, or null when `value` is not a secure ref. */
export function secureRefPath(value: string | null | undefined): string | null {
    if (!isSecureRef(value)) return null;
    const path = (value as string).slice(SECURE_SCHEME.length);
    // Defence in depth: refuse traversal and absolute paths.
    if (!path || path.startsWith("/") || path.includes("..")) return null;
    return path;
}

function isDataUrl(value: string): boolean {
    return value.startsWith("data:");
}

/**
 * Parse one of OUR OWN Supabase storage object URLs into (bucket, path).
 *
 * This is the SSRF boundary for legacy absolute URLs read out of the database: a stored
 * URL must never be able to point the server at an arbitrary host (cloud metadata, an
 * internal service). Returns null for anything that is not an object URL in our own
 * Supabase project, so callers can refuse rather than fetch.
 */
export function parseOwnStorageUrl(
    value: string,
): { bucket: string; path: string } | null {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:") return null;
        if (
            !parsed.hostname.endsWith(".supabase.co") &&
            !parsed.hostname.endsWith(".supabase.in")
        ) {
            return null;
        }
        // Must be EXACTLY our own project host. A prefix check is not sufficient:
        // `<ourref>.evil.supabase.co` satisfies both the suffix and prefix tests while
        // belonging to someone else. With no SUPABASE_URL there is no storage client to
        // download with anyway, so refuse rather than guess.
        const supabaseUrl = process.env.SUPABASE_URL || "";
        if (!supabaseUrl) return null;
        let ourHost: string;
        try {
            ourHost = new URL(supabaseUrl).hostname.toLowerCase();
        } catch {
            return null;
        }
        if (parsed.hostname.toLowerCase() !== ourHost) return null;
        const prefixes = ["/storage/v1/object/public/", "/storage/v1/object/sign/"];
        const prefix = prefixes.find((p) => parsed.pathname.startsWith(p));
        if (!prefix) return null;
        const rest = parsed.pathname.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash <= 0) return null;
        const bucket = rest.slice(0, slash);
        const path = decodeURIComponent(rest.slice(slash + 1));
        if (!path || path.includes("..")) return null;
        return { bucket, path };
    } catch {
        return null;
    }
}

/**
 * Turn a stored document reference into something a browser can load.
 *
 * - secure ref      → short-lived signed URL against the private bucket
 * - data: URL       → returned unchanged (legacy inline signatures still render)
 * - absolute URL    → returned unchanged (legacy public-bucket object, still served)
 * - bare path       → resolved against the legacy public bucket
 *
 * Never throws; returns null when the reference cannot be resolved, so a missing
 * signature renders as "no signature" rather than taking a page down.
 */
export async function resolveDocUrl(
    stored: string | null | undefined,
    ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string | null> {
    if (!stored) return null;

    const securePath = secureRefPath(stored);
    if (securePath) {
        const supabase = getSupabase();
        if (!supabase) return null;
        try {
            const { data, error } = await supabase.storage
                .from(SECURE_BUCKET)
                .createSignedUrl(securePath, ttlSeconds);
            if (error) {
                console.error("[secure-storage] signed URL failed", {
                    operation: "createSignedUrl",
                    message: error.message,
                });
                return null;
            }
            return data?.signedUrl ?? null;
        } catch (error) {
            console.error("[secure-storage] signed URL threw", {
                operation: "createSignedUrl",
                errorType: error instanceof Error ? error.name : typeof error,
            });
            return null;
        }
    }

    if (isDataUrl(stored)) return stored;

    if (/^https?:\/\//i.test(stored)) {
        // Legacy public-bucket object. Still readable until the originals are purged.
        return stored;
    }

    // Legacy bare storage path against the public bucket.
    const supabase = getSupabase();
    if (!supabase) return null;
    try {
        const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(stored);
        return data?.publicUrl ?? null;
    } catch {
        return null;
    }
}

/** Resolve several references at once, preserving key order. */
export async function resolveDocUrls<K extends string>(
    entries: Record<K, string | null | undefined>,
    ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<Record<K, string | null>> {
    const keys = Object.keys(entries) as K[];
    const resolved = await Promise.all(
        keys.map((key) => resolveDocUrl(entries[key], ttlSeconds)),
    );
    return keys.reduce(
        (acc, key, index) => {
            acc[key] = resolved[index];
            return acc;
        },
        {} as Record<K, string | null>,
    );
}

/**
 * Why a download did not produce bytes.
 *
 * `downloadDocBytes` collapses every failure to `null`, which is fine for a PDF
 * that renders without a signature but NOT for a money path: "the object is
 * gone" and "Supabase was briefly unreachable" demand opposite responses. The
 * first is terminal (a human must re-upload); the second must be retried, and
 * treating it as terminal would park good receipts during a storage blip.
 *
 * `not-found` is only ever returned when storage AFFIRMATIVELY said the object
 * is missing. Anything ambiguous — a network error, a 5xx, no configured
 * client — is `transient`, because guessing "gone" on incomplete evidence is
 * the failure mode that loses documents.
 */
export type DocBytesResult =
    | { ok: true; bytes: Buffer }
    | { ok: false; kind: "not-found" }
    | { ok: false; kind: "transient"; message: string };

/**
 * Storage's shapes for "this key does not exist", and ONLY those.
 *
 * `status === 400` used to count as not-found, which is badly wrong: Supabase
 * returns 400 for a malformed request, a bad JWT, an expired service key, and
 * assorted config faults. Any of those made the caller conclude the receipt was
 * GONE — a terminal verdict that parks the row and RELEASES its dedup key — when
 * the object was sitting there untouched. A rotated key would have emptied the
 * queue into review and unlocked every key on the way out.
 *
 * So: an affirmative 404, or an explicit not-found error code. Everything else,
 * including every other 4xx, is transient/config and retries.
 */
const NOT_FOUND_CODES = new Set(["nosuchkey", "not_found", "object_not_found", "entitynotfound"]);

export function isNotFoundError(
    error: { message?: string; status?: number; statusCode?: string | number; error?: string } | null,
): boolean {
    if (!error) return false;
    if (Number(error.status ?? error.statusCode) === 404) return true;
    const code = String(error.error ?? "").toLowerCase().replace(/[\s-]/g, "_");
    if (NOT_FOUND_CODES.has(code)) return true;
    const message = String(error.message ?? "").toLowerCase();
    // Exact phrases only — a substring like "not found" inside some other
    // sentence is not evidence of absence.
    return message === "object not found" || message === "the resource was not found";
}

/**
 * Tagged download. Same resolution rules as downloadDocBytes (secure ref, data
 * URL, our own storage URL, legacy bare path) but the caller is told WHY it
 * failed. Use this on any path where a missing file changes what happens to
 * real money.
 */
export async function downloadDocBytesResult(
    stored: string | null | undefined,
): Promise<DocBytesResult> {
    if (!stored) return { ok: false, kind: "not-found" };

    if (isDataUrl(stored)) {
        const bytes = await downloadDocBytes(stored);
        return bytes ? { ok: true, bytes } : { ok: false, kind: "not-found" };
    }

    let bucket: string;
    let path: string;

    const securePath = secureRefPath(stored);
    if (securePath) {
        bucket = SECURE_BUCKET;
        path = securePath;
    } else if (/^https?:\/\//i.test(stored)) {
        const parsed = parseOwnStorageUrl(stored);
        // Not ours, or naming a bucket we never write absolute URLs for. That is
        // a REFUSAL, not a transient failure — retrying cannot make it ours.
        if (!parsed || parsed.bucket !== STORAGE_BUCKET) return { ok: false, kind: "not-found" };
        bucket = parsed.bucket;
        path = parsed.path;
    } else {
        if (stored.startsWith("/") || stored.includes("..")) return { ok: false, kind: "not-found" };
        bucket = STORAGE_BUCKET;
        path = stored;
    }

    const supabase = getSupabase();
    // No client is a CONFIGURATION fault, not a missing object. Retry it.
    if (!supabase) return { ok: false, kind: "transient", message: "storage-not-configured" };
    try {
        const { data, error } = await supabase.storage.from(bucket).download(path);
        if (error) {
            return isNotFoundError(error as { message?: string; status?: number })
                ? { ok: false, kind: "not-found" }
                : { ok: false, kind: "transient", message: String(error.message ?? "download-failed").slice(0, 200) };
        }
        if (!data) return { ok: false, kind: "not-found" };
        return { ok: true, bytes: Buffer.from(await data.arrayBuffer()) };
    } catch (error) {
        // A throw is a transport fault every time — never evidence of absence.
        return {
            ok: false,
            kind: "transient",
            message: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "download-threw",
        };
    }
}

/** True only when storage affirmatively confirms the object is there. */
export async function secureObjectExists(storagePath: string): Promise<boolean> {
    const result = await downloadDocBytesResult(toSecureRef(storagePath));
    return result.ok;
}

/**
 * Read a stored document's bytes server-side using the service key.
 *
 * Server-side consumers (PDF generation, Drive mirroring) must use this rather than
 * fetch()ing a URL: it works against the private bucket, and it removes the SSRF surface
 * entirely for migrated rows because no URL is ever dereferenced. Legacy absolute URLs
 * are downloaded via the storage API after parseOwnStorageUrl() confirms they belong to
 * us — an untrusted host is refused, not fetched.
 */
export async function downloadDocBytes(
    stored: string | null | undefined,
): Promise<Buffer | null> {
    if (!stored) return null;

    if (isDataUrl(stored)) {
        const comma = stored.indexOf(",");
        if (comma < 0) return null;
        const meta = stored.slice(0, comma);
        if (!meta.includes(";base64")) return null;
        try {
            const buffer = Buffer.from(stored.slice(comma + 1), "base64");
            return buffer.length > 0 ? buffer : null;
        } catch {
            return null;
        }
    }

    let bucket: string;
    let path: string;

    const securePath = secureRefPath(stored);
    if (securePath) {
        bucket = SECURE_BUCKET;
        path = securePath;
    } else if (/^https?:\/\//i.test(stored)) {
        const parsed = parseOwnStorageUrl(stored);
        if (!parsed) return null; // not ours — refuse
        // An absolute URL is only ever a LEGACY public-bucket object. Private documents are
        // always referenced by a `secure:` ref, so a stored URL naming any other bucket
        // (notably SECURE_BUCKET) is not something we should dereference on its word.
        if (parsed.bucket !== STORAGE_BUCKET) return null;
        bucket = parsed.bucket;
        path = parsed.path;
    } else {
        if (stored.startsWith("/") || stored.includes("..")) return null;
        bucket = STORAGE_BUCKET;
        path = stored;
    }

    const supabase = getSupabase();
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.storage.from(bucket).download(path);
        if (error || !data) return null;
        return Buffer.from(await data.arrayBuffer());
    } catch (error) {
        console.error("[secure-storage] download failed", {
            operation: "download",
            errorType: error instanceof Error ? error.name : typeof error,
        });
        return null;
    }
}

/**
 * Upload a sensitive document to the private bucket and return its stored reference.
 * Throws on failure so callers can compensate (they own the surrounding transaction).
 */
export async function uploadSecureDoc(
    storagePath: string,
    body: Buffer,
    contentType: string,
): Promise<string> {
    const supabase = getSupabase();
    if (!supabase) throw new Error("Secure document storage is not configured.");
    const { error } = await supabase.storage
        .from(SECURE_BUCKET)
        .upload(storagePath, body, { contentType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return toSecureRef(storagePath);
}

/** Best-effort removal of a secure object, for compensating a failed DB write. */
export async function removeSecureDoc(ref: string): Promise<void> {
    const path = secureRefPath(ref);
    if (!path) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const { error } = await supabase.storage.from(SECURE_BUCKET).remove([path]);
    if (error) throw error;
}
