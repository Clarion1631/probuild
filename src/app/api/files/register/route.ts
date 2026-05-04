import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";

export const maxDuration = 30;

type UploadedFile = {
    name: string;
    url: string;
    size: number;
    mimeType: string;
    projectId?: string;
    leadId?: string;
    folderId?: string;
    visibility?: string;
};

// POST: save DB records after the browser has uploaded files directly to Supabase.
// Hybrid auth — accepts NextAuth session (web) or mobile JWT (mobile).
export async function POST(req: NextRequest) {
    try {
        const auth = await authenticateMobileOrSession(req);
        if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
        const { user } = auth;

        const body = await req.json();
        const { files } = body as { files: UploadedFile[] };

        if (!files?.length) {
            return NextResponse.json({ error: "files required" }, { status: 400 });
        }

        // Authorize EVERY file. Without this, a caller with one valid `projectId` could
        // mass-register files against arbitrary leads/projects in the same payload. Mirror
        // the same access checks `signed-upload` enforces; reject anything orphaned.
        for (const f of files) {
            if (!f.projectId && !f.leadId) {
                return NextResponse.json(
                    { error: "Each file must have projectId or leadId" },
                    { status: 400 }
                );
            }
            if (f.projectId) {
                const allowed = await userCanAccessProject(user, f.projectId);
                if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
            if (f.leadId) {
                // ADMINs can attach files to any lead. Everyone else (including MANAGERs)
                // must be the lead's assigned manager. This is stricter than the
                // signed-upload branch on purpose — register is the side that actually
                // creates the DB row, so it's the right place to fail closed.
                if (user.role !== "ADMIN") {
                    const lead = await prisma.lead.findFirst({
                        where: { id: f.leadId, managerId: user.id },
                        select: { id: true },
                    });
                    if (!lead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
                }
            }
        }

        const created = await Promise.all(
            files.map((f: UploadedFile) =>
                prisma.projectFile.create({
                    data: {
                        name: f.name,
                        url: f.url,
                        size: f.size,
                        mimeType: f.mimeType,
                        ...(f.visibility && { visibility: f.visibility }),
                        ...(f.projectId && { projectId: f.projectId }),
                        ...(f.leadId && { leadId: f.leadId }),
                        ...(f.folderId && { folderId: f.folderId }),
                        uploadedById: user.id,
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
