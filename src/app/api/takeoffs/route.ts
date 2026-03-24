import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/takeoffs?projectId=xxx or ?leadId=xxx
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const leadId = searchParams.get("leadId");

    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (leadId) where.leadId = leadId;

    const takeoffs = await prisma.takeoff.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
            files: true,
            estimate: { select: { id: true, title: true, code: true, totalAmount: true } },
        },
    });

    return NextResponse.json(takeoffs);
}

// POST /api/takeoffs — Create a new takeoff
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { name, description, projectId, leadId } = body;

    if (!name) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId is required" }, { status: 400 });
    }

    const takeoff = await prisma.takeoff.create({
        data: {
            name,
            description: description || null,
            projectId: projectId || null,
            leadId: leadId || null,
            status: "Draft",
        },
        include: { files: true },
    });

    return NextResponse.json(takeoff, { status: 201 });
}
