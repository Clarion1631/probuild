// /api/rooms/[id]/share — enable or revoke the public share link for a room.
//
// POST generates a token if one doesn't already exist and flips shareEnabled
// on. Calling POST on an already-shared room is idempotent — we keep the old
// token so existing links keep working.
//
// DELETE flips shareEnabled off. The token is preserved so that toggling it
// back on re-activates the same link (matches how Figma / Google Docs
// "unshare" works). Use /share/regenerate to actively rotate the token.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildShareUrl } from "@/lib/room-designer/share-url";
import { generateShareToken } from "@/lib/room-designer/share-token";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ id: string }> }

async function getCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

// Mirrors the guard in /api/rooms/[id]/route.ts. Kept local so the share
// routes don't import from that file (which would drag route.ts exports in
// via the same module graph).
async function canAccessRoom(userId: string, role: string, roomId: string) {
    const room = await prisma.roomDesign.findUnique({
        where: { id: roomId },
        select: { id: true, projectId: true, leadId: true },
    });
    if (!room) return { room: null, allowed: false };
    if (role === "ADMIN" || role === "MANAGER") return { room, allowed: true };
    if (room.projectId) {
        const pa = await prisma.projectAccess.findFirst({
            where: { userId, projectId: room.projectId },
            select: { id: true },
        });
        if (pa) return { room, allowed: true };
        const crew = await prisma.project.findFirst({
            where: { id: room.projectId, crew: { some: { id: userId } } },
            select: { id: true },
        });
        return { room, allowed: !!crew };
    }
    if (room.leadId) {
        const lead = await prisma.lead.findFirst({
            where: { id: room.leadId, managerId: userId },
            select: { id: true },
        });
        return { room, allowed: !!lead };
    }
    return { room, allowed: false };
}

export async function POST(_req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { room, allowed } = await canAccessRoom(caller.id, caller.role, id);
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const existing = await prisma.roomDesign.findUnique({
        where: { id },
        select: { shareToken: true },
    });

    const token = existing?.shareToken ?? generateShareToken();
    await prisma.roomDesign.update({
        where: { id },
        data: { shareToken: token, shareEnabled: true },
    });

    return NextResponse.json({ token, url: buildShareUrl(token), enabled: true });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { room, allowed } = await canAccessRoom(caller.id, caller.role, id);
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    await prisma.roomDesign.update({
        where: { id },
        data: { shareEnabled: false },
    });

    return NextResponse.json({ enabled: false });
}
