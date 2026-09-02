import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateIntake, STAFF_READ_ROLES } from "@/lib/receipt-intake/intake-auth";
import { MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";
import { inspectStoredObject } from "@/lib/receipt-intake/stored-object";
import { deleteObjectOrRecord } from "@/lib/receipt-intake/storage-cleanup";

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
            expectedSha256: true,
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

    // ONE validator, shared with the worker's stale-STAGING sweep — see
    // stored-object.ts. If the two disagreed, whichever ran first would decide
    // whether a 40 MB video became a receipt.
    const check = await inspectStoredObject(row.storagePath, row.mimeType);
    if (!check.ok) {
        if (check.kind === "missing") {
            // The upload never landed. Retryable, and NEVER a 2xx: the
            // forwarders treat 2xx as "we have it" and would drop their copy.
            return NextResponse.json(
                { ok: false, error: "object-missing", reason: "upload the bytes to the signed URL first" },
                { status: 409 },
            );
        }
        if (check.kind === "transient") {
            return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
        }
        // REJECTED. The row goes, and so must the object — nothing references it
        // once the row is gone, so a failed delete is recorded for the sweep to
        // retry rather than shrugged off.
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
        await deleteObjectOrRecord(row.storagePath, check.reason);
        const status = check.reason.startsWith("file-too-large") ? 413 : 400;
        return NextResponse.json(
            { ok: false, reason: check.reason, maxBytes: MAX_STORED_BYTES },
            { status },
        );
    }

    const { mimeType, fileSize, fileSha256 } = check;

    // THE HASH IS CHECKED AGAINST BOTH RECORDED EXPECTATIONS.
    //
    // `expectedSha256` was written by /start from what the client said it was
    // about to upload; `declaredSha` is what it says now. Either disagreeing
    // with the stored bytes means the object is not the document this row was
    // created for — which is exactly the case a reused sourceRef produces, and
    // the case that would otherwise attach one receipt's bytes to another
    // receipt's identity.
    for (const [label, expected] of [["declared", declaredSha], ["expected", row.expectedSha256]] as const) {
        if (expected && expected.toLowerCase() !== fileSha256) {
            return NextResponse.json(
                {
                    ok: false,
                    error: "sha-mismatch",
                    reason: `stored bytes do not match the ${label} sha256`,
                    storedSha256: fileSha256,
                },
                { status: 409 },
            );
        }
    }

    const published = await prisma.receiptIntake.updateMany({
        where: { id, state: "STAGING" },
        data: { state: "RECEIVED", mimeType, fileSize, fileSha256 },
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
        projectId: row.projectId, dryRun: row.dryRun, fileSize,
    });
}
