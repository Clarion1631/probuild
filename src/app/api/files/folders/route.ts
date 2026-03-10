import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST: create a new folder
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { name, projectId, leadId, parentId } = body;

    if (!name?.trim()) {
        return NextResponse.json({ error: "Folder name required" }, { status: 400 });
    }

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
    }

    const folder = await prisma.fileFolder.create({
        data: {
            name: name.trim(),
            ...(projectId && { projectId }),
            ...(leadId && { leadId }),
            ...(parentId && { parentId }),
        },
        include: {
            _count: { select: { files: true, children: true } },
        },
    });

    return NextResponse.json(folder, { status: 201 });
}

// PATCH: rename a folder
export async function PATCH(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { id, name } = body;

    if (!id || !name?.trim()) {
        return NextResponse.json({ error: "id and name required" }, { status: 400 });
    }

    const folder = await prisma.fileFolder.update({
        where: { id },
        data: { name: name.trim() },
    });

    return NextResponse.json(folder);
}
