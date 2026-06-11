// /api/mobile/leads/[id]/drive-video — big-file (video) uploads go straight
// from the phone to the lead's Google Drive folder.
//
// POST {action:"session", name, mimeType, size} -> {uploadUrl, folderUrl}
//   The app PUTs the bytes to uploadUrl (Google resumable session). Google's
//   final response body is the file resource ({id,...}).
// POST {action:"register", driveFileId} -> creates the ProjectFile row so the
//   video shows on the lead in the web app (links to Drive).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { assertLeadAccess } from "@/lib/lead-access";
import { createResumableSession, ensureLeadFolder, getFileMeta, DriveNotConnectedError } from "@/lib/lead-drive";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id } = await params;

    const fail = await assertLeadAccess(auth.user, id);
    if (fail) return fail;

    let body: { action?: unknown; name?: unknown; mimeType?: unknown; size?: unknown; driveFileId?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
        if (body.action === "session") {
            const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : `video_${Date.now()}.mov`;
            const mimeType = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : "video/quicktime";
            const size = typeof body.size === "number" && body.size > 0 ? Math.floor(body.size) : undefined;

            const folder = await ensureLeadFolder(id);
            const uploadUrl = await createResumableSession({ folderId: folder.folderId, name, mimeType, size });
            return NextResponse.json({ uploadUrl, folderUrl: folder.url });
        }

        if (body.action === "register") {
            const driveFileId = typeof body.driveFileId === "string" ? body.driveFileId : "";
            if (!driveFileId) return NextResponse.json({ error: "driveFileId required" }, { status: 400 });

            const meta = await getFileMeta(driveFileId);
            const file = await prisma.projectFile.create({
                data: {
                    name: meta.name,
                    url: meta.webViewLink,
                    mimeType: meta.mimeType,
                    size: meta.size ?? 0,
                    leadId: id,
                    uploadedById: auth.user.id,
                },
                select: { id: true, name: true, url: true, mimeType: true, size: true, createdAt: true },
            });
            await prisma.lead.update({ where: { id }, data: { lastActivityAt: new Date() } });
            return NextResponse.json({ file }, { status: 201 });
        }

        return NextResponse.json({ error: "action must be 'session' or 'register'" }, { status: 400 });
    } catch (e) {
        if (e instanceof DriveNotConnectedError) {
            return NextResponse.json({ error: e.message }, { status: 409 });
        }
        console.error("[drive-video] failed:", e);
        return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 200) : "Drive error" }, { status: 502 });
    }
}
