import { notFound } from "next/navigation";
import { getRoom } from "@/lib/actions";
import RoomDesignerClient from "@/components/room-designer/RoomDesignerClient";
import { RoomDesignerNavContent } from "@/components/room-designer/RoomDesignerNavContent";
import { importFromProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import { getRoomOwnerContext } from "@/lib/room-designer/owner-context";

export const dynamic = "force-dynamic";

export default async function LeadRoomEditorPage(
    props: { params: Promise<{ id: string; roomId: string }> },
) {
    const { id, roomId } = await props.params;
    const room = await getRoom(roomId);
    if (!room) notFound();

    const snapshot = importFromProBuild(room as any);
    const ownerContext = await getRoomOwnerContext(roomId);
    const initialShareState = {
        enabled: !!room.shareEnabled,
        token: (room.shareToken as string | null) ?? null,
    };

    // Leads don't have an inner sidebar layout (unlike projects), so the
    // editor renders its own left rail here — same RoomDesignerNavContent
    // ProjectInnerSidebar swaps to, for visual parity across both sides.
    // -m-6 cancels the main <main>'s p-6 padding; +48px adds it back to height.
    return (
        <div className="flex h-[calc(100%+48px)] -m-6 overflow-hidden">
            <div className="w-56 shrink-0 border-r border-hui-border">
                <RoomDesignerNavContent backHref={`/leads/${id}/room-designer`} />
            </div>
            <div className="min-w-0 flex-1">
                <RoomDesignerClient
                    snapshot={snapshot}
                    roomName={room.name}
                    ownerContext={ownerContext}
                    initialShareState={initialShareState}
                />
            </div>
        </div>
    );
}
