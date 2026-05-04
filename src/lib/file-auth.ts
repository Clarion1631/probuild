import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";

const MAX_DEPTH = 50;

export async function authorizeFileScope(
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
            if (!lead) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }
    }
    return { user };
}

export async function isAncestorFinancial(folderId: string | null): Promise<boolean> {
    let currentId = folderId;
    const seen = new Set<string>();

    while (currentId) {
        if (seen.has(currentId)) return true;
        seen.add(currentId);
        if (seen.size > MAX_DEPTH) return true;

        const folder = await prisma.fileFolder.findUnique({
            where: { id: currentId },
            select: { visibility: true, parentId: true },
        });
        if (!folder) return true;
        if (folder.visibility === "financial") return true;
        currentId = folder.parentId;
    }
    return false;
}

export async function isAncestorChainShared(folderId: string, projectId: string): Promise<boolean> {
    let currentId: string | null = folderId;
    const seen = new Set<string>();

    while (currentId) {
        if (seen.has(currentId)) return false;
        seen.add(currentId);
        if (seen.size > MAX_DEPTH) return false;

        const folder: { visibility: string | null; parentId: string | null; projectId: string | null } | null =
            await prisma.fileFolder.findUnique({
                where: { id: currentId },
                select: { visibility: true, parentId: true, projectId: true },
            });
        if (!folder || folder.projectId !== projectId) return false;
        if (folder.visibility !== "shared") return false;
        currentId = folder.parentId;
    }
    return true;
}
