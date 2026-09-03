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
import type { SupabaseClient } from "@supabase/supabase-js";
// Only the SIGNAL-BOUND factory: the unsignalled singleton is what let a hung
// request eat an invocation, so this file must not be able to reach for it.
import { getSupabaseWithSignal } from "@/lib/supabase";
import { remainingBudgetMs, type RouteDeadline } from "@/lib/quickbooks";
import { isNotFoundError, type DocBytesResult } from "@/lib/secure-storage";
import { ACCEPTED_MIME_TYPES } from "./file-type";
import { MAX_STORED_BYTES } from "./intake-core";

export const RECEIPT_BUCKET = "receipt-intake";

/**
 * NO STORAGE CALL MAY OUTLIVE THE INVOCATION THAT MADE IT.
 *
 * Every function in this file used to `await` Supabase with no timeout and no
 * abort signal, and the worker's own `shouldStop` only runs BETWEEN operations.
 * So a single hung request ate the whole 60-second lifetime: the platform
 * killed the function mid-pass, the rows it had claimed never reached the
 * release path, and they sat leased for ten minutes — and because the same
 * object headed the queue next time, the same request hung the next run too.
 * One stalled object could stall the pipeline indefinitely.
 *
 * Two mechanisms, because either alone is not enough:
 *   - an AbortSignal threaded into the client's fetch, so the request is
 *     genuinely cancelled rather than left running;
 *   - a timer that settles the promise, because an abort that the client
 *     swallows would otherwise still hang the await.
 *
 * The budget is derived from the caller's RouteDeadline, so a call late in a
 * pass gets only what is actually left rather than a fresh fixed timeout that
 * could straddle the platform ceiling. With no deadline (tests, scripts) the
 * default applies.
 */
export const STORAGE_CALL_MAX_MS = 15_000;
/** Below this there is no point starting a storage call at all. */
export const STORAGE_CALL_MIN_MS = 500;

/** Tag for a call that ran out of budget. Callers map it to their transient path. */
export const STORAGE_TIMEOUT_MESSAGE = "storage-timeout";

export class StorageTimeoutError extends Error {
    name = "StorageTimeoutError";
    constructor(op: string) {
        super(`${STORAGE_TIMEOUT_MESSAGE}:${op}`);
    }
}

/** Name-based, like every other error guard here — see CLAUDE.md. */
export function isStorageTimeout(error: unknown): boolean {
    return error instanceof Error && error.name === "StorageTimeoutError";
}

export function storageBudgetMs(deadline?: RouteDeadline): number {
    const left = remainingBudgetMs(deadline);
    if (!Number.isFinite(left)) return STORAGE_CALL_MAX_MS;
    return Math.min(STORAGE_CALL_MAX_MS, Math.max(0, Math.floor(left)));
}

/**
 * Run one storage operation under the budget, with a client whose fetch it can
 * abort. `run` receives the client so the operation is built INSIDE the guard —
 * building it outside would bind it to the unsignalled singleton.
 */
