/**
 * The intake feature's OWN private bucket.
 *
 * Intake objects used to live in `secure-docs` alongside signed contracts,
 * e-signatures and invoice PDFs. Three reasons that was wrong, and all of them
 * are about blast radius rather than tidiness:
 *
 *  1. The size and MIME ceilings are set PER BUCKET in Supabase, and the
 *     two-step upload goes straight to a signed URL that never passes through
 *     this server — so the bucket is the only place a 400 MB write or an
 *     executable can actually be refused. `secure-docs` cannot carry a receipt
 *     policy without imposing it on every other document type.
 *  2. A signed upload URL is a write capability. Issuing one against the bucket
 *     that also holds countersigned contracts means a path-handling bug in the
 *     intake code is a write into the contract store.
 *  3. Cleanup deletes objects. The orphan sweep runs unattended against paths
 *     read out of an event log; it must not be able to reach anything but
 *     receipts.
 *
 * Everything intake does with storage goes through this module, so there is one
 * place that names the bucket and one place to audit.
 */
import { getSupabase } from "@/lib/supabase";
import { isNotFoundError, type DocBytesResult } from "@/lib/secure-storage";
import { ACCEPTED_MIME_TYPES } from "./file-type";
import { MAX_STORED_BYTES } from "./intake-core";

export const RECEIPT_BUCKET = "receipt-intake";

/**
 * The bucket policy, exported so scripts/apply-receipt-intake.mjs and this code
 * cannot disagree about what was provisioned.
 */
export const RECEIPT_BUCKET_POLICY = {
    name: RECEIPT_BUCKET,
    public: false,
    fileSizeLimit: MAX_STORED_BYTES,
    allowedMimeTypes: ACCEPTED_MIME_TYPES,
} as const;

/** A human-readable reference for logs and QBO memos. Never dereferenced. */
export function receiptObjectRef(storagePath: string): string {
    return `${RECEIPT_BUCKET}:${storagePath}`;
}

/** A path we are willing to touch: inside the bucket, no traversal, no absolutes. */
function safePath(storagePath: string): string | null {
    if (!storagePath || storagePath.startsWith("/") || storagePath.includes("..")) return null;
    return storagePath;
}

export type SizeResult =
    | { ok: true; size: number }
    | { ok: false; kind: "missing" | "transient"; message?: string };

/**
 * Byte size from METADATA — never a download.
 *
 * `list` with a search returns the metadata row in one small request whatever
 * the object weighs, which is the only way to refuse a 400 MB upload without
 * first pulling it into this process.
 *
 * TAGGED, and an unknown size is TRANSIENT rather than "fine, carry on". The
 * previous null-means-unknown contract meant a storage hiccup, a missing
 * client, or an API without metadata all fell through to the download — which
 * is precisely the thing this call exists to avoid, on precisely the objects we
 * know least about.
 */
export interface BucketLister {
    list(
        dir: string,
        opts: { search: string; limit: number },
    ): Promise<{
        data: Array<{ name: string; metadata?: unknown }> | null;
        error: { message?: string; status?: number; statusCode?: string | number; error?: string } | null;
    }>;
}

export async function receiptObjectSize(
    storagePath: string,
    /** Injected only by tests: the classification is the whole subject here. */
    lister: BucketLister | null = null,
): Promise<SizeResult> {
    const path = safePath(storagePath);
    if (!path) return { ok: false, kind: "missing" };
    const from = lister ?? getSupabase()?.storage.from(RECEIPT_BUCKET) ?? null;
    // No client is a CONFIGURATION fault, not an absent object. Saying "missing"
    // here is what let a misconfigured deployment re-upload over a document that
    // was really there.
    if (!from) return { ok: false, kind: "transient", message: "storage-not-configured" };
    const slash = path.lastIndexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const name = slash > 0 ? path.slice(slash + 1) : path;
    try {
        const { data, error } = await from.list(dir, { search: name, limit: 100 });
        if (error) {
            return isNotFoundError(error as { message?: string; status?: number })
                ? { ok: false, kind: "missing" }
                : { ok: false, kind: "transient", message: String(error.message ?? "list-failed").slice(0, 200) };
        }
        const match = data?.find(entry => entry.name === name);
        // An empty listing IS an answer: the object is not there.
        if (!match) return { ok: false, kind: "missing" };
        const size = (match.metadata as { size?: unknown } | undefined)?.size;
        return typeof size === "number" && Number.isFinite(size)
            ? { ok: true, size }
            // Present but sizeless: the one case where we genuinely do not know,
            // and it must not become permission to download.
            : { ok: false, kind: "transient", message: "size-unavailable" };
    } catch (error) {
        return {
            ok: false,
            kind: "transient",
            message: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "list-threw",
        };
    }
}

