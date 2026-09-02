import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { SECURE_BUCKET, secureObjectExists } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";
import { authenticateIntake, STAFF_READ_ROLES, type IntakeAuth } from "@/lib/receipt-intake/intake-auth";
import { EXT_BY_MIME, sniffMime } from "@/lib/receipt-intake/file-type";
import { MAX_INLINE_UPLOAD_BYTES, MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";
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

/**
 * Sources a SHARED-SECRET forwarder may declare. A human caller can never pick
 * one of these: `source` is provenance, and a browser asserting "this came from
 * the Drive folder" is a claim it has no standing to make. It also feeds
 * booking identity — `drive` rows book under the Drive fileId so the DocNumber
 * stays continuous with v1 — so a forged `source` could aim a Purchase at
 * another document's idempotency key.
 */
const MACHINE_SOURCES = new Set(["drive", "email", "chat"]);
/** Minted server-side from the authenticated caller, never read off the body. */
const USER_SOURCES = new Set(["mobile", "web"]);

/** Client-supplied idempotency tokens must be real UUIDs — never a free-text key. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
function tooLargeForInline() {
    return NextResponse.json(
        {
            ok: false,
            error: "payload-too-large",
            reason: `inline uploads are limited to ${MAX_INLINE_UPLOAD_BYTES} bytes (serverless request-body cap)`,
            maxInlineBytes: MAX_INLINE_UPLOAD_BYTES,
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
        if (file.size > MAX_INLINE_UPLOAD_BYTES) return tooLargeForInline();
        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length > MAX_INLINE_UPLOAD_BYTES) return tooLargeForInline();
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
    if (base64.length > Math.ceil(MAX_INLINE_UPLOAD_BYTES / 3) * 4 + 4) return tooLargeForInline();
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) return bad("missing-file");
    if (bytes.length > MAX_INLINE_UPLOAD_BYTES) return tooLargeForInline();
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
    if (!mimeType) return bad("unsupported-file-type");

    // PROVENANCE AND IDENTITY ARE NOT CALLER INPUT for a human.
    //
    // A shared-secret forwarder owns both: its `sourceRef` is the only reason a
    // replay is free, and its `source` is a fact it genuinely knows (which
    // folder, which mailbox). A session or Bearer caller knows neither. Letting
    // one pass `source: "drive"` plus a chosen `sourceRef` would let it claim
    // another document's idempotency key — and `drive` rows book under the
    // Drive fileId, so that key is what a QBO DocNumber is derived from.
    let source: string;
    let sourceRef: string;
    if (auth.via === "secret") {
        if (!MACHINE_SOURCES.has(parsed.source)) return bad("invalid-source");
        if (!parsed.sourceRef) return bad("missing-sourceRef");
        // The ref must live in the namespace the caller declared. Without this
        // a chat forwarder could write `drive:<fileId>` and collide with — or
        // pre-empt — the Drive pipeline's key for a file it does not own, and
        // `drive` rows are the ones that book under the Drive fileId, i.e. the
        // QBO DocNumber.
        if (!parsed.sourceRef.startsWith(`${parsed.source}:`)) return bad("sourceRef-namespace-mismatch");
        source = parsed.source;
        sourceRef = parsed.sourceRef;
    } else {
        source = auth.userVia === "mobile-jwt" ? "mobile" : "web";
        if (parsed.source && parsed.source !== source) return bad("invalid-source");
        // A RAW sourceRef stays forbidden — provenance is not caller input.
        if (parsed.sourceRef) return bad("sourceRef-not-allowed");

        // But a phone on a bad connection needs SOME way to retry safely: a
        // minted uuid makes every retry a new document, so a crew member who
        // taps Send twice on a spinner books the same receipt twice. `uploadId`
        // is the client's own idempotency token, and it is SCOPED TO THE USER
        // server-side — two people cannot collide on the same uuid, and one
        // user cannot reach another's row by guessing one.
        if (parsed.uploadId) {
            if (!UUID_PATTERN.test(parsed.uploadId)) return bad("invalid-uploadId");
            sourceRef = `${source}:${auth.user.id}:${parsed.uploadId.toLowerCase()}`;
        } else {
            sourceRef = `${source}:${randomUUID()}`;
        }
    }
    if (!USER_SOURCES.has(source) && !MACHINE_SOURCES.has(source)) return bad("invalid-source");

    // A session/Bearer caller may only file against a project they can reach.
    // The secret caller is a trusted forwarder resolving the project from the
    // Drive folder, and has no user to scope by.
    if (auth.via === "session" && parsed.projectId) {
        const allowed = await userCanAccessProject(auth.user, parsed.projectId);
        if (!allowed) return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    const id = randomUUID();
    const ext = EXT_BY_MIME[mimeType] ?? "bin";
    const storagePath = `receipts/intake/${id}.${ext}`;
    const fileSha256 = createHash("sha256").update(parsed.bytes).digest("hex");

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
        const upload = await supabase.storage
            .from(SECURE_BUCKET)
            .upload(storagePath, parsed.bytes, { contentType: mimeType, upsert: false });
        if (upload.error) uploadFailed = upload.error.message;
    } catch (error) {
        uploadFailed = error instanceof Error ? `${error.name}: ${error.message}` : "upload-threw";
    }
    if (uploadFailed) {
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
        console.error("[receipts/intake] upload failed", uploadFailed);
        return NextResponse.json({ ok: false, reason: "storage-failed" }, { status: 503 });
    }

    return publishStagedRow(id);
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
/** Upload bytes to the private bucket. Returns false on any failure. */
async function storeObject(storagePath: string, bytes: Buffer, mimeType: string): Promise<boolean> {
    const supabase = getSupabase();
    if (!supabase) return false;
    try {
        const { error } = await supabase.storage
            .from(SECURE_BUCKET)
            .upload(storagePath, bytes, { contentType: mimeType, upsert: true });
        if (error) console.error("[receipts/intake] heal upload failed", error.message);
        return !error;
    } catch (error) {
        console.error("[receipts/intake] heal upload threw", error instanceof Error ? error.name : "error");
        return false;
    }
}

async function publishStagedRow(id: string): Promise<NextResponse> {
    try {
        const published = await prisma.receiptIntake.update({
            where: { id },
            data: { state: "RECEIVED" },
            select: { id: true, state: true, sourceRef: true, projectId: true, dryRun: true },
        });
        return NextResponse.json({ ok: true, ...published });
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
            dryRun: true, fileSha256: true, createdById: true, storagePath: true,
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
    if (!(await secureObjectExists(existing.storagePath))) {
        // The caller just handed us the bytes again, so the orphan is fixable:
        // store them and republish. This is the retry HEALING the row rather
        // than merely reporting on it.
        const healable = existing.state === "STAGING" || existing.state === "NEEDS_REVIEW";
        if (healable) {
            const healed = await storeObject(payload.storagePath, payload.bytes, payload.mimeType);
            if (!healed) {
                return NextResponse.json({ ok: false, error: "storage-failed" }, { status: 503 });
            }
            await prisma.receiptIntake.update({
                where: { id: existing.id },
                data: { storagePath: payload.storagePath, state: "RECEIVED", stateReason: null, nextRetryAt: null },
            });
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

    // The object is there. A STAGING row means the previous request uploaded
    // successfully and only its publish UPDATE failed — finish it.
    if (existing.state === "STAGING") return publishStagedRow(existing.id);

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
