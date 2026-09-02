import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { SECURE_BUCKET, removeSecureDoc, toSecureRef } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";
import { authenticateIntake, STAFF_READ_ROLES } from "@/lib/receipt-intake/intake-auth";
import { EXT_BY_MIME, MAX_INTAKE_BYTES, sniffMime } from "@/lib/receipt-intake/file-type";
import { listReceiptIntakes, serializeReceiptIntake } from "@/lib/receipt-intake/queries";

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
 * RECEIPT_INTAKE_DRYRUN (default ON). A row created during the shadow week
 * stays dry-run even if the env flips later — flipping the switch must not
 * retroactively book a backlog nobody reviewed.
 */

const VALID_SOURCES = new Set(["mobile", "email", "drive", "chat", "web"]);

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

    if (!VALID_SOURCES.has(parsed.source)) return bad("invalid-source");

    const mimeType = sniffMime(parsed.bytes, parsed.declaredMime);
    if (!mimeType) return bad("unsupported-file-type");

    // A machine caller OWNS its idempotency key — it is the only thing that
    // makes a forwarder replay free. A human upload has no natural key, so one
    // is minted; two taps of the button are two documents, which is correct.
    let sourceRef = parsed.sourceRef;
    if (auth.via === "secret") {
        if (!sourceRef) return bad("missing-sourceRef");
    } else {
        sourceRef = sourceRef ?? `${parsed.source === "mobile" ? "mobile" : "web"}:${randomUUID()}`;
    }

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

    const supabase = getSupabase();
    if (!supabase) {
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }
    const upload = await supabase.storage
        .from(SECURE_BUCKET)
        .upload(storagePath, parsed.bytes, { contentType: mimeType, upsert: false });
    if (upload.error) {
        console.error("[receipts/intake] upload failed", upload.error.message);
        return NextResponse.json({ ok: false, reason: "storage-failed" }, { status: 503 });
    }

    try {
        const row = await prisma.receiptIntake.create({
            data: {
                id,
                source: parsed.source,
                sourceRef: sourceRef!,
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
        return NextResponse.json({ ok: true, ...row });
    } catch (error) {
        // The forwarder replayed a document we already hold. Return the row it
        // already has — a non-200 here would make it retry forever.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            await removeSecureDoc(toSecureRef(storagePath)).catch(() => { /* best effort */ });
            const existing = await prisma.receiptIntake.findUnique({
                where: { sourceRef: sourceRef! },
                select: { id: true, state: true, sourceRef: true, projectId: true, dryRun: true },
            });
            if (existing) return NextResponse.json({ ok: true, alreadyReceived: true, ...existing });
        }
        // A projectId/costCodeId that doesn't exist is the CALLER's mistake, so
        // it must be a deterministic 400 — a 500 would make a forwarder retry a
        // payload that can never succeed.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
            await removeSecureDoc(toSecureRef(storagePath)).catch(() => { /* best effort */ });
            return bad("unknown-project-or-cost-code");
        }
        // Never orphan the object: the row that would have pointed at it does
        // not exist.
        await removeSecureDoc(toSecureRef(storagePath)).catch(() => { /* best effort */ });
        throw error;
    }
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
    const rows = await listReceiptIntakes({
        state: url.searchParams.get("state"),
        projectId: url.searchParams.get("projectId"),
        take: url.searchParams.get("take") ? Number(url.searchParams.get("take")) : null,
    });
    return NextResponse.json({ ok: true, rows: rows.map(serializeReceiptIntake) });
}