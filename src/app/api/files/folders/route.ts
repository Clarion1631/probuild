import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

// GET: list all folders for a project or lead
export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const leadId = searchParams.get("leadId");

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
    }

    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (leadId) where.leadId = leadId;

    const folders = await prisma.fileFolder.findMany({
        where,
        orderBy: { name: "asc" },
        include: { _count: { select: { files: true, children: true } } },
    });

    return NextResponse.json(folders);
}
// POST: create a new folder
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { name, projectId, leadId, parentId, visibility } = body;

    if (!name?.trim()) {
        return NextResponse.json({ error: "Folder name required" }, { status: 400 });
    }

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
    }

    const folder = await prisma.fileFolder.create({
        data: {
            name: name.trim(),
            ...(visibility && { visibility }),
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

// PATCH: rename a folder or change its visibility
export async function PATCH(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { id, name, visibility } = body;

    if (!id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    if (visibility === "financial") {
        const callerUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: { permissions: true },
        });
        if (!callerUser || !hasPermission(callerUser, "financialReports")) {
            return NextResponse.json({ error: "No permission to set financial visibility" }, { status: 403 });
        }
    }

    const updateData: any = {};
    if (name?.trim()) updateData.name = name.trim();
    if (visibility) updateData.visibility = visibility;

    const folder = await prisma.fileFolder.update({
        where: { id },
        data: updateData,
        include: { _count: { select: { files: true, children: true } } },
    });

    return NextResponse.json(folder);
}
