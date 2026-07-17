// /api/mobile/leads/[id] — lead detail for the field app: client info, notes,
// media files, room designs (with AR usdz), Drive folder link.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { assertLeadAccess } from "@/lib/lead-access";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id } = await params;

    const fail = await assertLeadAccess(auth.user, id);
    if (fail) return fail;

    const lead = await prisma.lead.findUnique({
        where: { id },
        select: {
            id: true,
            number: true,
            name: true,
            stage: true,
            projectType: true,
            location: true,
            driveFolderUrl: true,
            lastActivityAt: true,
            client: { select: { name: true, primaryPhone: true, email: true } },
            notes: {
                orderBy: { createdAt: "desc" },
                take: 30,
                select: { id: true, content: true, createdBy: true, createdAt: true },
            },
            files: {
                orderBy: { createdAt: "desc" },
                take: 60,
                select: { id: true, name: true, url: true, mimeType: true, size: true, createdAt: true },
            },
            roomDesigns: {
                orderBy: { updatedAt: "desc" },
                select: { id: true, name: true, scanUsdzUrl: true, thumbnail: true, updatedAt: true },
            },
        },
    });
    if (!lead) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ lead });
}
