// Owner context — the "contractor / project" identity surfaced by export
// buttons (PNG watermark, PDF header, share viewer chrome). Injected by the
// server pages that own a room; never fetched client-side.

import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/actions";

export interface OwnerContext {
    contractorName: string;
    contractorLogoUrl: string | null;
    contractorAddress: string | null;
    /** Project name (if the room lives under a Project) or Lead name. */
    ownerName: string;
    /** Project.location or Lead.location — may be null for skeletal records. */
    ownerAddress: string | null;
}

/**
 * Resolve the OwnerContext for a room. Returns a safe "Untitled" record if
 * any of the relations are missing — the export paths should never 500 just
 * because a lead has no location.
 */
export async function getRoomOwnerContext(roomId: string): Promise<OwnerContext> {
    const [settings, room] = await Promise.all([
        getCompanySettings(),
        prisma.roomDesign.findUnique({
            where: { id: roomId },
            include: {
                project: { select: { name: true, location: true } },
                lead: { select: { name: true, location: true } },
            },
        }),
    ]);

    const ownerName = room?.project?.name ?? room?.lead?.name ?? "Untitled Room";
    const ownerAddress = room?.project?.location ?? room?.lead?.location ?? null;

    return {
        contractorName: settings?.companyName ?? "ProBuild",
        contractorLogoUrl: settings?.logoUrl ?? null,
        contractorAddress: settings?.address ?? null,
        ownerName,
        ownerAddress,
    };
}
