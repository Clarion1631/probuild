// /api/share/[token] — public, no-auth read of a shared room.
//
// This is what the /share/room/[token] page (and its client viewer) pulls
// from. Returns a sanitized payload — project/lead identifiers and manager
// data are stripped so we don't inadvertently leak tenancy metadata to
// whomever holds the token.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidShareToken } from "@/lib/room-designer/share-url";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ token: string }> }

export async function GET(_req: Request, { params }: RouteParams) {
    const { token } = await params;
    if (!isValidShareToken(token)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const room = await prisma.roomDesign.findFirst({
        where: { shareToken: token, shareEnabled: true },
        include: {
            assets: true,
            project: { select: { name: true, location: true } },
            lead: { select: { name: true, location: true } },
        },
    });
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Pull company settings for branding. Not behind auth — the client
    // viewing the share needs the contractor name/logo on-screen.
    const settings = await prisma.companySettings.findFirst({
        select: { companyName: true, logoUrl: true, address: true },
    });

    return NextResponse.json({
        id: room.id,
        name: room.name,
        roomType: room.roomType,
        layoutJson: room.layoutJson,
        assets: room.assets,
        owner: {
            name: room.project?.name ?? room.lead?.name ?? "Room",
            address: room.project?.location ?? room.lead?.location ?? null,
        },
        contractor: {
            name: settings?.companyName ?? "ProBuild",
            logoUrl: settings?.logoUrl ?? null,
            address: settings?.address ?? null,
        },
    });
}
