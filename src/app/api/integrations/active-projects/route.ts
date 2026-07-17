import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { OPEN_PROJECT_STATUSES } from "@/lib/project-status";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    try {
        const projects = await prisma.project.findMany({
            where: { status: { in: OPEN_PROJECT_STATUSES } },
            select: { id: true, name: true },
        });

        return NextResponse.json({ ok: true, projects });
    } catch (err: any) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
    }
}
