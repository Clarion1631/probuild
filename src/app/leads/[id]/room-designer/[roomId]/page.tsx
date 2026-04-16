import { notFound } from "next/navigation";
import { getRoom } from "@/lib/actions";
import RoomDesignerClient from "@/components/room-designer/RoomDesignerClient";
import { importFromProBuild } from "@/lib/room-designer/blueprint3d-adapter";

export const dynamic = "force-dynamic";

export default async function LeadRoomEditorPage(
    props: { params: Promise<{ id: string; roomId: string }> },
) {
    const { roomId } = await props.params;
    const room = await getRoom(roomId);
    if (!room) notFound();

    const snapshot = importFromProBuild(room as any);

    return (
        <div className="fixed inset-0 top-0 flex flex-col">
            <RoomDesignerClient snapshot={snapshot} roomName={room.name} />
        </div>
    );
}
