// Public share viewer page — no auth. Token-gated read-only 3D view of a room.
//
// The token is validated and the room is loaded directly via Prisma rather
// than going through an API route, so the server can notFound() cleanly
// before any client bundle renders.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { isValidShareToken } from "@/lib/studio/share-url";
import { fromRoomRecord, type DesignDoc } from "@/lib/studio/doc";
import ShareStudio from "@/components/studio/ShareStudio";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ token: string }> }

interface ShareData {
    doc: DesignDoc;
    roomName: string;
    ownerName: string;
    contractor: { name: string; logoUrl: string | null };
}

async function getRoomForShare(token: string): Promise<ShareData | null> {
    if (!isValidShareToken(token)) return null;
    const room = await prisma.roomDesign.findFirst({
        where: { shareToken: token, shareEnabled: true },
        include: {
            assets: true,
            project: { select: { name: true } },
            lead: { select: { name: true } },
        },
    });
    if (!room) return null;

    const settings = await prisma.companySettings.findFirst({
        select: { companyName: true, logoUrl: true },
    });

    const doc = fromRoomRecord({
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
            metadata: (a.metadata ?? null) as Record<string, unknown> | null,
        })),
    });

    return {
        doc,
        roomName: room.name,
        ownerName: room.project?.name ?? room.lead?.name ?? "Your project",
        contractor: {
            name: settings?.companyName ?? "ProBuild",
            logoUrl: settings?.logoUrl ?? null,
        },
    };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { token } = await params;
    const data = await getRoomForShare(token);
    if (!data) return { title: "Not found" };
    return {
        title: `${data.contractor.name} — ${data.ownerName} / ${data.roomName}`,
        description: `View your ${data.roomName} design in 3D`,
        robots: { index: false, follow: false },
    };
}

export default async function SharedRoomPage({ params }: PageProps) {
    const { token } = await params;
    const data = await getRoomForShare(token);
    if (!data) notFound();
    return (
        <ShareStudio
            doc={data.doc}
            roomName={data.roomName}
            ownerName={data.ownerName}
            contractor={data.contractor}
        />
    );
}
