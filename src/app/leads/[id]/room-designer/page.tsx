import { RoomList } from "@/components/studio/RoomList";

export const dynamic = "force-dynamic";

export default async function LeadRoomDesignerPage(
    props: { params: Promise<{ id: string }> },
) {
    const { id } = await props.params;
    return (
        <div className="p-6">
            <RoomList ownerKind="lead" ownerId={id} />
        </div>
    );
}
