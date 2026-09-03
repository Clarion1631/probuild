import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { authorizePhase } from "@/lib/receipt-intake/late-fields";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { uploadReceiptObject } from "@/lib/receipt-intake/bucket";
import { getSupabase } from "@/lib/supabase";
import { authenticateIntake, STAFF_READ_ROLES, type IntakeAuth } from "@/lib/receipt-intake/intake-auth";
import {
    claimObjectPath,
    deleteObjectOrRecord,
    inShortTx,
    recordPendingCleanup,
    resolveCanonicalIntent,
} from "@/lib/receipt-intake/storage-cleanup";
import { cleanupNotBefore } from "@/lib/receipt-intake/worker";
import { ACCEPTED_MIME_TYPES, EXT_BY_MIME, sniffMime } from "@/lib/receipt-intake/file-type";
import {
    decideSource,
    MACHINE_SOURCES,
    MAX_INLINE_JSON_BYTES,
    MAX_INLINE_UPLOAD_BYTES,
    MAX_STORED_BYTES,
} from "@/lib/receipt-intake/intake-core";
import { finalizeDisposition, leaseFence, verifyStoredCopy } from "@/lib/receipt-intake/stored-object";
import {
    ARCHIVE_READABLE_STATES,
    listReceiptIntakes,
    serializeReceiptIntake,
    withArchiveDownloadUrls,
} from "@/lib/receipt-intake/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Receipt Pipeline v2 intake — the ONE front door for every inbound receipt or
 * check (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §3).
 *
 * POST accepts the mobile app (Bearer), staff (session), and the Apps Script
 * forwarders (x-receipt-intake-secret). It does the cheap work only — hash,
 * store, insert — and returns in well under a second, because a forwarder that
 * times out re-POSTs and the whole point of `sourceRef` is that a replay is
 * free. NO Gemini call happens here; the cron worker reads the row later.
 *
 * `/api/receipts/intake` is on the proxy's exact-match public bypass, so this
 * handler is the sole auth boundary — see src/lib/receipt-intake/intake-auth.ts.
 *
 * Shadow-week gate: `dryRun` is captured PER ROW at intake time from
 * RECEIPT_INTAKE_DRYRUN (default ON), so the flag a row was accepted under is
 * a fact about that row rather than about whenever the worker next looks at
 * it. At CUTOVER the worker's one-shot `requeueDryRunParked` deliberately
 * flips the parked backlog to live in a single statement — see
 * src/lib/receipt-intake/worker.ts. That is the ONLY thing that changes a
 * row's dryRun after intake.
 */

interface ParsedBody {
    bytes: Buffer;
    declaredMime: string;
    fileName: string | null;
    source: string;
    sourceRef: string | null;
    uploadId: string | null;
    projectId: string | null;
    costCodeId: string | null;
    threadName: string | null;
    /** The forwarder reporting that v1 already booked and archived this file. */
    archivedByV1: boolean;
}

function bad(reason: string) {
    return NextResponse.json({ ok: false, reason }, { status: 400 });
}

/**
 * The inline path carries the file in the request body, which the platform caps
 * around 4.5 MB — base64 JSON inflates it by a third on top. Anything bigger
 * used to die at the edge with an opaque 413 that never reached this code, so
 * the caller learned nothing. Say it plainly and name the path that works.
 */
/**
 * 415, not 400: the caller's request was well-formed, we simply will never
 * accept this format. Naming what IS accepted is the difference between a
 * sender who fixes it and one who retries the same file forever.
 */
function unsupportedType(declared: string) {
    const essence = declared.split(";")[0].trim().toLowerCase();
    return NextResponse.json(
        {
            ok: false,
            error: "unsupported-file-type",
            reason: essence === "text/plain"
                ? "text receipts are not accepted: QuickBooks cannot attach a .txt, so it would be read and then stranded unbookable. Print or export it to PDF first."
                : "the stored bytes are not a format QuickBooks can attach",
            accepted: ACCEPTED_MIME_TYPES,
        },
        { status: 415 },
    );
}

