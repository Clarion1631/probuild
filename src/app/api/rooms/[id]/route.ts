// /api/rooms/[id] — load, save, delete a single room.
//
// PUT accepts { layoutJson, assets[] } and replaces the assets array atomically.
// shareToken / shareEnabled are intentionally stripped here — those live on
// the schema for Stage 4 (client share links) but there's no route wired up
// to generate tokens yet, so accepting them from the client would silently
// flip a room to shared state.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { DbRoomAsset } from "@/lib/room-designer/blueprint3d-adapter";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ id: string }> }

async function getCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

async function canAccessRoom(userId: string, role: string, roomId: string): Promise<{
    room: { id: string; projectId: string | null; leadId: string | null } | null;
    allowed: boolean;
}> {
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

export async function GET(_req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { room, allowed } = await canAccessRoom(caller.id, caller.role, id);
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const full = await prisma.roomDesign.findUnique({
        where: { id },
        include: { assets: true },
    });
    return NextResponse.json(full);
}

export async function PUT(req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { allowed, room } = await canAccessRoom(caller.id, caller.role, id);
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: {
        layoutJson?: unknown;
        assets?: Array<Partial<DbRoomAsset> & { id?: string }>;
        name?: string;
        roomType?: string;
        // TODO (Stage 4): `shareToken` and `shareEnabled` are explicitly stripped
        // here. Only a dedicated /api/rooms/[id]/share endpoint (not yet built)
        // should mutate those fields.
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const updates: {
        layoutJson?: any;
        name?: string;
        roomType?: string;
    } = {};
    if (body.layoutJson !== undefined) updates.layoutJson = body.layoutJson as any;
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.slice(0, 120);
    if (typeof body.roomType === "string") {
        const validRoomTypes = ["kitchen", "bathroom", "laundry", "bedroom", "other"];
        if (!validRoomTypes.includes(body.roomType)) {
            return NextResponse.json({ error: "Invalid roomType" }, { status: 400 });
        }
        updates.roomType = body.roomType;
    }

    const assetsInput = Array.isArray(body.assets) ? body.assets : null;

    const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.roomDesign.update({
            where: { id },
            data: updates,
        });
        if (assetsInput) {
            // Replace-all strategy: delete existing assets for this room, recreate from payload.
            // Simpler than diffing and matches the autosave-the-whole-scene model.
            await tx.roomAsset.deleteMany({ where: { roomDesignId: id } });
            if (assetsInput.length > 0) {
                await tx.roomAsset.createMany({
                    data: assetsInput.map((a) => ({
                        roomDesignId: id,
                        assetType: String(a.assetType ?? "cabinet"),
                        assetId: String(a.assetId ?? ""),
                        positionX: Number(a.positionX ?? 0),
                        positionY: Number(a.positionY ?? 0),
                        positionZ: Number(a.positionZ ?? 0),
                        rotationY: Number(a.rotationY ?? 0),
                        scaleX: Number(a.scaleX ?? 1),
                        scaleY: Number(a.scaleY ?? 1),
                        scaleZ: Number(a.scaleZ ?? 1),
                        metadata: (a.metadata ?? null) as any,
                    })),
                });
            }
        }
        return updated;
    });

    return NextResponse.json(result);
}

export async function DELETE(_req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { allowed, room } = await canAccessRoom(caller.id, caller.role, id);
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    await prisma.roomDesign.delete({ where: { id } });
    return NextResponse.json({ success: true });
}
