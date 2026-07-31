import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Read-only list of in-progress project names for the receipt bot's intake
 * folder reconciler (Apps Script). Same auth contract as the receipt push:
 * x-ingest-key must equal RECEIPT_INGEST_SECRET, 401 otherwise. No kill
 * switch — this endpoint writes nothing anywhere.
 *
 * The names returned here are the CANONICAL project names: the Drive intake
 * folder, the QBO customer, and the receipt push's project match all key off
 * these exact strings (normalized: trim/lowercase/collapse-spaces).
 */
export async function GET(request: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || request.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    try {
        const projects = await prisma.project.findMany({
            where: { status: "In Progress" },
            select: { name: true },
            orderBy: { name: "asc" },
        });
        return NextResponse.json({ ok: true, projects: projects.map(p => p.name) });
    } catch (error) {
        console.error("qbo-receipts/projects list failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "list-failed" }, { status: 500 });
    }
}
