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

/**
 * How many paths ride in one createSignedUrls request.
 *
 * The storage API takes a list and answers per item, so a page costs a request
 * per chunk instead of a request per row. A hundred matches the receipts
 * queue's own per-group page size, which keeps the request body small and makes
 * the worst case easy to state: five visible groups of a hundred rows is five
 * requests, not five hundred.
 */
export const RECEIPT_SIGN_CHUNK_SIZE = 100;

/**
 * The plural storage call, narrowed to what this module uses.
 *
 * Injected only by tests, the same way receiptObjectSize takes a BucketLister:
 * the batching and the per-item handling ARE the subject here, and neither is
 * observable through a client that has to be talked to over a socket.
 *
 * `signedUrl` is typed `string | null` deliberately. @supabase/storage-js 2.99
 * declares it `string`, but its own implementation writes
 * `datum.signedURL ? encodeURI(...) : null`, so an item that did not sign comes
 * back null at runtime and the declared type is a lie this file must not
 * believe.
 */
export interface BucketBatchSigner {
    createSignedUrls(
        paths: string[],
        ttlSeconds: number,
    ): Promise<{
        data: Array<{ path?: string | null; signedUrl?: string | null; error?: string | null }> | null;
        error: { message?: string; name?: string; status?: number; statusCode?: string | number } | null;
    }>;
}

/** The only fault words this module will ever log. */
export const SIGN_FAULT_TAGS = ["timeout", "storage-error", "threw", "per-item"] as const;

/**
 * A CATEGORY THIS CODE CHOSE, never text that came off the error.
 *
 * `name`, `message`, `status` and `statusCode` all arrive from a remote
 * service, so as far as this file is concerned they are arbitrary strings that
 * could carry a path, a signed URL or anything else an operator would then read
 * out of a log sink. So the tag is picked from a closed set, and the only thing
 * borrowed from the error at all is a status, and only when it is already a
 * plain integer in the HTTP range.
 *
 * Every read is guarded: the fault may be a Proxy or carry a throwing getter,
 * and the line that reports a failure must not be able to become one.
 */
function signFaultTag(fault: unknown, thrown: boolean): string {
    let tag: (typeof SIGN_FAULT_TAGS)[number] = thrown ? "threw" : "storage-error";
    let status: number | null = null;
    try {
        if (thrown && isStorageTimeout(fault)) tag = "timeout";
        if (fault && typeof fault === "object") {
            const shape = fault as { status?: unknown; statusCode?: unknown };
            for (const candidate of [shape.status, shape.statusCode]) {
                // NUMBERS only. A numeric-looking string is still a string off
                // the wire, and nothing off the wire is echoed.
                if (typeof candidate !== "number" || !Number.isInteger(candidate)) continue;
                if (candidate < 100 || candidate > 599) continue;
                status = candidate;
                break;
            }
        }
    } catch {
        // A hostile error object is simply a fault of the least specific kind.
    }
    return status === null ? tag : `${tag}/${status}`;
}

/**
 * One response item, read defensively.
 *
 * A null, a number, or an object whose getters throw is skipped ON ITS OWN:
 * reading it inside the chunk's loop would take every later item in the same
 * chunk down with it, and those are rows whose links would then silently
 * vanish.
 */
function signedPairFrom(item: unknown, asked: Set<string>): [string, string] | null {
    try {
        if (!item || typeof item !== "object") return null;
        const shape = item as { path?: unknown; signedUrl?: unknown; error?: unknown };
        if (shape.error) return null;
        const path = shape.path;
        const url = shape.signedUrl;
        if (typeof path !== "string" || typeof url !== "string" || !url) return null;
        // Matched against what this chunk actually asked for, so a surprising
        // response can never put a key in the map that no caller requested.
        return asked.has(path) ? [path, url] : null;
    } catch {
        return null;
    }
}

