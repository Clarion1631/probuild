import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import {
    authorizeFileScope,
    folderSubtreeExposesFiles,
    isAncestorChainShared,
    isAncestorFinancial,
} from "@/lib/file-auth";

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

    const authResult = await authorizeFileScope(session.user.email, { projectId, leadId });
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;
    const canSeeFinancial = hasPermission(user, "financialReports");

    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (leadId) where.leadId = leadId;
    if (!canSeeFinancial) where.visibility = { not: "financial" };

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

    const authResult = await authorizeFileScope(session.user.email, { projectId, leadId });
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;

    if (visibility === "financial" && !hasPermission(user, "financialReports")) {
        return NextResponse.json({ error: "No permission to create financial folders" }, { status: 403 });
    }
    if (!hasPermission(user, "financialReports") && parentId && await isAncestorFinancial(parentId)) {
        return NextResponse.json({ error: "No permission to create folders under financial folders" }, { status: 403 });
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

    // Load the folder first so we can authorize against its scope and current state.
    const existing = await prisma.fileFolder.findUnique({
        where: { id },
        select: { projectId: true, leadId: true, visibility: true },
    });
    if (!existing) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const authResult = await authorizeFileScope(session.user.email, {
        projectId: existing.projectId,
        leadId: existing.leadId,
    });
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;

    if (existing.visibility === "financial" && !hasPermission(user, "financialReports")) {
        return NextResponse.json({ error: "No permission to modify financial folders" }, { status: 403 });
    }
    if (!hasPermission(user, "financialReports") && id && await isAncestorFinancial(id)) {
        return NextResponse.json({ error: "No permission to modify financial folders" }, { status: 403 });
    }
    if (visibility === "financial" && !hasPermission(user, "financialReports")) {
        return NextResponse.json({ error: "No permission to set financial visibility" }, { status: 403 });
    }

    // Un-sharing a folder hides everything the chain below it exposes, including
    // files explicitly marked "shared", because the portal requires the WHOLE
    // ancestor chain to be shared. The single-file endpoint refuses that; without
    // the same gate here, flipping "Signed Documents" to team silently takes back
    // every signed estimate the client could see — the exact regression the
    // signed-documents fix was written to stop.
    if (
        visibility
        && visibility !== "shared"
        && existing.visibility === "shared"
        && existing.projectId
        && body.allowClientVisibilityLoss !== true
    ) {
        const reachable = await isAncestorChainShared(id, existing.projectId);
        if (reachable && await folderSubtreeExposesFiles(id, existing.projectId)) {
            return NextResponse.json({
                error: `The client can currently see files in this folder, and changing it to "${visibility}" would remove their access. Move those files somewhere shared first, or pass allowClientVisibilityLoss: true to do it deliberately.`,
            }, { status: 409 });
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
