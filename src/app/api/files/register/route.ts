import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

type UploadedFile = {
    name: string;
    url: string;
    size: number;
    mimeType: string;
    projectId?: string;
    leadId?: string;
    folderId?: string;
};

// POST: save DB records after the browser has uploaded files directly to Supabase.
export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        const body = await req.json();
        const { files } = body as { files: UploadedFile[] };

        if (!files?.length) {
            return NextResponse.json({ error: "files required" }, { status: 400 });
        }

        const created = await Promise.all(
            files.map((f: UploadedFile) =>
                prisma.projectFile.create({
                    data: {
                        name: f.name,
                        url: f.url,
                        size: f.size,
                        mimeType: f.mimeType,
                        ...(f.projectId && { projectId: f.projectId }),
                        ...(f.leadId && { leadId: f.leadId }),
                        ...(f.folderId && { folderId: f.folderId }),
                        ...(user && { uploadedById: user.id }),
                    },
                    include: { uploadedBy: { select: { id: true, name: true, email: true } } },
                })
            )
        );

        return NextResponse.json({ files: created }, { status: 201 });
    } catch (err: any) {
        console.error("POST /api/files/register error:", err);
        return NextResponse.json({ error: err.message || "Failed to register files" }, { status: 500 });
    }
}
