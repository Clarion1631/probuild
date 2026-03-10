import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabase, STORAGE_BUCKET } from "@/lib/supabase";

// GET: list files and folders for a project or lead
export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const leadId = searchParams.get("leadId");
    const folderId = searchParams.get("folderId"); // null = root

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
    }

    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (leadId) where.leadId = leadId;

    // Get folders at this level
    const folderWhere = { ...where, parentId: folderId || null };
    const folders = await prisma.fileFolder.findMany({
        where: folderWhere,
        orderBy: { name: "asc" },
        include: {
            _count: { select: { files: true, children: true } },
        },
    });

    // Get files at this level
    const fileWhere = { ...where, folderId: folderId || null };
    const files = await prisma.projectFile.findMany({
        where: fileWhere,
        orderBy: { createdAt: "desc" },
        include: {
            uploadedBy: { select: { id: true, name: true, email: true } },
        },
    });

    return NextResponse.json({ folders, files });
}

// POST: upload file(s) to Supabase Storage
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!supabase) {
        return NextResponse.json({ error: "Storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY." }, { status: 500 });
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });

    const formData = await req.formData();
    const projectId = formData.get("projectId") as string | null;
    const leadId = formData.get("leadId") as string | null;
    const folderId = formData.get("folderId") as string | null;
    const files = formData.getAll("files") as File[];

    if (!projectId && !leadId) {
        return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
    }

    if (!files || files.length === 0) {
        return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    const created = [];

    for (const file of files) {
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // Build storage path: projects/PROJECT_ID/filename_timestamp.ext or leads/LEAD_ID/...
        const prefix = projectId ? `projects/${projectId}` : `leads/${leadId}`;
        const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `${prefix}/${Date.now()}_${safeName}`;

        // Upload to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
            });

        if (uploadError) {
            console.error("Supabase upload error:", uploadError);
            return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
        }

        // Get public URL
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
                ...(projectId && { projectId }),
                ...(leadId && { leadId }),
                ...(folderId && { folderId }),
                ...(user && { uploadedById: user.id }),
            },
            include: {
                uploadedBy: { select: { id: true, name: true, email: true } },
            },
        });

        created.push(record);
    }

    return NextResponse.json({ files: created }, { status: 201 });
}

// DELETE: delete a file or folder
export async function DELETE(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get("fileId");
    const folderId = searchParams.get("folderId");

    if (fileId) {
        // Get file URL to delete from storage
        const file = await prisma.projectFile.findUnique({ where: { id: fileId } });
        if (file && supabase) {
            // Extract storage path from URL
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
        await prisma.fileFolder.delete({ where: { id: folderId } });
        return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "fileId or folderId required" }, { status: 400 });
}
