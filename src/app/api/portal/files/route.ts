import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isAncestorChainShared } from "@/lib/file-auth";
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

        if (folderId) {
            // Check if folderId is a Google Drive folder ID
            if (folderId.startsWith("gd_")) {
                const { listDriveFiles } = await import("@/lib/google-drive");
                const driveFiles = await listDriveFiles(projectId, folderId);
                return NextResponse.json(driveFiles);
            }

            // Check if folderId is the Google Drive Client Shared Folder in Prisma
            const dbFolder = await prisma.fileFolder.findUnique({
                where: { id: folderId },
                select: { name: true }
            });

            if (dbFolder && dbFolder.name.includes("Google Drive - Client Shared Folder")) {
                const { listDriveFiles } = await import("@/lib/google-drive");
                const driveFiles = await listDriveFiles(projectId, null);
                return NextResponse.json(driveFiles);
            }

            const allShared = await isAncestorChainShared(folderId, projectId);
            if (!allShared) {
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