async function withStorageDeadline<T>(
    op: string,
    deadline: RouteDeadline | undefined,
    run: (client: SupabaseClient) => Promise<T>,
): Promise<T> {
    const budget = storageBudgetMs(deadline);
    // Starting a call with no runway left is how a pass spends its last
    // milliseconds on a request whose answer it can never use.
    if (budget < STORAGE_CALL_MIN_MS) throw new StorageTimeoutError(op);

    const controller = new AbortController();
    const client = getSupabaseWithSignal(controller.signal);
    if (!client) throw new Error("receipt storage is not configured");

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(client),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    // Abort FIRST, so the socket goes with the promise.
                    controller.abort();
                    reject(new StorageTimeoutError(op));
                }, budget);
            }),
        ]);
    } finally {
        // Never leave a pending timer holding the event loop open.
        if (timer) clearTimeout(timer);
    }
}

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
    deadline: RouteDeadline | undefined,
): Promise<SizeResult> {
    const path = safePath(storagePath);
    if (!path) return { ok: false, kind: "missing" };
    const slash = path.lastIndexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const name = slash > 0 ? path.slice(slash + 1) : path;
    try {
        const { data, error } = lister
            ? await lister.list(dir, { search: name, limit: 100 })
            : await withStorageDeadline("list", deadline, client =>
                client.storage.from(RECEIPT_BUCKET).list(dir, { search: name, limit: 100 }));
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
export async function downloadReceiptObject(
    storagePath: string,
    deadline: RouteDeadline | undefined,
): Promise<DocBytesResult> {
    const path = safePath(storagePath);
    if (!path) return { ok: false, kind: "not-found" };
    try {
        const { data, error } = await withStorageDeadline("download", deadline, client =>
            client.storage.from(RECEIPT_BUCKET).download(path));
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
    opts: { upsert?: boolean; deadline: RouteDeadline | undefined },
): Promise<boolean> {
    const path = safePath(storagePath);
    if (!path) return false;
    try {
        const { error } = await withStorageDeadline("upload", opts.deadline, client =>
            client.storage
                .from(RECEIPT_BUCKET)
                .upload(path, bytes, { contentType, upsert: opts.upsert ?? false }));
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
export async function removeReceiptObject(
    storagePath: string,
    deadline: RouteDeadline | undefined,
): Promise<void> {
    const path = safePath(storagePath);
    if (!path) throw new Error(`not a receipt object path: ${String(storagePath).slice(0, 80)}`);
    // Never a silent success: the cleanup queue would mark an orphan resolved on
    // a misconfigured deployment and lose it permanently. withStorageDeadline
    // throws for a missing client and for a timeout alike, which is what this
    // caller wants — both mean "not confirmed removed".
    const { error } = await withStorageDeadline("remove", deadline, client =>
        client.storage.from(RECEIPT_BUCKET).remove([path]));
    if (error) throw error;
}

/**
 * The signed URL a client PUTs its bytes to. Scoped to ONE path, by design.
 *
 * `upsert` IS OPT-IN, and the default is off.
 *
 * The option is a real capability difference, not a convenience: an
 * upsert-capable token can OVERWRITE whatever is at the path for as long as it
 * is valid, which outlives the row it was issued for. A token issued for a
 * freshly-named path (every path is `id + leaseVersion + ext`, and every
 * destructive /start branch bumps the version before it signs) can only ever
 * create, so it does not need the stronger capability and must not be handed
 * it. The ONE caller that does is `reuseLiveLease`: it re-signs an EXISTING
 * path so a client can replace its own partial upload, and without upsert that
 * second PUT fails "The resource already exists" and the row can never be
 * finalized. `createSignedUploadUrl(path, { upsert })` is storage-js's own
 * option (@supabase/storage-js 2.99: `createSignedUploadUrl(path, options?: {
 * upsert: boolean })`), defaulting to false — the sha checks in /finalize are
 * what stop even the upsert token from binding a DIFFERENT document to this
 * identity.
 */
export async function createReceiptUploadUrl(
    storagePath: string,
    opts: { upsert?: boolean; deadline: RouteDeadline | undefined },
): Promise<{ uploadUrl: string; token: string; storagePath: string } | null> {
    const path = safePath(storagePath);
    if (!path) return null;
    try {
        const { data, error } = await withStorageDeadline("sign-upload", opts.deadline, client =>
            client.storage
                .from(RECEIPT_BUCKET)
                .createSignedUploadUrl(path, { upsert: opts.upsert ?? false }));
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
    deadline: RouteDeadline | undefined,
): Promise<string | null> {
    const path = safePath(storagePath);
    if (!path) return null;
    try {
        const { data, error } = await withStorageDeadline("sign-download", deadline, client =>
            client.storage
                .from(RECEIPT_BUCKET)
                .createSignedUrl(path, ttlSeconds));
        return error || !data ? null : data.signedUrl;
    } catch {
        return null;
    }
}
