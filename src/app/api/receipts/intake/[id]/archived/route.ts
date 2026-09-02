import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { secretMatches, RECEIPT_INTAKE_SECRET_HEADER } from "@/lib/receipt-intake/intake-auth";

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
    if (!secretMatches(req.headers.get(RECEIPT_INTAKE_SECRET_HEADER), process.env.RECEIPT_INTAKE_SECRET)) {
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
        select: { id: true, state: true },
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
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
        return NextResponse.json({ ok: false, reason: "not-booked" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, id, state: "ARCHIVED", archiveDriveFileId: driveFileId });
}
