import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

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

// POST: upload file(s)
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    // Ensure upload directory exists
    const uploadDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadDir, { recursive: true });

    const created = [];

    for (const file of files) {
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // Create unique filename
        const ext = path.extname(file.name);
        const baseName = path.basename(file.name, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
        const uniqueName = `${baseName}_${Date.now()}${ext}`;
        const filePath = path.join(uploadDir, uniqueName);

        await writeFile(filePath, buffer);

        const record = await prisma.projectFile.create({
            data: {
                name: file.name,
                url: `/uploads/${uniqueName}`,
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

// DELETE: delete a file
export async function DELETE(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get("fileId");
    const folderId = searchParams.get("folderId");

    if (fileId) {
        await prisma.projectFile.delete({ where: { id: fileId } });
        return NextResponse.json({ success: true });
    }

    if (folderId) {
        await prisma.fileFolder.delete({ where: { id: folderId } });
        return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "fileId or folderId required" }, { status: 400 });
}
