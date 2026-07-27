import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isAncestorChainShared } from "@/lib/file-auth";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getPortalVisibility, logActivity } from "@/lib/actions";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { PORTAL_UPLOAD_EXTENSIONS } from "@/lib/project-files";
import { sendNotification } from "@/lib/email";

export const maxDuration = 30;

// Matches the MAX_SINGLE_FILE_BYTES precedent used for email attachments in
// actions.ts — the closest existing "one file" size cap in this codebase.
const PORTAL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const DESIGN_FILES_FOLDER_NAME = "Design Files";

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

        let leadId: string | null = null;

        if (!isStaff) {
            const sessionClientId = await resolveSessionClientId();
            if (!sessionClientId) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            const project = await prisma.project.findFirst({
                where: { id: projectId, clientId: sessionClientId },
                select: { id: true, leadId: true },
            });
            if (!project) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            leadId = project.leadId;
        } else {
            const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { leadId: true },
            });
            leadId = project?.leadId || null;
        }

        if (folderId) {
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
            folderId: folderId || null,
            ...(leadId
                ? { OR: [{ projectId }, { leadId }] }
                : { projectId }),
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

// POST: client uploads a file from the portal Files tab. Lands in the project's
// "Design Files" shared folder by default (find-or-create), or into another
// folder the client explicitly targets — but ONLY if that folder's full ancestor
// chain is "shared" visibility (a client can never write into a team/financial
// folder by guessing a folderId).
export async function POST(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const projectIdQuery = searchParams.get("projectId");

        const supabase = getSupabase();
        if (!supabase) {
            return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
        }

        let formData;
        try {
            formData = await req.formData();
        } catch (parseErr: any) {
            return NextResponse.json({ error: `File too large or invalid: ${parseErr.message}` }, { status: 413 });
        }

        const projectId = (formData.get("projectId") as string | null) || projectIdQuery;
        const folderId = formData.get("folderId") as string | null;
        const file = formData.get("file") as File | null;

        if (!projectId) {
            return NextResponse.json({ error: "projectId required" }, { status: 400 });
        }
        if (!file) {
            return NextResponse.json({ error: "file required" }, { status: 400 });
        }

        const visibility = await getPortalVisibility(projectId);
        if (!visibility.isPortalEnabled || !visibility.showFiles) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }

        const staffSession = await getServerSession(authOptions);
        const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

        let client: { id: string; name: string; email: string | null } | null = null;
        if (!isStaff) {
            const sessionClientId = await resolveSessionClientId();
            if (!sessionClientId) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            const project = await prisma.project.findFirst({
                where: { id: projectId, clientId: sessionClientId },
                select: { client: { select: { id: true, name: true, email: true } } },
            });
            if (!project) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }
            client = project.client;
        } else {
            const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { client: { select: { id: true, name: true, email: true } } },
            });
            client = project?.client ?? null;
        }

        const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
        if (!PORTAL_UPLOAD_EXTENSIONS.has(ext)) {
            return NextResponse.json({ error: `File type not allowed: ${ext || "(no extension)"}.` }, { status: 400 });
        }
        if (file.size > PORTAL_UPLOAD_MAX_BYTES) {
            return NextResponse.json({ error: "File is too large (8 MB max)." }, { status: 413 });
        }

        // Resolve the target folder: client-specified folderId must be shared
        // (full ancestor chain), otherwise default to the "Design Files" folder
        // (find-or-create at the project root, visibility "shared").
        let targetFolderId: string;
        if (folderId) {
            const allShared = await isAncestorChainShared(folderId, projectId);
            if (!allShared) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
            targetFolderId = folderId;
        } else {
            let folder = await prisma.fileFolder.findFirst({
                where: { projectId, name: DESIGN_FILES_FOLDER_NAME, parentId: null, visibility: "shared" },
            });
            if (!folder) {
                folder = await prisma.fileFolder.create({
                    data: { projectId, name: DESIGN_FILES_FOLDER_NAME, visibility: "shared" },
                });
            }
            targetFolderId = folder.id;
        }

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `projects/${projectId}/portal-uploads/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
            });
        if (uploadError) {
            console.error("Supabase upload error:", uploadError);
            return NextResponse.json({ error: `Storage upload failed: ${uploadError.message}` }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
        const publicUrl = urlData?.publicUrl || storagePath;

        const record = await prisma.projectFile.create({
            data: {
                name: file.name,
                url: publicUrl,
                size: buffer.length,
                mimeType: file.type || "application/octet-stream",
                visibility: "shared",
                projectId,
                folderId: targetFolderId,
                uploadedByClient: true,
            },
        });

        // Notify the team + activity log — same "client did something" pattern
        // as submitSelectionProposal.
        try {
            const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
            const settings = await prisma.companySettings.findUnique({
                where: { id: "singleton" },
                select: { notificationEmail: true },
            });
            if (settings?.notificationEmail) {
                await sendNotification(
                    settings.notificationEmail,
                    `📎 Client uploaded a file — ${project?.name || "Project"}`,
                    `<div style="font-family: sans-serif; color: #333;">
                        <h3>New Design File From Client</h3>
                        <p><strong>${client?.name || "Client"}</strong> uploaded <strong>${file.name}</strong> to project <strong>${project?.name || ""}</strong>.</p>
                        <p>It's in the "${DESIGN_FILES_FOLDER_NAME}" folder on the project's Files tab.</p>
                    </div>`
                );
            }
        } catch (notifyErr) {
            console.error("[portal files POST] notify failed:", notifyErr);
        }

        await logActivity({
            projectId,
            actorType: "CLIENT",
            actorName: client?.name || "Client",
            action: "uploaded_file",
            entityType: "ProjectFile",
            entityId: record.id,
            entityName: file.name,
        });

        return NextResponse.json({ file: record }, { status: 201 });
    } catch (err: any) {
        console.error("POST /api/portal/files error:", err);
        return NextResponse.json({ error: err.message || "Upload failed" }, { status: 500 });
    }
}
