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
import type { Prisma } from "@prisma/client";
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
 *
 * THE UPLOAD LEASE VERSION IS IN THE PATH, and it is not decoration. A path
 * that is a function of the row and the bytes alone is reused by every later
 * attempt on the same row — including one that follows a rejection, and a
 * rejection is what QUEUES A DELETION of that exact path. A re-armed /start
 * bumps the lease, so this makes a re-seal target a path no outstanding cleanup
 * event can be naming. (Belt and braces: withReceiptPublishLock also cancels
 * any pending cleanup for the path it is about to fill. Either alone closes the
 * reuse; both is cheap.)
 */
export function canonicalStoragePath(id: string, leaseVersion: number, sha256: string, mimeType: string): string {
    const ext = EXT_BY_MIME[mimeType] ?? "bin";
    return `receipts/${id}/v${leaseVersion}/${sha256}.${ext}`;
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
 *
 * AND STEPS 1 AND 2 ARE ONE CRITICAL SECTION. The gap between them is a window
 * in which the bytes exist and nothing in the database references them — which
 * is exactly the shape the storage-cleanup sweep tests for before it deletes.
 * A sweep landing in that window deleted the object this call had just sealed,
 * and the commit then published a row pointing at nothing. `withObjectLock`
 * holds the canonical path's advisory lock across both, so the sweep either
 * runs entirely before the seal (and the seal writes the bytes again) or
 * entirely after the commit (and sees the reference). See
 * withReceiptPublishLock in storage-cleanup.ts.
 *
 * Nothing slow goes inside that lock: no read, no QBO call, no attachment —
 * one storage copy and one fenced UPDATE.
 */
export interface PublishOutcome {
    published: boolean;
    canonicalPath: string;
}

/**
 * The database handle the object lock hands to the critical section. Only the
 * row pointer (and the loser's orphan bookkeeping) may be written with it —
 * every other writer of this path is blocked for as long as it is open.
 */
export type PublishTx = Prisma.TransactionClient;

export interface SealPublishDeps {
    /**
     * Runs the seal-and-commit critical section inside ONE transaction holding
     * the canonical path's advisory lock. See withReceiptPublishLock.
     */
    withObjectLock: <T>(canonicalPath: string, body: (tx: PublishTx) => Promise<T>) => Promise<T>;
    seal: (uploadPath: string, canonicalPath: string, bytes: Buffer, contentType: string) => Promise<string | null>;
    /** Fenced CAS, INSIDE the lock. Returns the number of rows actually moved. */
    commit: (
        tx: PublishTx,
        canonicalPath: string,
        check: { mimeType: string; fileSize: number; fileSha256: string },
    ) => Promise<number>;
    /** Best-effort, AFTER the commit and OUTSIDE the lock. Records a cleanup event on failure. */
    dropUpload: (uploadPath: string) => Promise<void>;
    /**
     * Consulted ONLY when the commit CAS is lost, to tell apart the two
     * reasons that can happen. Returns wherever the row's storagePath points
     * RIGHT NOW. Read through the lock's transaction, so the answer and the
     * orphan drop it decides cannot be separated by another publish.
     */
    currentStoragePath: (tx: PublishTx, rowId: string) => Promise<string | null>;
    /**
     * Best-effort, AFTER a lost commit CAS, and ONLY when the winner is
     * proven to be pointing somewhere else (see below). Same shape as
     * dropUpload — a separate dependency so each caller can record its own
     * reason for the cleanup queue rather than reusing "sealed", which would
     * describe the wrong event.
     */
    dropOrphanedCanonical: (canonicalPath: string) => Promise<void>;
}

export async function sealAndPublish(
    uploadPath: string,
    rowId: string,
    /** The lease the bytes arrived on. It is part of the canonical path. */
    leaseVersion: number,
    check: { mimeType: string; fileSize: number; fileSha256: string; bytes: Buffer },
    deps: SealPublishDeps,
): Promise<PublishOutcome | null> {
    const canonicalPath = canonicalStoragePath(rowId, leaseVersion, check.fileSha256, check.mimeType);

    // EVERYTHING THAT TOUCHES THIS PATH HAPPENS UNDER ITS LOCK: the seal, the
    // fenced commit, and — when the commit is lost — the question of what the
    // winner is pointing at and the drop that answer decides. Asking that
    // question outside the lock and deleting afterwards is the same two-step
    // race one level down: the winner can commit THIS path in the gap, and the
    // drop then deletes the object the winner just published.
    const moved = await deps.withObjectLock(canonicalPath, async tx => {
        const sealed = await deps.seal(uploadPath, canonicalPath, check.bytes, check.mimeType);
        if (!sealed) return null;

        const count = await deps.commit(tx, canonicalPath, check);
        if (count > 0) return count;

        // LOST THE CAS. Some other publish already moved the row — but "moved
        // it where" is the whole question, and it splits into two very
        // different cases:
        //
        //   - the row's storagePath is THIS exact canonicalPath: another
        //     publisher raced this one on the SAME content (same rowId, same
        //     lease, same bytes -> the identical content-addressed path — a
        //     double /finalize, or /finalize racing the sweep on one row). The
        //     object this call just sealed IS the object the winner committed;
        //     deleting it would destroy what the winner is now pointing at.
        //   - anything else: the winner published a DIFFERENT object — a
        //     re-armed upload landed different bytes in the gap between this
        //     call's read and its commit — and the copy THIS call sealed is an
        //     orphan nothing will ever find on its own. It is not a STAGING row
        //     any more (the winner moved it), so the stale-STAGING sweep will
        //     never look at it again, and it would sit in the bucket forever.
        //
        // A failed lookup answers "don't know" as the first case: never delete
        // on uncertainty about what the winner is using.
        const winnerPath = await deps.currentStoragePath(tx, rowId).catch(() => canonicalPath);
        if (winnerPath !== canonicalPath) {
            await deps.dropOrphanedCanonical(canonicalPath).catch(() => undefined);
        }
        return count;
    }).catch(error => {
        // A lock we could not take, or a transaction that could not commit.
        // NOTHING was published, and the same `null` the seal failure returns
        // is the honest answer: a retryable "come back", never a verdict.
        console.error(
            "[receipts/intake] publish critical section failed",
            rowId,
            error instanceof Error ? error.name : "error",
        );
        return null;
    });
    if (moved === null) return null;

    if (moved > 0) {
        // Only once the row points at the sealed copy is the upload object
        // safe to remove — and only if we are the one who moved the row. A
        // publisher that lost the CAS must not delete an object the winner
        // may still be using. Outside the lock deliberately: it is a
        // best-effort delete of a DIFFERENT path, and it must not hold a lock
        // every other publisher of this row is waiting on.
        if (uploadPath !== canonicalPath) await deps.dropUpload(uploadPath);
        return { published: true, canonicalPath };
    }
    return { published: false, canonicalPath };
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

/**
 * A DECLARED HASH IS A CLAIM ABOUT WHICH DOCUMENT THIS CALL IS ABOUT — and it
 * has to be answered on every path that can say "we have it", not only on the
 * one that publishes.
 *
 * /finalize checked `sha256` against the STORED BYTES on the publish path and
 * nowhere else, so a call against an already-settled row (RECEIVED, READ,
 * BOOKED) verified the object against the ROW's recorded hash, ignored the
 * different hash the request carried, and returned 200 alreadyFinalized. A
 * forwarder that sent the wrong row id — a stale mapping, a reused id, a
 * mis-parsed response — was told we held ITS document while we held somebody
 * else's, and it deletes its only copy on that answer.
 *
 * Both halves must be present for this to be an answer: with no declared hash
 * the caller asserted nothing, and an empty `fileSha256` is a row that was
 * written before sealing existed (see downloadVerified) and has no verified
 * identity to compare against. Neither is evidence of a conflict, and refusing
 * on either would break honest callers.
 */
export function declaredShaConflict(recordedSha: string | null, declaredSha: string | null): boolean {
    if (!declaredSha || !recordedSha) return false;
    return recordedSha.toLowerCase() !== declaredSha.toLowerCase();
}

/**
 * "WE ALREADY HAVE IT" — THE ONE RULE BOTH REPLAY PATHS ANSWER IT WITH.
 *
 * `POST /api/receipts/intake` (a forwarder re-sending the same bytes) and
 * `POST /api/receipts/intake/{id}/finalize` (a client retrying a finalize) both
 * end in a 2xx that tells the sender we hold its document — and the forwarders
 * delete their only copy on that answer.
 *
 * They used to decide it from PRESENCE alone: one metadata call saying something
 * sits at the path. That authorised the delete on the strength of bytes nobody
 * had looked at since they were sealed, so an object replaced or corrupted after
 * publication (an upsert URL reused, a restore that put back a different
 * version, a storage-side fault) was laundered into "we have your receipt" and
 * the last good copy went with it. The row's `fileSha256` is the only hash this
 * system has ever verified; the stored bytes must still hash to it.
 *
 * Cheap probe first, so the common orphan case never pays for a download.
 * `content-mismatch` is deliberately its own answer: it is NOT retryable (the
 * sender resending changes nothing) and it must never be healed here — the row
 * is left exactly as it is for the worker's `content-changed` park and the
 * sweeper to act on.
 */
export type StoredCopyCheck =
    | { ok: true }
    | { ok: false; kind: "missing" | "transient" | "content-mismatch"; message?: string };

export async function verifyStoredCopy(
    storagePath: string,
    /** What the row was published with. Empty means a legacy row — see downloadVerified. */
    fileSha256: string,
    sizeOf: (storagePath: string) => Promise<SizeResult> = receiptObjectSize,
    download: (storagePath: string) => Promise<DocBytesResult> = downloadReceiptObject,
): Promise<StoredCopyCheck> {
    const present = await sizeOf(storagePath);
    if (!present.ok) {
        return present.kind === "missing"
            ? { ok: false, kind: "missing" }
            : { ok: false, kind: "transient", message: present.message ?? "size-unavailable" };
    }
    const verified = await downloadVerified(storagePath, fileSha256, download);
    if (verified.ok) return { ok: true };
    // It was there a moment ago, so a `missing` here is a race, not a verdict —
    // and either way it is never a 2xx.
    return verified.kind === "sha-mismatch"
        ? { ok: false, kind: "content-mismatch", message: verified.message }
        : { ok: false, kind: verified.kind, message: verified.message };
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
