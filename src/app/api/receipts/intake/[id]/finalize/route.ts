import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { downloadDocBytesResult, toSecureRef } from "@/lib/secure-storage";
import { authenticateIntake, STAFF_READ_ROLES } from "@/lib/receipt-intake/intake-auth";
import { sniffMime } from "@/lib/receipt-intake/file-type";
import { MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Step 2 of the two-step upload: verify what actually landed, then publish.
 *
 * Everything here is checked against the STORED OBJECT, never against what the
 * client says about it. The client uploaded directly to Supabase, so this is the
 * only point at which the server sees the bytes at all — trusting a declared
 * hash, size or type would mean the row's `fileSha256` (which decides whether a
 * replay is a duplicate or a conflict) was attacker-supplied.
 *
 * STAGING -> RECEIVED is the publish, and it is the only thing that makes the
 * row visible to the worker.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
    const auth = await authenticateIntake(req, "ingest");
    if (!auth.ok) return auth.response;

    const { id } = await context.params;

    let body: { sha256?: unknown } = {};
    try {
        body = await req.json();
    } catch {
        // A finalize with no body is fine — the declared hash is optional.
    }
    const declaredSha = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : null;

    const row = await prisma.receiptIntake.findUnique({
        where: { id },
        select: {
            id: true, state: true, sourceRef: true, storagePath: true, mimeType: true,
            projectId: true, dryRun: true, createdById: true, fileSha256: true,
        },
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // Same rule as the conflict path: a session caller may only finalize its
    // OWN row (or hold a bookkeeping role). Otherwise a guessed id would let one
    // user publish another's upload.
    const maySee =
        auth.via === "secret" ||
        row.createdById === auth.user.id ||
        STAFF_READ_ROLES.includes(auth.user.role);
    if (!maySee) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // Idempotent: finalizing an already-published row is a success, not an error
    // — the client's retry after a lost response must not look like a failure.
    if (row.state !== "STAGING") {
        return NextResponse.json({
            ok: true, alreadyFinalized: true, id: row.id, state: row.state,
            sourceRef: row.sourceRef, projectId: row.projectId, dryRun: row.dryRun,
        });
    }

    const download = await downloadDocBytesResult(toSecureRef(row.storagePath));
    if (!download.ok) {
        if (download.kind === "not-found") {
            // The upload never landed. Retryable, and NEVER a 2xx: the
            // forwarders treat 2xx as "we have it" and would drop their copy.
            return NextResponse.json(
                { ok: false, error: "object-missing", reason: "upload the bytes to the signed URL first" },
                { status: 409 },
            );
        }
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }

    const bytes = download.bytes;
    if (bytes.length > MAX_STORED_BYTES) {
        // Enforced on the OBJECT, because the signed URL bypassed every check
        // this server could otherwise have made. Drop it rather than leave an
        // oversize file in a private bucket nobody will ever book.
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
        return NextResponse.json({ ok: false, reason: "file-too-large", maxBytes: MAX_STORED_BYTES }, { status: 413 });
    }

    // The stored type is decided on the BYTES, exactly like the single-shot path.
    const mimeType = sniffMime(bytes, row.mimeType);
    if (!mimeType) {
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
        return NextResponse.json({ ok: false, reason: "unsupported-file-type" }, { status: 400 });
    }

    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    // A declared hash is an INTEGRITY check on the client's own upload, never
    // the value we store. A mismatch means the bytes in the bucket are not the
    // bytes the client meant to send.
    if (declaredSha && declaredSha !== fileSha256) {
        return NextResponse.json(
            { ok: false, error: "sha-mismatch", reason: "stored bytes do not match the declared sha256" },
            { status: 409 },
        );
    }

    const published = await prisma.receiptIntake.updateMany({
        where: { id, state: "STAGING" },
        data: { state: "RECEIVED", mimeType, fileSize: bytes.length, fileSha256 },
    });
    if (published.count === 0) {
        // Another finalize won the race and published it. Same outcome.
        const now = await prisma.receiptIntake.findUnique({
            where: { id },
            select: { state: true, sourceRef: true, projectId: true, dryRun: true },
        });
        return NextResponse.json({ ok: true, alreadyFinalized: true, id, state: now?.state ?? "RECEIVED" });
    }

    return NextResponse.json({
        ok: true, id, state: "RECEIVED", sourceRef: row.sourceRef,
        projectId: row.projectId, dryRun: row.dryRun, fileSize: bytes.length,
    });
}
