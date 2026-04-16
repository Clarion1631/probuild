// /api/rooms — list rooms for a project OR lead, and create a new draft.
// Owner is enforced XOR (one of projectId / leadId must be set, not both).

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildDefaultLayout, type RoomType } from "@/components/room-designer/types";
import { buildTemplateSeed, parseTemplateKey } from "@/lib/room-designer/templates";

export const dynamic = "force-dynamic";

async function getCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

async function canAccessProject(userId: string, role: string, projectId: string): Promise<boolean> {
    if (role === "ADMIN" || role === "MANAGER") return true;
    const access = await prisma.projectAccess.findFirst({
        where: { userId, projectId },
        select: { id: true },
    });
    if (access) return true;
    const crew = await prisma.project.findFirst({
        where: { id: projectId, crew: { some: { id: userId } } },
        select: { id: true },
    });
    return !!crew;
}

async function canAccessLead(userId: string, role: string, leadId: string): Promise<boolean> {
    if (role === "ADMIN" || role === "MANAGER") return true;
    // Non-admin/manager users can see leads they manage.
    const lead = await prisma.lead.findFirst({
        where: { id: leadId, managerId: userId },
        select: { id: true },
    });
    return !!lead;
}

export async function GET(req: Request) {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const leadId = searchParams.get("leadId");

    if (!!projectId === !!leadId) {
        return NextResponse.json(
            { error: "Provide exactly one of projectId or leadId" },
            { status: 400 },
        );
    }

    if (projectId && !(await canAccessProject(caller.id, caller.role, projectId))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (leadId && !(await canAccessLead(caller.id, caller.role, leadId))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rooms = await prisma.roomDesign.findMany({
        where: projectId ? { projectId } : { leadId: leadId! },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            name: true,
            roomType: true,
            thumbnail: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    return NextResponse.json(rooms);
}

export async function POST(req: Request) {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let body: {
        name?: string;
        roomType?: RoomType;
        projectId?: string;
        leadId?: string;
        templateKey?: string;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { name, roomType, projectId, leadId, templateKey } = body;
    if (!!projectId === !!leadId) {
        return NextResponse.json(
            { error: "Exactly one of projectId or leadId is required" },
            { status: 400 },
        );
    }

    if (projectId && !(await canAccessProject(caller.id, caller.role, projectId))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (leadId && !(await canAccessLead(caller.id, caller.role, leadId))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Resolve template (if any). Template-provided roomType overrides the
    // body roomType so pickers can't land a "master_bath" template into a
    // kitchen slot by accident.
    const tKey = parseTemplateKey(templateKey);
    const seed = tKey ? buildTemplateSeed(tKey) : null;

    const validRoomTypes: RoomType[] = ["kitchen", "bathroom", "laundry", "bedroom", "other"];
    const rt: RoomType = seed
        ? seed.roomType
        : roomType && validRoomTypes.includes(roomType)
            ? roomType
            : "kitchen";

    const layoutJson = seed ? seed.layout : buildDefaultLayout();

    // Nested create + createMany keeps the insert atomic at the driver level
    // without an interactive $transaction callback (incompatible with the
    // Supabase PgBouncer pooler per CLAUDE.md).
    const room = await prisma.roomDesign.create({
        data: {
            name: (name ?? "New Room").slice(0, 120),
            roomType: rt,
            projectId: projectId ?? null,
            leadId: leadId ?? null,
            layoutJson: layoutJson as any,
            assets: seed && seed.assets.length > 0
                ? {
                    createMany: {
                        data: seed.assets.map((a) => ({
                            assetType: a.assetType,
                            assetId: a.assetId,
                            positionX: a.position.x,
                            positionY: a.position.y,
                            positionZ: a.position.z,
                            rotationY: a.rotationY,
                            scaleX: a.scale.x,
                            scaleY: a.scale.y,
                            scaleZ: a.scale.z,
                            // Prisma InputJsonValue rejects plain Record<string, unknown>;
                            // mirrors the layoutJson cast above.
                            metadata: (a.metadata ?? undefined) as any,
                        })),
                    },
                }
                : undefined,
        },
    });

    return NextResponse.json(room, { status: 201 });
}
