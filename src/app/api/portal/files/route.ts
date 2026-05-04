import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getPortalVisibility } from "@/lib/actions";

// GET: list shared files for a portal client (read-only)
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const projectId = searchParams.get("projectId");
        const folderId = searchParams.get("folderId");

        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 });
        }

        const visibility = await getPortalVisibility(projectId);
        if (!visibility.isPortalEnabled || !visibility.showFiles) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }

        const staffSession = await getServerSession(authOptions);
        const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

        if (!isStaff) {
            const sessionClientId = await resolveSessionClientId();
            if (!sessionClientId) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            const project = await prisma.project.findFirst({
                where: { id: projectId, clientId: sessionClientId },
                select: { id: true },
            });
            if (!project) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
        }

        // If we're inside a folder, that folder MUST itself be "shared" — otherwise we
        // refuse to list anything from it. This is the only way to enforce inheritance
        // safely: a null-visibility file in a "team" folder must not leak out, even
        // though the file query alone can't distinguish them.
        if (folderId) {
            const parentFolder = await prisma.fileFolder.findFirst({
                where: { id: folderId, projectId, visibility: "shared" },
                select: { id: true },
            });
            if (!parentFolder) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
        }

        // Folders: only "shared" folders are listed, regardless of nesting level.
        const folders = await prisma.fileFolder.findMany({
            where: {
                projectId,
                parentId: folderId || null,
                visibility: "shared",
            },
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: {
                        // Inside a shared folder, ALL files are effectively shared
                        // (explicit "shared" + null inheriting from the folder). At the
                        // root level we only count explicit shares.
                        files: { where: { visibility: "shared" } },
                        children: true,
                    },
                },
            },
        });

        // Files: at the root, only explicit "shared". Inside a folder (which we've
        // already verified is shared above), include both explicit "shared" AND
        // null-visibility files (they inherit from the parent).
        const fileWhere: any = {
            projectId,
            folderId: folderId || null,
            ...(folderId
                ? { OR: [{ visibility: "shared" }, { visibility: null }] }
                : { visibility: "shared" }),
        };
        const files = await prisma.projectFile.findMany({
            where: fileWhere,
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                name: true,
                url: true,
                size: true,
                mimeType: true,
                createdAt: true,
            },
        });

        return NextResponse.json({ folders, files });
    } catch (err: any) {
        console.error("GET /api/portal/files error:", err);
        return NextResponse.json({ error: err.message || "Failed to list files" }, { status: 500 });
    }
}
