// /api/rooms/scan-import — create a RoomDesign from a LiDAR room scan.
//
// Called by the ProBuild mobile app after an iPhone RoomPlan capture (or by
// the web app with a pasted scan JSON). Accepts either the app's simplified
// shape or a raw Apple RoomPlan CapturedRoom export — see lib/studio/scan-import.
//
// Auth: mobile JWT (Authorization: Bearer) or a normal web session.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject, userHasRole } from "@/lib/mobile-auth";
import { scanToDoc, ScanImportError } from "@/lib/studio/scan-import";
import { toApiPayload } from "@/lib/studio/doc";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const user = auth.user;

    let body: {
        projectId?: string;
        leadId?: string;
        name?: string;
        scan?: unknown;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { projectId, leadId } = body;
    if (!!projectId === !!leadId) {
        return NextResponse.json({ error: "Exactly one of projectId or leadId is required" }, { status: 400 });
    }
    if (!body.scan || typeof body.scan !== "object") {
        return NextResponse.json({ error: "Missing scan payload" }, { status: 400 });
    }

    if (projectId) {
        const ok = await userCanAccessProject(user, projectId);
        if (!ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (leadId) {
        if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
            const lead = await prisma.lead.findFirst({
                where: { id: leadId, managerId: user.id },
                select: { id: true },
            });
            if (!lead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    }

    let doc;
    try {
        doc = scanToDoc(body.scan);
    } catch (err) {
        if (err instanceof ScanImportError) {
            return NextResponse.json({ error: err.message }, { status: 422 });
        }
        throw err;
    }

    const payload = toApiPayload(doc);
    const room = await prisma.roomDesign.create({
        data: {
            name: (body.name ?? "Scanned Room").slice(0, 120),
            roomType: "other",
            projectId: projectId ?? null,
            leadId: leadId ?? null,
            layoutJson: payload.layoutJson as never,
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
                            metadata: (a.metadata ?? undefined) as never,
                        })),
                    },
                }
                : undefined,
        },
    });

    const editorPath = projectId
        ? `/projects/${projectId}/room-designer/${room.id}`
        : `/leads/${leadId}/room-designer/${room.id}`;

    return NextResponse.json({ id: room.id, name: room.name, editorPath }, { status: 201 });
}
