import { notFound } from "next/navigation";
import { getRoom } from "@/lib/actions";
import RoomDesignerClient from "@/components/room-designer/RoomDesignerClient";
import { importFromProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import { getRoomOwnerContext } from "@/lib/room-designer/owner-context";

export const dynamic = "force-dynamic";

export default async function ProjectRoomEditorPage(
    props: { params: Promise<{ id: string; roomId: string }> },
) {
    const { roomId } = await props.params;
    const room = await getRoom(roomId);
    if (!room) notFound();

    const snapshot = importFromProBuild(room as any);
    const ownerContext = await getRoomOwnerContext(roomId);
    const initialShareState = {
        enabled: !!room.shareEnabled,
        token: (room.shareToken as string | null) ?? null,
    };

    // Fill the project layout's content area (which has p-6 padding) by
    // cancelling that padding with -m-6 and adding the 48 px back to height.
    // Matches the estimate editor's pattern — keeps the inner project sidebar
    // visible while the designer takes the remaining space.
    return (
        <div className="flex h-[calc(100%+48px)] -m-6 overflow-hidden">
            <RoomDesignerClient
                snapshot={snapshot}
                roomName={room.name}
                ownerContext={ownerContext}
                initialShareState={initialShareState}
            />
        </div>
    );
}
