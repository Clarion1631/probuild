// /api/rooms/[id]/share/regenerate — rotate the share token.
//
// POST generates a fresh token and replaces the existing one. This is the
// "invalidate any link someone else has forwarded" escape hatch. shareEnabled
// is NOT flipped — if the link was disabled, it stays disabled with a new
// (latent) token.

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

async function canAccessRoom(userId: string, role: string, roomId: string) {
    const room = await prisma.roomDesign.findUnique({
        where: { id: roomId },
        select: { id: true, projectId: true, leadId: true, shareEnabled: true },
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

    const token = generateShareToken();
    await prisma.roomDesign.update({
        where: { id },
        data: { shareToken: token },
    });
    return NextResponse.json({ token, url: buildShareUrl(token), enabled: room.shareEnabled });
}