function tooLargeForInline(limit: number, encoding: "json" | "multipart") {
    return NextResponse.json(
        {
            ok: false,
            error: "payload-too-large",
            reason: encoding === "json"
                ? `JSON uploads are limited to ${limit} raw bytes; base64 inflates them by 4/3 and the serverless body cap is what actually rejects a larger one`
                : `multipart uploads are limited to ${limit} bytes (serverless request-body cap)`,
            maxInlineBytes: limit,
            maxBytes: MAX_STORED_BYTES,
            use: "POST /api/receipts/intake/start then PUT to the signed URL then POST /api/receipts/intake/{id}/finalize",
        },
        { status: 413 },
    );
}

async function parseBody(req: Request): Promise<ParsedBody | NextResponse> {
    const contentType = req.headers.get("content-type") ?? "";
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

    if (contentType.includes("multipart/form-data")) {
        let form: FormData;
        try {
            form = await req.formData();
        } catch {
            return bad("invalid-multipart");
        }
        const file = form.get("file");
        if (!(file instanceof File)) return bad("missing-file");
        // Multipart sends the bytes as-is, so it keeps the full 4 MiB.
        if (file.size > MAX_INLINE_UPLOAD_BYTES) return tooLargeForInline(MAX_INLINE_UPLOAD_BYTES, "multipart");
        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length > MAX_INLINE_UPLOAD_BYTES) return tooLargeForInline(MAX_INLINE_UPLOAD_BYTES, "multipart");
        return {
            bytes,
            declaredMime: file.type || "application/octet-stream",
            fileName: str(file.name),
            source: String(form.get("source") ?? ""),
            sourceRef: str(form.get("sourceRef")),
            uploadId: str(form.get("uploadId")),
            projectId: str(form.get("projectId")),
            costCodeId: str(form.get("costCodeId")),
            threadName: str(form.get("threadName")),
            archivedByV1: form.get("archivedByV1") === "true",
        };
    }

    let json: Record<string, unknown>;
    try {
        json = await req.json();
    } catch {
        return bad("invalid-json");
    }
    const base64 = typeof json.fileBase64 === "string" ? json.fileBase64 : "";
    if (!base64) return bad("missing-file");
    // Cap BEFORE decoding: base64 is 4/3 the byte count, so this refuses an
    // oversize payload without materialising it.
    // Checked on the ENCODED length first, so an oversize payload is refused
    // without materialising it.
    if (base64.length > Math.ceil(MAX_INLINE_JSON_BYTES / 3) * 4 + 4) {
        return tooLargeForInline(MAX_INLINE_JSON_BYTES, "json");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) return bad("missing-file");
    if (bytes.length > MAX_INLINE_JSON_BYTES) return tooLargeForInline(MAX_INLINE_JSON_BYTES, "json");
    return {
        bytes,
        declaredMime: typeof json.mimeType === "string" ? json.mimeType : "application/octet-stream",
        fileName: str(json.fileName),
        source: String(json.source ?? ""),
        sourceRef: str(json.sourceRef),
        uploadId: str(json.uploadId),
        projectId: str(json.projectId),
        costCodeId: str(json.costCodeId),
        threadName: str(json.threadName),
        // Strict === true: only an explicit boolean may mark a row as already
        // booked by v1, because that flag is what excuses v2 from booking it.
        archivedByV1: json.archivedByV1 === true,
    };
}

