/**
 * The one place a STAGING row's stored object is validated and turned into row
 * metadata.
 *
 * Two callers publish a STAGING row — /intake/{id}/finalize (the client says it
 * has finished uploading) and the worker's stale-STAGING sweep (nobody ever
 * came back, but the object is there). They MUST agree: a sweep that published
 * on "the object exists" alone would wave through a 40 MB video, a .exe, or a
 * truncated upload that /finalize would have rejected — and those rows then go
 * to Gemini and, if they read at all, to QuickBooks.
 *
 * Everything here is derived from the BYTES IN STORAGE. The client uploaded
 * straight to Supabase, so nothing it declared about the file is evidence.
 */
import { createHash } from "node:crypto";
import type { DocBytesResult } from "@/lib/secure-storage";
import { downloadReceiptObject, receiptObjectSize, type SizeResult } from "./bucket";
import { EXT_BY_MIME, sniffMime } from "./file-type";
import { MAX_STORED_BYTES } from "./intake-core";

/**
 * Where a VERIFIED object lives, keyed by its own content hash.
 *
 * The upload path is writable by whoever holds the signed URL, and that URL is
 * `upsert: true` so a resumed /start can replace its own partial upload. Both
 * are necessary and together they mean the upload path can change AFTER we
 * verified it. Sealing copies the bytes somewhere the client was never given a
 * URL for, and names it after the sha — so the path itself asserts the content,
 * and re-verifying on download is a comparison against a value that cannot have
 * been rewritten in place.
 */
export function canonicalStoragePath(id: string, sha256: string, mimeType: string): string {
    const ext = EXT_BY_MIME[mimeType] ?? "bin";
    return `receipts/${id}/${sha256}.${ext}`;
}

/**
 * Read bytes and REFUSE them if they are not what the row recorded.
 *
 * Every consumer of a stored receipt (the reader, the booker) goes through
 * this. A hash stored at finalize is worthless if nothing ever checks it again.
 */
export type VerifiedBytes =
    | { ok: true; bytes: Buffer }
    | { ok: false; kind: "missing" | "transient" | "sha-mismatch"; message?: string };

/**
 * SEAL AND PUBLISH — the one operation that moves a row out of STAGING.
 *
 * Shared by /intake/{id}/finalize and the worker's stale-STAGING sweep so the
 * two cannot diverge: the sweeper used to publish while the row still pointed
 * at the UPLOAD path, which is writable by anyone holding the signed URL, so a
 * swept row's "verified" bytes stayed replaceable afterwards.
 *
 * Order is the whole point:
 *   1. copy the verified bytes to the canonical (content-addressed) path
 *   2. COMMIT the row pointer, fenced on state and claim
 *   3. only then delete the upload object, best-effort
 *
 * A crash between 1 and 2 leaves both objects and a STAGING row: the retry
 * finds the canonical copy already there, re-uploads it as a no-op, and
 * commits. A failure at 3 is an orphan on the cleanup queue, not a lost
 * receipt.
 */
export interface PublishOutcome {
    published: boolean;
    canonicalPath: string;
}

export interface SealPublishDeps {
    seal: (uploadPath: string, canonicalPath: string, bytes: Buffer, contentType: string) => Promise<string | null>;
    /** Fenced CAS. Returns the number of rows actually moved. */
    commit: (canonicalPath: string, check: { mimeType: string; fileSize: number; fileSha256: string }) => Promise<number>;
    /** Best-effort, AFTER the commit. Records a cleanup event on failure. */
    dropUpload: (uploadPath: string) => Promise<void>;
}

export async function sealAndPublish(
    uploadPath: string,
    rowId: string,
    check: { mimeType: string; fileSize: number; fileSha256: string; bytes: Buffer },
    deps: SealPublishDeps,
): Promise<PublishOutcome | null> {
    const canonicalPath = canonicalStoragePath(rowId, check.fileSha256, check.mimeType);
    const sealed = await deps.seal(uploadPath, canonicalPath, check.bytes, check.mimeType);
    if (!sealed) return null;

    const moved = await deps.commit(canonicalPath, check);
    // Only once the row points at the sealed copy is the upload object safe to
    // remove — and only if we are the one who moved the row. A publisher that
    // lost the CAS must not delete an object the winner may still be using.
    if (moved > 0 && uploadPath !== canonicalPath) {
        await deps.dropUpload(uploadPath);
    }
    return { published: moved > 0, canonicalPath };
}

export async function downloadVerified(
    storagePath: string,
    expectedSha256: string,
    download: (storagePath: string) => Promise<DocBytesResult> = downloadReceiptObject,
): Promise<VerifiedBytes> {
    const result = await download(storagePath);
    if (!result.ok) {
        return result.kind === "not-found"
            ? { ok: false, kind: "missing" }
            : { ok: false, kind: "transient", message: result.message };
    }
    // An empty expectation means a legacy row written before sealing existed;
    // there is nothing to compare against, so pass the bytes through rather
    // than refuse a receipt for a reason that is our fault.
    if (!expectedSha256) return { ok: true, bytes: result.bytes };

    const actual = createHash("sha256").update(result.bytes).digest("hex");
    if (actual !== expectedSha256) {
        return { ok: false, kind: "sha-mismatch", message: `expected ${expectedSha256}, stored ${actual}` };
    }
    return { ok: true, bytes: result.bytes };
}

