import { listRoomsForLead } from "@/lib/actions";
import { RoomList } from "@/components/room-designer/RoomList";

export const dynamic = "force-dynamic";

export default async function LeadRoomDesignerPage(
    props: { params: Promise<{ id: string }> },
) {
    const { id } = await props.params;
    const rooms = await listRoomsForLead(id);
    return (
        <div className="p-6">
            <RoomList rooms={rooms} ownerType="lead" ownerId={id} />
        </div>
    );
}
