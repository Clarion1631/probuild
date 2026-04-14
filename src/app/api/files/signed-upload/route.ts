import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";

export const maxDuration = 30;

type FileInfo = { name: string; size: number; mimeType: string };

// POST: generate signed upload URLs so the browser can upload directly to Supabase,
// bypassing Vercel's 4.5 MB serverless payload limit.
export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const supabase = getSupabase();
        if (!supabase) {
            return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
        }

        const body = await req.json();
        const { projectId, leadId, folderId, files } = body as {
            projectId?: string;
            leadId?: string;
            folderId?: string;
            files: FileInfo[];
        };

        if (!projectId && !leadId) {
            return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
        }
        if (!files?.length) {
            return NextResponse.json({ error: "files required" }, { status: 400 });
        }

        if (projectId) {
            const callerUser = await prisma.user.findUnique({
                where: { email: session.user.email },
                select: { role: true, projectAccess: { where: { projectId }, select: { projectId: true } } },
            });
            const isAdmin = callerUser && ["ADMIN", "MANAGER"].includes(callerUser.role);
            if (!callerUser || (!isAdmin && callerUser.projectAccess.length === 0)) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }

        const uploads = await Promise.all(
            files.map(async (f: FileInfo) => {
                const prefix = projectId ? `projects/${projectId}` : `leads/${leadId}`;
                const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                const storagePath = `${prefix}/${Date.now()}_${safeName}`;

                const { data, error } = await supabase.storage
                    .from(STORAGE_BUCKET)
                    .createSignedUploadUrl(storagePath);

                if (error || !data) {
                    throw new Error(`Failed to create signed URL for ${f.name}: ${error?.message}`);
                }

                const { data: urlData } = supabase.storage
                    .from(STORAGE_BUCKET)
                    .getPublicUrl(storagePath);

                return {
                    signedUrl: data.signedUrl,
                    token: data.token,
                    storagePath,
                    publicUrl: urlData.publicUrl,
                    name: f.name,
                    size: f.size,
                    mimeType: f.mimeType,
                    projectId,
                    leadId,
                    folderId,
                };
            })
        );

        return NextResponse.json({ uploads });
    } catch (err: any) {
        console.error("POST /api/files/signed-upload error:", err);
        return NextResponse.json({ error: err.message || "Failed to create signed URLs" }, { status: 500 });
    }
}
