// /api/rooms — list rooms for a project OR lead, and create a new draft.
// Owner is enforced XOR (one of projectId / leadId must be set, not both).

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emptyDoc, emptyOutdoorDoc, toApiPayload } from "@/lib/studio/doc";
import { resolveTemplate, type RoomType } from "@/lib/studio/templates";

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
    const template = resolveTemplate(templateKey);

    const validRoomTypes: RoomType[] = ["kitchen", "bathroom", "laundry", "bedroom", "outdoor", "other"];
    const rt: RoomType = template
        ? template.roomType
        : roomType && validRoomTypes.includes(roomType)
            ? roomType
            : "kitchen";

    // Blank outdoor rooms start as a fenced grass yard, not an indoor box.
    const seedDoc = template ? template.build() : rt === "outdoor" ? emptyOutdoorDoc() : emptyDoc();
    const payload = toApiPayload(seedDoc);

    // Nested create + createMany keeps the insert atomic at the driver level
    // without an interactive $transaction callback (incompatible with the
    // Supabase PgBouncer pooler per CLAUDE.md).
    const room = await prisma.roomDesign.create({
        data: {
            name: (name ?? "New Room").slice(0, 120),
            roomType: rt,
            projectId: projectId ?? null,
            leadId: leadId ?? null,
            layoutJson: payload.layoutJson as any,
            assets: payload.assets.length > 0
                ? {
                    createMany: {
                        data: payload.assets.map((a) => ({
                            assetType: a.assetType,
                            assetId: a.assetId,
                            positionX: a.positionX,
                            positionY: a.positionY,
                            positionZ: a.positionZ,
                            rotationY: a.rotationY,
                            scaleX: a.scaleX,
                            scaleY: a.scaleY,
                            scaleZ: a.scaleZ,
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
