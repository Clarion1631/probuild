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

        // Check if files are enabled in portal visibility
        const visibility = await getPortalVisibility(projectId);
        if (!visibility.isPortalEnabled || !visibility.showFiles) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }

        // Staff preview: ADMIN/MANAGER bypass client ownership check
        const staffSession = await getServerSession(authOptions);
        const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

        if (!isStaff) {
            const sessionClientId = await resolveSessionClientId();
            if (!sessionClientId) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            // Verify client owns this project
            const project = await prisma.project.findFirst({
                where: { id: projectId, clientId: sessionClientId },
                select: { id: true },
            });
            if (!project) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
        }

        // Only return "shared" folders
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
                        files: { where: { OR: [{ visibility: "shared" }, { visibility: null }] } },
                        children: true,
                    },
                },
            },
        });

        // Return files that are effectively "shared":
        // 1. Explicitly shared files
        // 2. Files with null visibility inside shared folders
        const files = await prisma.projectFile.findMany({
            where: {
                projectId,
                folderId: folderId || null,
                OR: [
                    { visibility: "shared" },
                    ...(folderId ? [{ visibility: null }] : []),
                ],
            },
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
