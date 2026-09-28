import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { OPEN_PROJECT_STATUSES } from "@/lib/project-status";

export const dynamic = "force-dynamic";

/**
 * Read-only list of open project names for the receipt bot's intake folder
 * reconciler (Apps Script), which uses this to create missing job folders
 * under New Receipts & Checks. "Open" here is OPEN_PROJECT_STATUSES
 * (Waiting to Start / In Progress / Substantial Completion) — a folder should
 * exist as soon as a job is won, not just once crew are on site, otherwise
 * early receipts (e.g. a Lowe's order placed before mobilization) park in
 * _Needs Review with nowhere to file. Same auth contract as the receipt
 * push: x-ingest-key must equal RECEIPT_INGEST_SECRET, 401 otherwise. No
 * kill switch — this endpoint writes nothing anywhere.
 *
 * The names returned here are the CANONICAL project names: the Drive intake
 * folder, the QBO customer, and the receipt push's project match all key off
 * these exact strings (normalized: trim/lowercase/collapse-spaces).
 *
 * This is the only known consumer of this route (verified 2026-09-24 — no
 * other caller in this repo or in qbo-clasp), so the filter was widened in
 * place rather than gated behind an opt-in query param.
 */
export async function GET(request: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || request.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    try {
        const projects = await prisma.project.findMany({
            where: { status: { in: OPEN_PROJECT_STATUSES } },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
        });
        return NextResponse.json({
            ok: true,
            projects: projects.map(p => p.name), // UNCHANGED — reconcileIntakeFolders.js depends on this shape
            projectRefs: projects.map(p => ({ id: p.id, name: p.name })),
        });
    } catch (error) {
        console.error("qbo-receipts/projects list failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "list-failed" }, { status: 500 });
    }
}
