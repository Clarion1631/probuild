import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";

const MAX_DEPTH = 50;

export async function authorizeFileScope(
    email: string,
    scope: { projectId?: string | null; leadId?: string | null }
): Promise<{ user: any } | NextResponse> {
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
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

/**
 * Would un-sharing this folder take away files the client can currently see?
 *
 * The portal shows a file inside a folder when the file's own visibility is
 * "shared" or null AND every folder above it is "shared" (see api/portal/files +
 * isAncestorChainShared). So flipping ONE folder off can hide files several
 * levels down, including files explicitly marked "shared" — which is exactly the
 * silent un-sharing the signed-documents work exists to prevent.
 *
 * Only descends through children that are themselves currently "shared": an
 * already-unshared subtree is unreachable either way, so it cannot lose access.
 * Bounded so a deep or cyclic tree cannot run away.
 */
export async function folderSubtreeExposesFiles(
    folderId: string,
    projectId: string,
): Promise<boolean> {
    const MAX_FOLDERS = 500;
    const seen = new Set<string>([folderId]);
    let frontier: string[] = [folderId];

    while (frontier.length > 0 && seen.size <= MAX_FOLDERS) {
        const exposed = await prisma.projectFile.count({
            where: {
                projectId,
                folderId: { in: frontier },
                OR: [{ visibility: "shared" }, { visibility: null }],
            },
        });
        if (exposed > 0) return true;

        const children = await prisma.fileFolder.findMany({
            where: { parentId: { in: frontier }, visibility: "shared", projectId },
            select: { id: true },
        });
        frontier = children.map(child => child.id).filter(id => !seen.has(id));
        frontier.forEach(id => seen.add(id));
    }
    return false;
}