export async function POST(req: Request) {
    const auth = await authenticateIntake(req, "ingest");
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(req);
    if (parsed instanceof NextResponse) return parsed;

    const mimeType = sniffMime(parsed.bytes, parsed.declaredMime);
    if (!mimeType) return unsupportedType(parsed.declaredMime);

    // Computed BEFORE decideSource, not just before the insert: a session/
    // mobile caller with no uploadId is scoped by this hash, so decideSource
    // needs it to mint a STABLE key rather than a random one.
    const fileSha256 = createHash("sha256").update(parsed.bytes).digest("hex");

    // PROVENANCE AND IDENTITY ARE NOT CALLER INPUT for a human, and the rules
    // are decideSource()'s — THE SAME FUNCTION /start calls, not a copy.
    //
    // This block used to be a hand-written twin of it, and it had drifted in
    // two ways that mattered: it checked the global MACHINE_SOURCES set instead
    // of the sources THIS key owns (`auth.allowedSources`), and it validated
    // only the namespace prefix, so `drive:` with an empty tail was accepted as
    // a permanent, unique idempotency key that every later empty-tail forward
    // then collided with. A forwarder reaching the two endpoints must not be
    // able to tell them apart.
    const decided = decideSource(auth, {
        source: parsed.source,
        sourceRef: parsed.sourceRef,
        uploadId: parsed.uploadId,
        checksum: fileSha256,
    });
    if (!decided.ok) return bad(decided.reason);
    const { source, sourceRef } = decided;

    // A session/Bearer caller may only file against a project they can reach.
    // The secret caller is a trusted forwarder resolving the project from the
    // Drive folder, and has no user to scope by.
    if (auth.via === "session" && parsed.projectId) {
        const allowed = await userCanAccessProject(auth.user, parsed.projectId);
        if (!allowed) return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    // A phase belongs to a job. Same gate as /start, AFTER the project
    // authorization above: nothing downstream re-checks a cost code that was
    // supplied when the row was created, so this is the only place to catch one
    // that belongs to another job.
    const badPhase = await authorizePhase(parsed.projectId, parsed.costCodeId, (project, code) =>
        isCostCodeAllowedForProject(prismaPhaseDataSource, project, code));
    if (badPhase) return NextResponse.json(badPhase.body, { status: badPhase.status });

    const id = randomUUID();
    const ext = EXT_BY_MIME[mimeType] ?? "bin";
    const storagePath = `receipts/intake/${id}.${ext}`;

    // ROW FIRST, THEN THE OBJECT.
    //
    // Uploading first meant a replayed `sourceRef` had already written a second
    // object into the private bucket before the insert failed, and the cleanup
    // was best-effort. Worse, it made the two cases indistinguishable: a genuine
    // forwarder retry and a REUSED sourceRef carrying different bytes both
    // landed on the same P2002 and both got a cheerful 200, so a second, real
    // receipt could be swallowed by the first one's row and never booked.
    //
    // Inserting first turns the unique index into the decision point, with
    // `fileSha256` as the evidence: same bytes is a replay (200, the row you
    // already have), different bytes is a caller bug (409) — and in the 409
    // case storage is never touched at all.
    let created: { id: string; state: string; sourceRef: string; projectId: string | null; dryRun: boolean };
    try {
        created = await prisma.receiptIntake.create({
            data: {
                id,
                source,
                sourceRef,
                // STAGING, not RECEIVED. Inserting first is what makes the
                // unique index the decision point (see below), but it also
                // publishes a claimable row whose object is not in the bucket
                // yet — the worker would grab it, find nothing, and park a
                // perfectly good receipt as "file-missing". STAGING is excluded
                // from the claim predicate; the UPDATE after a successful
                // upload is what actually hands the row to the worker.
                state: "STAGING",
                // Captured per row, never read from env again after this point.
                dryRun: process.env.RECEIPT_INTAKE_DRYRUN !== "false",
                projectId: parsed.projectId,
                costCodeId: parsed.costCodeId,
                createdById: auth.via === "session" ? auth.user.id : null,
                // Only a shared-secret forwarder may assert this: it is the
                // claim that v1 already put this document in the books, and it
                // is what stops v2 from booking it at cutover.
                archivedByV1: auth.via === "secret" ? parsed.archivedByV1 : false,
                storagePath,
                fileName: parsed.fileName,
                mimeType,
                fileSize: parsed.bytes.length,
                fileSha256,
                // `threadName` is accepted (the chat forwarder sends it) but not
                // persisted: `memo` belongs to the READ step, which stores the
                // check's handwritten memo line there. Phase 2 adds a column for
                // the chat thread when the queue page needs to link back to it.
            },
            select: { id: true, state: true, sourceRef: true, projectId: true, dryRun: true },
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            return respondToSourceRefConflict(auth, source, sourceRef, fileSha256, {
                bytes: parsed.bytes, mimeType, storagePath,
            });
        }
        // A projectId/costCodeId that doesn't exist is the CALLER's mistake, so
        // it must be a deterministic 400 — a 500 would make a forwarder retry a
        // payload that can never succeed.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
            return bad("unknown-project-or-cost-code");
        }
        throw error;
    }

    const supabase = getSupabase();
    if (!supabase) {
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }
    // A THROW here is not the same as an error result — the SDK can reject
    // before it ever reaches storage — but both leave a STAGING row pointing at
    // an object that may not exist, so both clean it up. The caller's retry is
    // then a clean insert rather than a conflict against a half-written row.
    let uploadFailed: string | null = null;
    try {
        const stored = await uploadReceiptObject(storagePath, parsed.bytes, mimeType);
        if (!stored) uploadFailed = "upload-failed";
    } catch (error) {
        uploadFailed = error instanceof Error ? `${error.name}: ${error.message}` : "upload-threw";
    }
    if (uploadFailed) {
        // AMBIGUOUS. An upload error — especially a thrown one — does not tell
        // us whether bytes landed: the write may have succeeded and the
        // acknowledgement been lost. So the cleanup record is written BEFORE
        // the row is deleted, while `storagePath` is still known to something.
        // Delete first and the object (if any) is orphaned with nothing left
        // pointing at it, invisible in a private bucket forever.
        //
        // A no-op cleanup for an upload that genuinely never landed is free;
        // the sweeper's delete simply finds nothing.
        try {
            await recordPendingCleanup(storagePath, `upload-ambiguous:${uploadFailed}`.slice(0, 200));
        } catch {
            // The record is the only thing that would remember this object. If
            // it cannot be written, KEEP THE ROW: a STAGING row pointing at the
            // path is the remaining way to find the bytes, and the sweeper will
            // resolve it. Deleting now would orphan them with nothing left
            // referencing them anywhere.
            console.error("[receipts/intake] cleanup unrecordable; keeping the row as the pointer", storagePath);
            return NextResponse.json(
                { ok: false, reason: "storage-failed", id, retained: true },
                { status: 503 },
            );
        }

        // Row deletion is FENCED on state+path, NOT a bare delete by id.
        //
        // A concurrent replay carrying the same sourceRef can find this exact
        // row via respondToSourceRefConflict, upload to ITS OWN path, and
        // publish it — all while THIS request's upload is still failing. An
        // unconditional `delete({ where: { id } })` would then destroy that
        // now-RECEIVED row. The delete is a no-op unless the row is still
        // exactly what THIS request created: still STAGING, still pointing at
        // the path THIS request uploaded (or tried to upload) to.
        //
        // Failure to delete is still SURFACED, not swallowed: the caller's
        // retry would otherwise hit a sourceRef conflict against a row it was
        // told did not exist.
        let deletedCount: number;
        try {
            const result = await prisma.receiptIntake.deleteMany({
                where: { id, state: "STAGING", storagePath },
            });
            deletedCount = result.count;
        } catch (deleteError) {
            console.error("[receipts/intake] row delete failed after an ambiguous upload", id, deleteError);
            return NextResponse.json(
                { ok: false, reason: "storage-failed", id, retained: true },
                { status: 503 },
            );
        }
        if (deletedCount === 0) {
            // Somebody else already moved this row on — most likely a
            // concurrent replay published it via respondToSourceRefConflict's
            // healing path. That is the outcome the caller wanted, even
            // though THIS attempt's own upload failed, so report on what the
            // row actually is now rather than a failure that no longer holds.
            const current = await prisma.receiptIntake
                .findUnique({
                    where: { id },
                    select: { id: true, state: true, sourceRef: true, projectId: true, dryRun: true },
                })
                .catch(() => null);
            if (current?.state === "RECEIVED") {
                return NextResponse.json({ ok: true, ...current, alreadyPublished: true });
            }
            return NextResponse.json(
                { ok: false, reason: "publish-conflict", id, state: current?.state ?? "gone" },
                { status: 409 },
            );
        }
        console.error("[receipts/intake] upload failed", uploadFailed);
        return NextResponse.json({ ok: false, reason: "storage-failed" }, { status: 503 });
    }

    return publishStagedRow(id, storagePath);
}

/**
 * STAGING -> RECEIVED. The one write that makes a row claimable.
 *
 * Split out because it must be RESUMABLE: if the upload lands and this UPDATE
 * then fails (a connection reset between two round trips is not rare), the
 * object exists and the row does not point at it, and nothing would ever fix
 * that — the row is invisible to the worker's claim by design, so it would sit
 * until the 15-minute sweeper wrongly declared its file missing. An identical
 * retry finds the STAGING row, confirms the object really is there, and
 * finishes the job.
 */
/** Upload bytes to the receipts bucket. Returns false on any failure. */
const storeObject = (storagePath: string, bytes: Buffer, mimeType: string) =>
    uploadReceiptObject(storagePath, bytes, mimeType, { upsert: true });

async function publishStagedRow(id: string, expectStoragePath: string, expectState = "STAGING"): Promise<NextResponse> {
    try {
        // EXACT-state, EXACT-path CAS. `update` by id and state alone would
        // publish a row that had since moved on in a way that still matched
        // `expectState` — a row re-armed onto a NEW upload path by a
        // concurrent /start (or a heal in respondToSourceRefConflict) is
        // still STAGING, but the object THIS caller verified is no longer
        // the one the row points at. Publishing anyway would either point a
        // RECEIVED row at bytes nobody uploaded, or (worse) race a second
        // publisher onto the same state with two different ideas of which
        // object is now canonical. Pinning storagePath makes that update
        // match zero rows instead.
        const { count } = await prisma.receiptIntake.updateMany({
            where: { id, state: expectState, storagePath: expectStoragePath },
            data: { state: "RECEIVED" },
        });
        if (count === 0) {
            const current = await prisma.receiptIntake.findUnique({
                where: { id },
                select: { state: true, storagePath: true },
            });
            // Somebody else won the publish race. If the winner's row now
            // points somewhere OTHER than the path THIS call expected, the
            // object THIS call verified/uploaded is unreferenced by any row —
            // concurrent same-byte replays each upload to their own random
            // path (see /start), so nothing else will ever find this one to
            // clean it up. Do it now, before reporting the idempotent outcome
            // the loser is about to return.
            //
            // AND THE FAILURE IS NOT SWALLOWED. deleteObjectOrRecord throws
            // when it can neither delete the object nor record it, and this
            // caller has no transaction to roll back — so the throw has to
            // reach the client as a retryable 503 rather than be discarded on
            // the way to a cheerful `alreadyPublished`. A forwarder deletes
            // its only copy on that answer, and the bytes we just orphaned
            // would be the ones nobody can find.
            if (current?.storagePath && current.storagePath !== expectStoragePath) {
                const remembered = await deleteObjectOrRecord(
                    expectStoragePath,
                    "orphaned-by-concurrent-publish",
                ).then(() => true, () => false);
                if (!remembered) {
                    return NextResponse.json(
                        { ok: false, reason: "storage-unavailable", retryable: true },
                        { status: 503 },
                    );
                }
            }
            // Somebody else published it; that is the outcome the caller wanted.
            if (current?.state === "RECEIVED") {
                return NextResponse.json({ ok: true, id, state: "RECEIVED", alreadyPublished: true });
            }
            return NextResponse.json(
                { ok: false, error: "publish-conflict", id, state: current?.state ?? "gone" },
                { status: 409 },
            );
        }
        const published = await prisma.receiptIntake.findUnique({
            where: { id },
            select: { id: true, state: true, sourceRef: true, projectId: true, dryRun: true },
        });
        return NextResponse.json({ ok: true, ...(published ?? { id, state: "RECEIVED" }) });
    } catch (error) {
        // The bytes ARE stored; only the publish failed. Leave the row in
        // STAGING — 503 tells the caller to retry, and the retry resumes.
        console.error("[receipts/intake] publish failed", error instanceof Error ? error.name : "error");
        return NextResponse.json({ ok: false, reason: "publish-failed", id, status: "staging" }, { status: 503 });
    }
}

/**
 * The sourceRef is already taken. Two very different situations:
 *
 *  - SAME bytes  -> the forwarder replayed. Return the row it already has; a
 *    non-200 would make it retry forever.
 *  - OTHER bytes -> the caller reused a key for a DIFFERENT document. Answering
 *    200 would tell it the new receipt was accepted when nothing was stored,
 *    and that receipt would never be booked. 409, and storage stays untouched.
 *
 * Who may see the existing row is a separate question (a minted `web:<uuid>`
 * can only collide by accident, but a secret-authenticated caller that guessed
 * a ref must not be able to enumerate other people's rows): only the row's own
 * creator or a bookkeeping role gets fields back.
 */
async function respondToSourceRefConflict(
    auth: Extract<IntakeAuth, { ok: true }>,
    source: string,
    sourceRef: string,
    fileSha256: string,
    /** The bytes this replay carried — used to HEAL a row whose object is gone. */
    payload: { bytes: Buffer; mimeType: string; storagePath: string },
): Promise<NextResponse> {
    const existing = await prisma.receiptIntake.findUnique({
        where: { sourceRef },
        select: {
            id: true, state: true, source: true, sourceRef: true, projectId: true,
            dryRun: true, fileSha256: true, createdById: true, storagePath: true, stateReason: true,
            // The whole lease identity, because the heal's CAS pins it — see
            // leaseFence. A refresh moves only the nonce and the expiry.
            uploadLeaseVersion: true, uploadLeaseNonce: true, uploadUrlExpiresAt: true,
            // Only for cleanupNotBefore: an inline row has no expiry, so its
            // capability window is measured from createdAt.
            createdAt: true,
        },
    });
    // The row vanished between the failed insert and this read (a delete
    // racing us). Tell the caller to retry rather than inventing an answer.
    if (!existing) return NextResponse.json({ ok: false, reason: "conflict-retry" }, { status: 409 });

    // AUTHORIZATION BEFORE ANY DETAIL, including on the mismatch branch.
    // `existingId` is a real identifier for someone else's document; returning
    // it to a caller who may not read the row turns a 409 into an oracle that
    // confirms a guessed sourceRef and hands back a usable id.
    //
    // For a secret caller "may read" is narrower than "holds the secret": it
    // may only see rows in ITS OWN namespace. The forwarders are separate
    // scripts, and a chat forwarder guessing `drive:<fileId>` should learn
    // nothing about the Drive pipeline's rows.
    const maySee =
        auth.via === "secret"
            ? MACHINE_SOURCES.has(existing.source) &&
              existing.source === source &&
              existing.sourceRef.startsWith(`${source}:`)
            : existing.createdById === auth.user.id || STAFF_READ_ROLES.includes(auth.user.role);

    if (!maySee) {
        // No fields at all: an id or a state would still confirm the row exists.
        return NextResponse.json({ ok: false, error: "sourceRef-conflict" }, { status: 409 });
    }

    if (existing.fileSha256 !== fileSha256) {
        return NextResponse.json(
            { ok: false, error: "sourceRef-conflict", existingId: existing.id },
            { status: 409 },
        );
    }

    // SAME BYTES. Before promising anything, confirm the document is actually
    // in the bucket — for EVERY state, not just STAGING.
    //
    // Checking only STAGING left a hole: once the stale-row sweep flipped an
    // orphan to NEEDS_REVIEW/file-missing, this replay returned a cheerful 200
    // and the forwarder could delete its only copy of a receipt we did not
    // have. The state a row happens to be parked in says nothing about whether
    // its bytes exist.
    // AND PRESENCE IS NOT THE SAME QUESTION AS CORRECTNESS.
    //
    // Existence alone still authorised the delete, on the strength of bytes
    // nobody had looked at since they were sealed — so an object REPLACED after
    // publication (an upsert URL reused, a restore that put back a different
    // version, a storage-side fault) was laundered into "we have your receipt",
    // and the last good copy went with it. `existing.fileSha256` is the hash
    // this row was published with, and on this branch it provably equals the
    // hash of the payload in this very request; the stored bytes must still
    // hash to it. ONE rule, shared with /finalize (stored-object.ts), so the two
    // replay paths cannot come to disagree about what "we already have it" means.
    //
    // A cheap metadata probe still runs first inside it: this path runs on every
    // replay and the object may be 8 MiB, so an orphan never pays for a
    // download. A TRANSIENT answer is not evidence of absence — healing on it
    // would overwrite a document that is really there — so it is answered 503
    // and the forwarder retries with its copy intact.
    const held = await verifyStoredCopy(existing.storagePath, existing.fileSha256);
    if (!held.ok && held.kind === "transient") {
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }
    if (!held.ok && held.kind === "content-mismatch") {
        // NOT healed. A re-upload is exactly how bytes get replaced, so
        // overwriting on a mismatch would let a replay launder the swap. Never a
        // 2xx either: the sender keeps its copy. The row is left as it is for
        // the worker's `content-changed` park and the sweeper to act on.
        return NextResponse.json(
            {
                ok: false,
                error: "content-mismatch",
                reason: "the stored document is not the one this row was published with; keep your copy and escalate",
                retryable: false,
                id: existing.id,
                state: existing.state,
            },
            { status: 409 },
        );
    }
    if (!held.ok) {
        // The caller just handed us the bytes again, so the orphan is fixable:
        // store them and republish. This is the retry HEALING the row rather
        // than merely reporting on it.
        // Recovery is restricted to the two reasons a later, correct upload can
        // actually fix. "Any NEEDS_REVIEW row" was far too broad: a row parked
        // for a vendor mismatch, a zero total, or a QBO fault would be dragged
        // back to RECEIVED and re-read, discarding the decision a human had
        // already made about it.
        // ONE list, shared with /finalize (stored-object.ts). Two copies of
        // "which parks a re-upload may clear" is how the two publishers come to
        // disagree about whether a human's decision can be overwritten.
        const healable = finalizeDisposition(existing) === "publish";
        if (healable) {
            // CLAIMED BEFORE IT IS WRITTEN — the same phase-A rule the publish
            // uses, for the same reason.
            //
            // `uploadReceiptObject` returns false for a refusal AND for an
            // ambiguous outcome: a write storage may well have accepted before
            // the response was lost. Returning 503 on that without recording
            // anything left those bytes in a private bucket with no row
            // pointing at them, no event remembering them and no sweep looking
            // for them — the row still points at its OLD path, so the
            // stale-STAGING sweep never sees this one.
            //
            // The intent is committed first, in its own short transaction, and
            // carries a lease so the sweeper leaves the path alone while this
            // request is still using it. A heal that succeeds cancels it in the
            // transaction that repoints the row; a heal that fails, ambiguously
            // or otherwise, simply leaves it for the sweeper.
            let healIntentId: string;
            try {
                healIntentId = await claimObjectPath(payload.storagePath, cleanupNotBefore(existing));
            } catch {
                // Writing an object we could not first promise to clean up IS
                // the leak. Nothing is uploaded.
                return NextResponse.json(
                    { ok: false, reason: "storage-unavailable", retryable: true },
                    { status: 503 },
                );
            }
            const healed = await storeObject(payload.storagePath, payload.bytes, payload.mimeType);
            if (!healed) {
                // AMBIGUOUS: storage may hold the bytes. The intent stands and
                // the sweeper collects them once its lease lapses, rechecking
                // live references first.
                return NextResponse.json({ ok: false, error: "storage-failed" }, { status: 503 });
            }
            // The SAME fence /finalize publishes under: exact state, exact
            // reason, unclaimed. Losing this race means somebody moved the row
            // while we were uploading, so the object we just wrote is
            // unreferenced — clean it up rather than orphan it.
            // ONE SHORT TRANSACTION, with the upload already done: the repoint
            // and the cancellation of its intent land together or neither does.
            const { count } = await inShortTx(async tx => {
                const moved = await tx.receiptIntake.updateMany({
                    // leaseFence: the heal REPOINTS the row at bytes this request
                    // uploaded, and a /start that reissued the client's URL in the
                    // meantime moves neither the state, the reason nor the version.
                    where: { id: existing.id, ...leaseFence(existing) },
                    data: { storagePath: payload.storagePath, state: "RECEIVED", stateReason: null, nextRetryAt: null },
                });
                // Referenced from this instant, so the intent goes with it.
                if (moved.count > 0) await resolveCanonicalIntent(tx, healIntentId);
                return moved;
            });
            if (count === 0) {
                // Same rule as the publish-race drop above: this branch has no
                // transaction of its own, so a cleanup that could neither
                // delete nor record must surface as a retryable 503 instead of
                // being lost inside a 409.
                if (payload.storagePath !== existing.storagePath) {
                    const remembered = await deleteObjectOrRecord(
                        payload.storagePath,
                        "heal-lost-race",
                    ).then(() => true, () => false);
                    if (!remembered) {
                        return NextResponse.json(
                            { ok: false, reason: "storage-unavailable", retryable: true },
                            { status: 503 },
                        );
                    }
                }
                return NextResponse.json(
                    { ok: false, error: "publish-conflict", id: existing.id },
                    { status: 409 },
                );
            }
            return NextResponse.json({
                ok: true, recovered: true, id: existing.id, state: "RECEIVED",
                sourceRef: existing.sourceRef, projectId: existing.projectId, dryRun: existing.dryRun,
            });
        }
        // A booked/archived row with no object is not something a replay may
        // rewrite. Retryable failure, never a 2xx.
        return NextResponse.json(
            {
                ok: false,
                error: "object-missing",
                reason: "this sourceRef exists but its stored document is gone; escalate",
                id: existing.id,
                state: existing.state,
            },
            { status: 409 },
        );
    }

    // The object is there AND it is this document. A STAGING row means the
    // previous request uploaded successfully and only its publish UPDATE
    // failed — finish it.
    if (existing.state === "STAGING") return publishStagedRow(existing.id, existing.storagePath);

    return NextResponse.json({
        ok: true,
        alreadyReceived: true,
        id: existing.id,
        state: existing.state,
        sourceRef: existing.sourceRef,
        projectId: existing.projectId,
        dryRun: existing.dryRun,
    });
}

/**
 * Staff queue read, and the nightly Apps Script archive mirror's source of
 * work (§6 polls `?state=BOOKED` with the shared secret). The proxy bypass
 * means this handler enforces the role itself — a session user without a
 * bookkeeping role gets 403, not a redirect.
 */
export async function GET(req: Request) {
    // A secret caller here is the ARCHIVE mirror. The ingest forwarders hold a
    // different key and are refused with 403 — a script that only copies files
    // to Drive has no business enumerating the queue, and vice versa.
    const auth = await authenticateIntake(req, "archive");
    if (!auth.ok) return auth.response;
    if (auth.via === "session" && !STAFF_READ_ROLES.includes(auth.user.role)) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const state = url.searchParams.get("state");

    // The secret caller is the archive mirror and nothing else. It reads only
    // the two states it acts on, and only the columns it needs — see
    // RECEIPT_INTAKE_ARCHIVE_SELECT. Staff sessions are unaffected.
    const archiveOnly = auth.via === "secret";
    if (archiveOnly && (!state || !ARCHIVE_READABLE_STATES.has(state))) {
        return NextResponse.json(
            { ok: false, reason: "state-not-allowed", allowed: [...ARCHIVE_READABLE_STATES] },
            { status: 400 },
        );
    }

    const rows = await listReceiptIntakes({
        state,
        projectId: archiveOnly ? null : url.searchParams.get("projectId"),
        take: url.searchParams.get("take") ? Number(url.searchParams.get("take")) : null,
        archiveOnly,
    });

    if (archiveOnly) {
        // The mirror needs to FETCH each file and NAME it. It holds no service
        // key and cannot read the private bucket, so every row carries a
        // short-lived signed URL plus the project name the filename is built
        // from.
        const withUrls = await withArchiveDownloadUrls(
            rows as Array<{ storagePath: string; project?: { name: string } | null }>,
        );
        return NextResponse.json({ ok: true, rows: withUrls.map(serializeReceiptIntake) });
    }

    return NextResponse.json({ ok: true, rows: rows.map(serializeReceiptIntake) });
}
