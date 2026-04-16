// Public share viewer page — no auth. Token-gated read-only 3D view of a room.
//
// The token is validated and the room is loaded directly via Prisma (mirrors
// the contractor-portal pattern in src/lib/actions.ts) rather than going
// through /api/share/[token], so the server can notFound() cleanly before
// any client bundle renders.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { isValidShareToken } from "@/lib/room-designer/share-url";
import { importFromProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import ShareViewerClient from "@/components/room-designer/share/ShareViewerClient";
import type { ShareViewerData } from "@/components/room-designer/share/ShareViewer";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ token: string }> }

async function getRoomForShare(token: string): Promise<ShareViewerData | null> {
    if (!isValidShareToken(token)) return null;
    const room = await prisma.roomDesign.findFirst({
        where: { shareToken: token, shareEnabled: true },
        include: {
            assets: true,
            project: { select: { name: true, location: true } },
            lead: { select: { name: true, location: true } },
        },
    });
    if (!room) return null;

    const settings = await prisma.companySettings.findFirst({
        select: { companyName: true, logoUrl: true, address: true },
    });

    const snapshot = importFromProBuild({
        id: room.id,
        name: room.name,
        roomType: room.roomType,
        layoutJson: room.layoutJson,
        assets: room.assets.map((a) => ({
            id: a.id,
            assetType: a.assetType,
            assetId: a.assetId,
            positionX: a.positionX,
            positionY: a.positionY,
            positionZ: a.positionZ,
            rotationY: a.rotationY,
            scaleX: a.scaleX,
            scaleY: a.scaleY,
            scaleZ: a.scaleZ,
            metadata: a.metadata,
        })),
    });

    return {
        snapshot,
        roomName: room.name,
        token,
        owner: {
            name: room.project?.name ?? room.lead?.name ?? "Room",
            address: room.project?.location ?? room.lead?.location ?? null,
        },
        contractor: {
            name: settings?.companyName ?? "ProBuild",
            logoUrl: settings?.logoUrl ?? null,
            address: settings?.address ?? null,
        },
    };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { token } = await params;
    const data = await getRoomForShare(token);
    if (!data) return { title: "Not found" };
    return {
        title: `${data.contractor.name} — ${data.owner.name} / ${data.roomName}`,
        description: `View your ${data.roomName} design`,
        openGraph: {
            title: `${data.contractor.name} — ${data.owner.name} / ${data.roomName}`,
            description: `View your ${data.roomName} design`,
            images: [`/share/room/${token}/opengraph-image`],
        },
        robots: { index: false, follow: false },
    };
}

export default async function SharedRoomPage({ params }: PageProps) {
    const { token } = await params;
    const data = await getRoomForShare(token);
    if (!data) notFound();
    return <ShareViewerClient data={data} />;
}
