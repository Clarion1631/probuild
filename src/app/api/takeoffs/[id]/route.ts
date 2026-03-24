import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/takeoffs/[id] — Get a single takeoff with files
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const takeoff = await prisma.takeoff.findUnique({
        where: { id },
        include: {
            files: { orderBy: { createdAt: "asc" } },
            estimate: { select: { id: true, title: true, code: true, totalAmount: true, status: true } },
            project: { select: { id: true, name: true, type: true, location: true } },
            lead: { select: { id: true, name: true, projectType: true, location: true } },
        },
    });

    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    return NextResponse.json(takeoff);
}

// PATCH /api/takeoffs/[id] — Update a takeoff
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.aiEstimateData !== undefined) updateData.aiEstimateData = body.aiEstimateData;
    if (body.estimateId !== undefined) updateData.estimateId = body.estimateId;

    const takeoff = await prisma.takeoff.update({
        where: { id },
        data: updateData,
        include: { files: true },
    });

    return NextResponse.json(takeoff);
}

// DELETE /api/takeoffs/[id] — Delete a takeoff and its files
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    await prisma.takeoff.delete({ where: { id } });

    return NextResponse.json({ success: true });
}
