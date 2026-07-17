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

    return (
        <div className="flex flex-grow flex-1 w-full h-[calc(100%+48px)] -m-6 overflow-hidden">
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