export type StoredObjectCheck =
    /**
     * Valid: these are the values the row must be published with, plus the
     * exact bytes that produced them — so the sealed copy is provably the
     * content that was verified, not a second download that could differ.
     */
    | { ok: true; mimeType: string; fileSize: number; fileSha256: string; bytes: Buffer }
    /** The object is not there. Terminal for the sweep; retryable for a client. */
    | { ok: false; kind: "missing" }
    /** Storage could not answer. Never a verdict — come back later. */
    | { ok: false; kind: "transient"; message: string }
    /** The object exists and is NOT acceptable. The row and object must go. */
    | { ok: false; kind: "rejected"; reason: string };

export async function inspectStoredObject(
    storagePath: string,
    /**
     * What the row recorded at /start. Used ONLY for text/plain, which has no
     * magic bytes — the same concession the single-shot path makes. Every
     * format that CAN be identified is identified from the bytes.
     */
    declaredMime: string,
    download: (storagePath: string) => Promise<DocBytesResult> = downloadReceiptObject,
    /** Metadata-only size lookup; injected so the "no body read" test is provable. */
    sizeOf: (storagePath: string) => Promise<SizeResult> = receiptObjectSize,
): Promise<StoredObjectCheck> {
    // SIZE FIRST, FROM METADATA — before a single byte is read.
    //
    // The signed upload URL bypasses this server, so nothing has seen this
    // object yet. Downloading it to discover it is 400 MB is how one upload
    // takes the worker's whole invocation (and its memory) with it. `list`
    // returns the metadata row in one small request whatever the object's size.
    //
    // AN UNKNOWN SIZE IS TRANSIENT, not permission to proceed. It used to mean
    // "carry on and let the byte-length check catch it" — which is the download
    // this call exists to avoid, taken on exactly the objects we know least
    // about (a storage hiccup, a missing client, an API with no metadata). The
    // sweep and the client both retry a transient answer; neither can be hurt
    // by waiting, and both can be hurt by a 400 MB read.
    const declared = await sizeOf(storagePath);
    if (!declared.ok) {
        return declared.kind === "missing"
            ? { ok: false, kind: "missing" }
            : { ok: false, kind: "transient", message: declared.message ?? "size-unavailable" };
    }
    if (declared.size > MAX_STORED_BYTES) {
        return { ok: false, kind: "rejected", reason: `file-too-large:${declared.size}` };
    }

    const result = await download(storagePath);
    if (!result.ok) {
        return result.kind === "not-found"
            ? { ok: false, kind: "missing" }
            : { ok: false, kind: "transient", message: result.message };
    }

    const bytes = result.bytes;
    if (bytes.length === 0) return { ok: false, kind: "rejected", reason: "empty-file" };
    // Enforced on the OBJECT, because the signed upload URL bypassed every
    // check this server could otherwise have made.
    if (bytes.length > MAX_STORED_BYTES) {
        return { ok: false, kind: "rejected", reason: `file-too-large:${bytes.length}` };
    }

    // Magic bytes, exactly like the single-shot path. A declared mime is a
    // claim; this is the answer.
    const mimeType = sniffMime(bytes, declaredMime);
    if (!mimeType) return { ok: false, kind: "rejected", reason: "unsupported-file-type" };

    return {
        ok: true,
        mimeType,
        fileSize: bytes.length,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
    };
}

/**
 * The only two parked reasons a later, correct upload may recover from.
 *
 * "Any NEEDS_REVIEW row" is far too broad: a row parked for a vendor mismatch,
 * a zero total or a QBO fault would be dragged back to RECEIVED and re-read,
 * discarding a decision a human already made about it — and, past BOOKING, that
 * re-read is a second Purchase waiting to happen.
 */
export const RECOVERABLE_PARK_REASONS = ["file-missing", "sha-mismatch"];

export interface ObservedRow {
    state: string;
    stateReason: string | null;
    /**
     * The upload lease this decision was made against. A resumed or re-armed
     * /start bumps it, so a sweep that decided on v1 writes nothing once the
     * client is on v2 — the row it judged does not exist any more.
     */
    uploadLeaseVersion: number;
}

/** What a finalize may do with the row it just read. */
export type FinalizeDisposition = "publish" | "not-recoverable" | "settled";

export function finalizeDisposition(row: ObservedRow): FinalizeDisposition {
    if (row.state === "STAGING") return "publish";
    if (row.state === "NEEDS_REVIEW") {
        return RECOVERABLE_PARK_REASONS.includes(row.stateReason ?? "") ? "publish" : "not-recoverable";
    }
    return "settled";
}

/**
 * The CAS a publish must carry: the EXACT state and reason that were observed,
 * and an unclaimed row.
 *
 * `state: { in: [...] }` was not enough. Inspecting the object and sealing it
 * takes seconds, and in that window the reason can change — a row parked
 * `file-missing` can be re-parked `vendor-mismatch`, or the worker can claim it.
 * A publish fenced only on the state SET would then reset a reason it never
 * looked at back to RECEIVED, discarding the newer decision and republishing a
 * row somebody else now owns. Pinning the reason makes that update match zero
 * rows, which is a 409 the client can retry rather than a silent overwrite.
 */
export function publishFence(row: ObservedRow): {
    state: string;
    stateReason: string | null;
    claimToken: null;
    uploadLeaseVersion: number;
} {
    return {
        state: row.state,
        stateReason: row.stateReason,
        claimToken: null,
        uploadLeaseVersion: row.uploadLeaseVersion,
    };
}

/** Where the bytes for one upload lease live. The version is IN the path. */
export function uploadPathFor(rowId: string, leaseVersion: number, ext: string): string {
    return `receipts/intake/${rowId}.v${leaseVersion}.${ext}`;
}