/** One batch request. Its own try/catch, so a failure never costs its siblings. */
async function signOneChunk(
    chunk: string[],
    ttlSeconds: number,
    deadline: RouteDeadline | undefined,
    signer: BucketBatchSigner | null,
    faults: Set<string>,
): Promise<Array<[string, string]>> {
    const asked = new Set(chunk);
    const pairs: Array<[string, string]> = [];
    try {
        const response = signer
            ? await signer.createSignedUrls(chunk, ttlSeconds)
            : await withStorageDeadline("sign-downloads", deadline, client =>
                client.storage.from(RECEIPT_BUCKET).createSignedUrls(chunk, ttlSeconds));
        const data = response?.data;
        // Array.isArray, not truthiness: a string or an object here would be
        // iterated as something it is not.
        if (response?.error || !Array.isArray(data)) {
            faults.add(signFaultTag(response?.error, false));
            return pairs;
        }
        for (const item of data) {
            const pair = signedPairFrom(item, asked);
            if (pair) pairs.push(pair);
        }
    } catch (error) {
        faults.add(signFaultTag(error, true));
    }
    return pairs;
}

/**
 * Sign MANY objects in as few round trips as possible.
 *
 * The single signer is the wrong shape for a list. One render of the receipts
 * queue is up to five groups of a hundred rows, and signing each row on its own
 * is five hundred requests AND five hundred Supabase clients on every load of a
 * force-dynamic page. Same rules as the single signer, applied per item: the
 * same safePath gate, an unsafe or empty path skipped rather than thrown, and a
 * path that did not sign simply absent from the map. Callers already render a
 * missing entry as "no link", so a partial answer costs one row instead of the
 * page.
 *
 * THE CHUNKS GO OUT TOGETHER. In series, each one would be handed its own fresh
 * allowance by withStorageDeadline, so a degraded storage day would cost the
 * caller the SUM of them, and the caller here is a page render. Concurrent, the
 * whole step costs one chunk's wait, and a caller that passes a deadline caps
 * even that.
 *
 * NEVER THROWS, literally: a bad input element, a hostile response, a fault
 * object that explodes when read, or a logger that fails all come back as a map
 * with fewer entries in it.
 */
export async function signReceiptDownloadUrls(
    storagePaths: readonly (string | null | undefined)[],
    ttlSeconds: number,
    deadline: RouteDeadline | undefined,
    signer: BucketBatchSigner | null = null,
): Promise<Map<string, string>> {
    const signed = new Map<string, string>();
    const faults = new Set<string>();
    let requested = 0;

    try {
        // Deduped in first-seen order: the same object can head more than one
        // group (a row and the duplicate parked against it), and asking twice
        // is a wasted slot in the chunk. A non-string element is skipped rather
        // than thrown over, because this list is built from database rows and
        // the contract above says never.
        const wanted: string[] = [];
        const seen = new Set<string>();
        for (const candidate of storagePaths ?? []) {
            if (typeof candidate !== "string" || !candidate || seen.has(candidate)) continue;
            seen.add(candidate);
            if (safePath(candidate)) wanted.push(candidate);
        }
        requested = wanted.length;
        if (requested === 0) return signed;

        const chunks: string[][] = [];
        for (let from = 0; from < wanted.length; from += RECEIPT_SIGN_CHUNK_SIZE) {
            chunks.push(wanted.slice(from, from + RECEIPT_SIGN_CHUNK_SIZE));
        }

        // Results come back in CHUNK order however the answers arrive, so the
        // map reads the way the caller asked.
        const answers = await Promise.all(
            chunks.map(chunk => signOneChunk(chunk, ttlSeconds, deadline, signer, faults)),
        );
        for (const pairs of answers) {
            for (const [path, url] of pairs) signed.set(path, url);
        }
    } catch {
        faults.add("threw");
    }

    // ONE line per call, counts only. A path or a signed URL in a log is a
    // capability in a log, and the receipts these name are private documents.
    if (signed.size < requested) {
        try {
            console.warn("[receipts/intake] sign-downloads incomplete", {
                requested,
                signed: signed.size,
                fault: [...faults][0] ?? "per-item",
            });
        } catch {
            // Reporting a degraded render must not be how the render dies.
        }
    }
    return signed;
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