/** Tagged download, so a confirmed 404 and a storage blip cannot book the same. */
export async function downloadReceiptObject(storagePath: string): Promise<DocBytesResult> {
    const path = safePath(storagePath);
    if (!path) return { ok: false, kind: "not-found" };
    const supabase = getSupabase();
    if (!supabase) return { ok: false, kind: "transient", message: "storage-not-configured" };
    try {
        const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).download(path);
        if (error) {
            return isNotFoundError(error as { message?: string; status?: number })
                ? { ok: false, kind: "not-found" }
                : { ok: false, kind: "transient", message: String(error.message ?? "download-failed").slice(0, 200) };
        }
        if (!data) return { ok: false, kind: "not-found" };
        return { ok: true, bytes: Buffer.from(await data.arrayBuffer()) };
    } catch (error) {
        return {
            ok: false,
            kind: "transient",
            message: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "download-threw",
        };
    }
}

/** Write bytes we have already validated. Returns false on any storage fault. */
export async function uploadReceiptObject(
    storagePath: string,
    bytes: Buffer,
    contentType: string,
    opts: { upsert?: boolean } = {},
): Promise<boolean> {
    const path = safePath(storagePath);
    if (!path) return false;
    const supabase = getSupabase();
    if (!supabase) return false;
    try {
        const { error } = await supabase.storage
            .from(RECEIPT_BUCKET)
            .upload(path, bytes, { contentType, upsert: opts.upsert ?? false });
        if (error) {
            console.error("[receipts/intake] upload failed", error.message);
            return false;
        }
        return true;
    } catch (error) {
        console.error("[receipts/intake] upload threw", error instanceof Error ? error.name : "error");
        return false;
    }
}

/** Delete, and THROW on anything short of a confirmed removal. */
export async function removeReceiptObject(storagePath: string): Promise<void> {
    const path = safePath(storagePath);
    if (!path) throw new Error(`not a receipt object path: ${String(storagePath).slice(0, 80)}`);
    const supabase = getSupabase();
    // Never a silent success: the cleanup queue would mark an orphan resolved on
    // a misconfigured deployment and lose it permanently.
    if (!supabase) throw new Error("receipt storage is not configured");
    const { error } = await supabase.storage.from(RECEIPT_BUCKET).remove([path]);
    if (error) throw error;
}

/** The signed URL a client PUTs its bytes to. Scoped to ONE path, by design. */
export async function createReceiptUploadUrl(
    storagePath: string,
): Promise<{ uploadUrl: string; token: string; storagePath: string } | null> {
    const path = safePath(storagePath);
    if (!path) return null;
    const supabase = getSupabase();
    if (!supabase) return null;
    try {
        // upsert: a resumed /start for the SAME row must be able to replace a
        // partial upload at the same path.
        const { data, error } = await supabase.storage
            .from(RECEIPT_BUCKET)
            .createSignedUploadUrl(path, { upsert: true });
        if (error || !data) {
            console.error("[receipts/intake] sign failed", error?.message);
            return null;
        }
        return { uploadUrl: data.signedUrl, token: data.token, storagePath: path };
    } catch (error) {
        console.error("[receipts/intake] sign threw", error instanceof Error ? error.name : "error");
        return null;
    }
}

/** A time-limited read URL, for the archive mirror. */
export async function signReceiptDownloadUrl(
    storagePath: string,
    ttlSeconds: number,
): Promise<string | null> {
    const path = safePath(storagePath);
    if (!path) return null;
    const supabase = getSupabase();
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.storage
            .from(RECEIPT_BUCKET)
            .createSignedUrl(path, ttlSeconds);
        return error || !data ? null : data.signedUrl;
    } catch {
        return null;
    }
}
