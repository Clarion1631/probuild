import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateIntake } from "@/lib/receipt-intake/intake-auth";

export const dynamic = "force-dynamic";

/**
 * Archive callback for the nightly Apps Script mirror
 * (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §6): the script copies each BOOKED
 * receipt into `Processed Receipts/YYYY/MM/` with the v1 filename convention
 * and then reports the Drive file id back here.
 *
 * SECRET-AUTH ONLY. There is no session path: this transition means "a file
 * exists in Drive", which only the mirror can know, and a staff user clicking
 * it would be asserting something they cannot verify.
 *
 * NOTE: this path is a DESCENDANT of /api/receipts/intake, and the proxy
 * bypass there is exact-match on purpose — so this route DOES go through the
 * proxy. It carries no NextAuth session, so the proxy answers it with a 307 to
 * /login unless it is on the bypass too; both paths are listed in
 * PUBLIC_PROXY_BYPASS_PATTERN for that reason, each one exact.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
    // ARCHIVE capability only. This transition means "a file exists in Drive",
    // which only the mirror can know — and the ingest forwarders must not be
    // able to mark rows archived just because they hold a receipt-intake key.
    const auth = await authenticateIntake(req, "archive");
    if (!auth.ok) return auth.response;
    if (auth.via !== "secret") {
        // No session path: a staff user clicking this would be asserting
        // something they cannot verify.
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    let body: { driveFileId?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    const driveFileId = typeof body.driveFileId === "string" ? body.driveFileId.trim() : "";
    if (!driveFileId) {
        return NextResponse.json({ ok: false, reason: "missing-driveFileId" }, { status: 400 });
    }

    const row = await prisma.receiptIntake.findUnique({
        where: { id },
        select: { id: true, state: true, archiveDriveFileId: true },
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // IDEMPOTENT REPLAY. The mirror POSTs after writing the Drive file, so a
    // lost response leaves it holding a file it cannot confirm. Re-sending the
    // SAME driveFileId is the correct retry and must succeed — answering 409
    // would make the script treat its own successful archive as a failure and
    // either re-copy the file or alert a human about nothing.
    // A DIFFERENT driveFileId on an archived row is not a replay: two Drive
    // copies exist and somebody has to say which one counts.
    if (row.state === "ARCHIVED") {
        if (row.archiveDriveFileId === driveFileId) {
            return NextResponse.json({ ok: true, id, state: "ARCHIVED", archiveDriveFileId: driveFileId, alreadyArchived: true });
        }
        return NextResponse.json(
            { ok: false, reason: "already-archived", archiveDriveFileId: row.archiveDriveFileId },
            { status: 409 },
        );
    }

    if (row.state !== "BOOKED") {
        return NextResponse.json({ ok: false, reason: "not-booked", state: row.state }, { status: 409 });
    }

    // Conditional on state so two mirror runs racing the same row cannot both
    // claim the transition; the loser sees 0 rows and reports 409.
    const updated = await prisma.receiptIntake.updateMany({
        where: { id, state: "BOOKED" },
        data: { state: "ARCHIVED", archiveDriveFileId: driveFileId },
    });
    if (updated.count === 0) {
        // We lost a race. Two identical callbacks (the mirror retrying a lost
        // response) can both read BOOKED; the winner archives and the loser's
        // conditional update matches nothing. Returning 409 on that made the
        // mirror treat its OWN successful archive as a failure. Re-read: if the
        // row is now ARCHIVED with the same Drive id, the outcome the caller
        // asked for is exactly what happened.
        const now = await prisma.receiptIntake.findUnique({
            where: { id },
            select: { state: true, archiveDriveFileId: true },
        });
        if (now?.state === "ARCHIVED" && now.archiveDriveFileId === driveFileId) {
            return NextResponse.json({ ok: true, id, state: "ARCHIVED", archiveDriveFileId: driveFileId, alreadyArchived: true });
        }
        return NextResponse.json(
            { ok: false, reason: "not-booked", state: now?.state ?? "gone" },
            { status: 409 },
        );
    }
    return NextResponse.json({ ok: true, id, state: "ARCHIVED", archiveDriveFileId: driveFileId });
}
