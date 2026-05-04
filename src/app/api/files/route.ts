import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { hasPermission } from "@/lib/permissions";
import { userCanAccessProject } from "@/lib/mobile-auth";

export const maxDuration = 60;

type FileWithFolder = {
    id: string;
    visibility: string | null;
    folder?: { visibility: string } | null;
    [key: string]: any;
};

function effectiveVisibility(file: FileWithFolder): string {
    return file.visibility ?? file.folder?.visibility ?? "team";
}

// Authorize the caller against either a project (via ProjectAccess/crew/admin)
// or a lead (admin or assigned manager). Returns the user record on success
// or a NextResponse on failure.
async function authorizeFileScope(
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
            if (!lead && user.role !== "MANAGER") {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
            // MANAGERs without lead assignment also blocked, mirroring register's stricter rule
            if (!lead && user.role === "MANAGER") {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }
    }
    return { user };
}

// GET: list files and folders for a project or lead
export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const projectId = searchParams.get("projectId");
        const leadId = searchParams.get("leadId");
        const folderId = searchParams.get("folderId");
        const visibilityFilter = searchParams.get("visibility");

        if (!projectId && !leadId) {
            return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
        }

        const authResult = await authorizeFileScope(session.user.email, { projectId, leadId });
        if (authResult instanceof NextResponse) return authResult;
        const { user: callerUser } = authResult;

        const canSeeFinancial = hasPermission(callerUser, "financialReports");

        const where: any = {};
        if (projectId) where.projectId = projectId;
        if (leadId) where.leadId = leadId;

        // Build folder visibility predicate as a single AND so future changes can't
        // accidentally drop the financial exclusion.
        const folderConditions: any[] = [{ ...where, parentId: folderId || null }];
        if (visibilityFilter) {
            folderConditions.push({ visibility: visibilityFilter });
        }
        if (!canSeeFinancial) {
            folderConditions.push({ visibility: { not: "financial" } });
        }
        const folders = await prisma.fileFolder.findMany({
            where: { AND: folderConditions },
            orderBy: { name: "asc" },
            include: { _count: { select: { files: true, children: true } } },
        });

        const fileWhere: any = { ...where, folderId: folderId || null };
        const files = await prisma.projectFile.findMany({
            where: fileWhere,
            orderBy: { createdAt: "desc" },
            include: {
                uploadedBy: { select: { id: true, name: true, email: true } },
                folder: { select: { visibility: true } },
            },
        });

        const filtered = files.filter((f: FileWithFolder) => {
            const eff = effectiveVisibility(f);
            if (!canSeeFinancial && eff === "financial") return false;
            if (visibilityFilter && eff !== visibilityFilter) return false;
            return true;
        });

        const filesWithEffective = filtered.map((f: FileWithFolder) => ({
            ...f,
            effectiveVisibility: effectiveVisibility(f),
        }));

        return NextResponse.json({ folders, files: filesWithEffective });
    } catch (err: any) {
        console.error("GET /api/files error:", err);
        return NextResponse.json({ error: err.message || "Failed to list files" }, { status: 500 });
    }
}

// POST: upload file(s) to Supabase Storage
export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Not signed in. Please sign in and try again." }, { status: 401 });
        }

        const supabase = getSupabase();
        if (!supabase) {
            return NextResponse.json({ error: "Storage not configured. Contact admin to set SUPABASE_URL and SUPABASE_SERVICE_KEY." }, { status: 500 });
        }

        let formData;
        try {
            formData = await req.formData();
        } catch (parseErr: any) {
            console.error("FormData parse error:", parseErr);
            return NextResponse.json({ error: `File too large or invalid: ${parseErr.message}` }, { status: 413 });
        }

        const projectId = formData.get("projectId") as string | null;
        const leadId = formData.get("leadId") as string | null;
        const folderId = formData.get("folderId") as string | null;
        const visibility = formData.get("visibility") as string | null;
        const files = formData.getAll("files") as File[];

        if (!projectId && !leadId) {
            return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
        }

        const authResult = await authorizeFileScope(session.user.email, { projectId, leadId });
        if (authResult instanceof NextResponse) return authResult;
        const { user } = authResult;

        if (visibility === "financial" && !hasPermission(user, "financialReports")) {
            return NextResponse.json({ error: "No permission to create financial files" }, { status: 403 });
        }

        if (!files || files.length === 0) {
            return NextResponse.json({ error: "No files selected" }, { status: 400 });
        }

        const ALLOWED_EXTENSIONS = new Set([
            ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv",
            ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
            ".txt", ".rtf", ".dwg", ".dxf",
        ]);
        for (const file of files) {
            const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
            if (!ALLOWED_EXTENSIONS.has(ext)) {
                return NextResponse.json({ error: `File type not allowed: ${ext || "(no extension)"}. Allowed: PDF, Word, Excel, images.` }, { status: 400 });
            }
        }

        const created = [];

        for (const file of files) {
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);

            const prefix = projectId ? `projects/${projectId}` : `leads/${leadId}`;
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const storagePath = `${prefix}/${Date.now()}_${safeName}`;

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

            const { data: urlData } = supabase.storage
                .from(STORAGE_BUCKET)
                .getPublicUrl(storagePath);

            const publicUrl = urlData?.publicUrl || storagePath;

            const record = await prisma.projectFile.create({
                data: {
                    name: file.name,
                    url: publicUrl,
                    size: buffer.length,
                    mimeType: file.type || "application/octet-stream",
                    ...(visibility && { visibility }),
                    ...(projectId && { projectId }),
                    ...(leadId && { leadId }),
                    ...(folderId && { folderId }),
                    uploadedById: user.id,
                },
                include: { uploadedBy: { select: { id: true, name: true, email: true } } },
            });

            created.push(record);
        }

        return NextResponse.json({ files: created }, { status: 201 });
    } catch (err: any) {
        console.error("POST /api/files error:", err);
        return NextResponse.json({ error: err.message || "Upload failed unexpectedly" }, { status: 500 });
    }
}

