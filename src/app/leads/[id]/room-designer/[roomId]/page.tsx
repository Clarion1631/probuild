import { notFound } from "next/navigation";
import { getRoom } from "@/lib/actions";
import StudioClient from "@/components/studio/StudioClient";
import { fromRoomRecord } from "@/lib/studio/doc";

export const dynamic = "force-dynamic";

export default async function LeadRoomEditorPage(
    props: { params: Promise<{ id: string; roomId: string }> },
) {
    const { id, roomId } = await props.params;
    const room = await getRoom(roomId);
    if (!room) notFound();

    const initialDoc = fromRoomRecord(room);

    // The lead layout already cancels the shell padding (-mx-6 -my-6) and,
    // unlike the project layout, has no inner p-6, so fill it as-is. A -m-6
    // here pulled the studio under the header and clipped every edge.
    return (
        <div className="flex flex-1 w-full h-full min-h-0 overflow-hidden">
            <StudioClient
                roomId={roomId}
                roomName={room.name}
                initialDoc={initialDoc}
                backHref={`/leads/${id}/room-designer`}
                initialShare={{
                    enabled: !!room.shareEnabled,
                    token: (room.shareToken as string | null) ?? null,
                }}
            />
        </div>
    );
}
