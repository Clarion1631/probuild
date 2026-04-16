import { listRoomsForProject } from "@/lib/actions";
import { RoomList } from "@/components/room-designer/RoomList";

export const dynamic = "force-dynamic";

export default async function ProjectRoomDesignerPage(
    props: { params: Promise<{ id: string }> },
) {
    const { id } = await props.params;
    const rooms = await listRoomsForProject(id);
    return (
        <div className="p-6">
            <RoomList rooms={rooms} ownerType="project" ownerId={id} />
        </div>
    );
}
