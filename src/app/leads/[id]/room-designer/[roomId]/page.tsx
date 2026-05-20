import { notFound } from "next/navigation";
import { getRoom } from "@/lib/actions";
import RoomDesignerClient from "@/components/room-designer/RoomDesignerClient";
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

    // Leads layout already renders EntitySidebar, which conditional swaps
    // to RoomDesignerNavContent on isRoomEditor. So we just fill the main
    // page content here.
    return (
        <div className="flex flex-grow flex-1 w-full h-[calc(100%+48px)] -m-6 overflow-hidden">
            <RoomDesignerClient
                snapshot={snapshot}
                roomName={room.name}
                ownerContext={ownerContext}
                initialShareState={initialShareState}
            />
        </div>
    );
}
