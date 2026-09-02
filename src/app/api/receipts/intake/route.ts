import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";
import { authenticateIntake, STAFF_READ_ROLES, type IntakeAuth } from "@/lib/receipt-intake/intake-auth";
import { EXT_BY_MIME, MAX_INTAKE_BYTES, sniffMime } from "@/lib/receipt-intake/file-type";
import { ARCHIVE_READABLE_STATES, listReceiptIntakes, serializeReceiptIntake } from "@/lib/receipt-intake/queries";

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

interface ParsedBody {
    bytes: Buffer;
    declaredMime: string;
    fileName: string | null;
    source: string;
    sourceRef: string | null;
    projectId: string | null;
    costCodeId: string | null;
    threadName: string | null;
}

function bad(reason: string) {
    return NextResponse.json({ ok: false, reason }, { status: 400 });
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
        if (file.size > MAX_INTAKE_BYTES) return bad("file-too-large");
        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length > MAX_INTAKE_BYTES) return bad("file-too-large");
        return {
            bytes,
            declaredMime: file.type || "application/octet-stream",
            fileName: str(file.name),
            source: String(form.get("source") ?? ""),
            sourceRef: str(form.get("sourceRef")),
            projectId: str(form.get("projectId")),
            costCodeId: str(form.get("costCodeId")),
            threadName: str(form.get("threadName")),
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
    if (base64.length > Math.ceil(MAX_INTAKE_BYTES / 3) * 4 + 4) return bad("file-too-large");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) return bad("missing-file");
    if (bytes.length > MAX_INTAKE_BYTES) return bad("file-too-large");
    return {
        bytes,
        declaredMime: typeof json.mimeType === "string" ? json.mimeType : "application/octet-stream",
        fileName: str(json.fileName),
        source: String(json.source ?? ""),
        sourceRef: str(json.sourceRef),
        projectId: str(json.projectId),
        costCodeId: str(json.costCodeId),
        threadName: str(json.threadName),
    };
}

export async function POST(req: Request) {
    const auth = await authenticateIntake(req);
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
        source = parsed.source;
        sourceRef = parsed.sourceRef;
    } else {
        source = auth.userVia === "mobile-jwt" ? "mobile" : "web";
        // Reject rather than silently ignore: a client that thinks it set the
        // key would otherwise believe its retries were idempotent when every
        // one of them creates a new document.
        if (parsed.sourceRef) return bad("sourceRef-not-allowed");
        if (parsed.source && parsed.source !== source) return bad("invalid-source");
        sourceRef = `${source}:${randomUUID()}`;
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
                state: "RECEIVED",
                // Captured per row, never read from env again after this point.
                dryRun: process.env.RECEIPT_INTAKE_DRYRUN !== "false",
                projectId: parsed.projectId,
                costCodeId: parsed.costCodeId,
                createdById: auth.via === "session" ? auth.user.id : null,
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
            return respondToSourceRefConflict(auth, sourceRef, fileSha256);
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
    const upload = await supabase.storage
        .from(SECURE_BUCKET)
        .upload(storagePath, parsed.bytes, { contentType: mimeType, upsert: false });
    if (upload.error) {
        // Delete the row so the caller's retry is a clean insert rather than a
        // sourceRef conflict against a row pointing at an object that is not
        // there. The worker would otherwise park it "file-missing".
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
        console.error("[receipts/intake] upload failed", upload.error.message);
        return NextResponse.json({ ok: false, reason: "storage-failed" }, { status: 503 });
    }

    return NextResponse.json({ ok: true, ...created });
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
    sourceRef: string,
    fileSha256: string,
): Promise<NextResponse> {
    const existing = await prisma.receiptIntake.findUnique({
        where: { sourceRef },
        select: {
            id: true, state: true, sourceRef: true, projectId: true,
            dryRun: true, fileSha256: true, createdById: true,
        },
    });
    // The row vanished between the failed insert and this read (a delete
    // racing us). Tell the caller to retry rather than inventing an answer.
    if (!existing) return NextResponse.json({ ok: false, reason: "conflict-retry" }, { status: 409 });

    if (existing.fileSha256 !== fileSha256) {
        return NextResponse.json(
            { ok: false, error: "sourceRef-conflict", existingId: existing.id },
            { status: 409 },
        );
    }

    const maySee =
        auth.via === "secret" ||
        existing.createdById === auth.user.id ||
        STAFF_READ_ROLES.includes(auth.user.role);
    if (!maySee) {
        // No fields at all: an id or a state would still confirm the row exists.
        return NextResponse.json({ ok: false, error: "sourceRef-conflict" }, { status: 409 });
    }

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
    const auth = await authenticateIntake(req);
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
    return NextResponse.json({ ok: true, rows: rows.map(serializeReceiptIntake) });
}