// PATCH: move file, rename, or change visibility
export async function PATCH(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { fileId, folderId, name, visibility } = body;

        if (!fileId) {
            return NextResponse.json({ error: "fileId required" }, { status: 400 });
        }

        // Load the existing file FIRST so we can authorize against its actual scope
        // and current state. Without this, a caller could mutate any file by guessing IDs.
        const existing = await prisma.projectFile.findUnique({
            where: { id: fileId },
            include: { folder: { select: { visibility: true } } },
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

        // Read protection: a financial file (by effective visibility) requires the
        // permission to mutate at all. Otherwise an unprivileged caller could downgrade
        // it to "shared" or "team" and bypass the gate.
        const currentEff = effectiveVisibility(existing);
        if (currentEff === "financial" && !hasPermission(user, "financialReports")) {
            return NextResponse.json({ error: "No permission to modify financial files" }, { status: 403 });
        }

        // Setting financial requires the permission too.
        if (visibility === "financial" && !hasPermission(user, "financialReports")) {
            return NextResponse.json({ error: "No permission to set financial visibility" }, { status: 403 });
        }

        const updateData: any = {};
        if (folderId !== undefined) updateData.folderId = folderId || null;
        if (name) updateData.name = name;
        if (visibility !== undefined) updateData.visibility = visibility;

        const file = await prisma.projectFile.update({
            where: { id: fileId },
            data: updateData,
            include: {
                uploadedBy: { select: { id: true, name: true, email: true } },
                folder: { select: { visibility: true } },
            },
        });

        return NextResponse.json({
            ...file,
            effectiveVisibility: effectiveVisibility(file),
        });
    } catch (err: any) {
        console.error("PATCH /api/files error:", err);
        return NextResponse.json({ error: err.message || "Update failed" }, { status: 500 });
    }
}

// DELETE: delete a file or folder
export async function DELETE(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const fileId = searchParams.get("fileId");
        const folderId = searchParams.get("folderId");

        if (fileId) {
            const file = await prisma.projectFile.findUnique({
                where: { id: fileId },
                include: { folder: { select: { visibility: true } } },
            });
            if (!file) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }

            const authResult = await authorizeFileScope(session.user.email, {
                projectId: file.projectId,
                leadId: file.leadId,
            });
            if (authResult instanceof NextResponse) return authResult;
            const { user } = authResult;

            // Financial files require the permission to delete (same protection as PATCH).
            const currentEff = effectiveVisibility(file);
            if (currentEff === "financial" && !hasPermission(user, "financialReports")) {
                return NextResponse.json({ error: "No permission to delete financial files" }, { status: 403 });
            }

            const supabase = getSupabase();
            if (supabase) {
                const url = file.url;
                const bucketPrefix = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
                const pathIdx = url.indexOf(bucketPrefix);
                if (pathIdx >= 0) {
                    const storagePath = url.substring(pathIdx + bucketPrefix.length);
                    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
                }
            }
            await prisma.projectFile.delete({ where: { id: fileId } });
            return NextResponse.json({ success: true });
        }

        if (folderId) {
            const folder = await prisma.fileFolder.findUnique({
                where: { id: folderId },
                select: { id: true, projectId: true, leadId: true, visibility: true },
            });
            if (!folder) {
                return NextResponse.json({ error: "Not found" }, { status: 404 });
            }

            const authResult = await authorizeFileScope(session.user.email, {
                projectId: folder.projectId,
                leadId: folder.leadId,
            });
            if (authResult instanceof NextResponse) return authResult;
            const { user } = authResult;

            if (folder.visibility === "financial" && !hasPermission(user, "financialReports")) {
                return NextResponse.json({ error: "No permission to delete financial folders" }, { status: 403 });
            }

            await prisma.fileFolder.delete({ where: { id: folderId } });
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "fileId or folderId required" }, { status: 400 });
    } catch (err: any) {
        console.error("DELETE /api/files error:", err);
        return NextResponse.json({ error: err.message || "Delete failed" }, { status: 500 });
    }
}
