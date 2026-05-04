import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { userCanAccessProject } from "@/lib/mobile-auth";

// Mirror of authorizeFileScope from /api/files/route.ts. Kept inline here so the
// folders route is self-contained and can't drift out of sync silently.
async function authorize(
    email: string,
    scope: { projectId?: string | null; leadId?: string | null }
): Promise<{ user: any } | NextResponse> {
    const user = await prisma.user.findUnique({
        where: { email },
        include: { permissions: true },
    });
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (scope.projectId) {
        const ok = await userCanAccessProject(user, scope.projectId);
        if (!ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (scope.leadId) {
        if (user.role !== "ADMIN") {
            const lead = await prisma.lead.findFirst({
                where: { id: scope.leadId, managerId: user.id },
                select: { id: true },
            });
            if (!lead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    }
    return { user };
}

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

    const authResult = await authorize(session.user.email, { projectId, leadId });
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

    const authResult = await authorize(session.user.email, { projectId, leadId });
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;

    if (visibility === "financial" && !hasPermission(user, "financialReports")) {
        return NextResponse.json({ error: "No permission to create financial folders" }, { status: 403 });
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

    const authResult = await authorize(session.user.email, {
        projectId: existing.projectId,
        leadId: existing.leadId,
    });
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;

    // Modifying a financial folder requires the permission, regardless of target value.
    // Otherwise a non-financial user could downgrade a folder to "team" and silently
    // expose its inheriting children.
    if (existing.visibility === "financial" && !hasPermission(user, "financialReports")) {
        return NextResponse.json({ error: "No permission to modify financial folders" }, { status: 403 });
    }
    if (visibility === "financial" && !hasPermission(user, "financialReports")) {
        return NextResponse.json({ error: "No permission to set financial visibility" }, { status: 403 });
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
