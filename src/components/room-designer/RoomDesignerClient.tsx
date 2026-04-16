"use client";

// Client-side wrapper that lazily loads <RoomDesigner /> without SSR.
// R3F's <Canvas> requires `window` and WebGL which don't exist on the server.

import dynamic from "next/dynamic";
import type { RoomSnapshot } from "./types";
import type { OwnerContext } from "@/lib/room-designer/owner-context";

const RoomDesigner = dynamic(
    () => import("./RoomDesigner").then((m) => m.RoomDesigner),
    {
        ssr: false,
        loading: () => (
            <div className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500">
                Loading 3D canvas…
            </div>
        ),
    },
);

export interface RoomDesignerInitialShareState {
    enabled: boolean;
    token: string | null;
}

interface RoomDesignerClientProps {
    snapshot: RoomSnapshot;
    roomName: string;
    ownerContext: OwnerContext;
    initialShareState: RoomDesignerInitialShareState;
}

export default function RoomDesignerClient(props: RoomDesignerClientProps) {
    return <RoomDesigner {...props} />;
}
