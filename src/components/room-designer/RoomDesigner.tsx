// Root layout shell for a single room editing session. Mounts the canvas,
// toolbar, and side panels; loads the initial snapshot into the store; wires
// up autosave, undo/redo keyboard, and the Delete key handler.
//
// This component is rendered inside <next/dynamic { ssr: false }> at the page
// level — R3F's <Canvas> needs `window` and WebGL, which don't exist in Node.

import { useEffect } from "react";
import { RoomCanvas } from "./canvas/RoomCanvas";
import { RoomToolbar } from "./RoomToolbar";
import { AssetPanel } from "./AssetPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { useRoomStore } from "./hooks/useRoomStore";
import { useRoomSave } from "./hooks/useRoomSave";
import { useUndoRedoKeyboard } from "./hooks/useUndoRedo";
import type { RoomSnapshot } from "./types";

interface RoomDesignerProps {
    snapshot: RoomSnapshot;
    roomName: string;
}

export function RoomDesigner({ snapshot, roomName }: RoomDesignerProps) {
    const loadSnapshot = useRoomStore((s) => s.loadSnapshot);
    const removeAsset = useRoomStore((s) => s.removeAsset);
    const selectedAssetId = useRoomStore((s) => s.selectedAssetId);
    const selectAsset = useRoomStore((s) => s.selectAsset);

    // Hydrate the store once on mount — re-run only when the roomId changes.
    useEffect(() => {
        loadSnapshot(snapshot);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshot.roomId]);

    // Autosave + keyboard shortcuts.
    useRoomSave(snapshot.roomId);
    useUndoRedoKeyboard(true);

    // Delete key removes the selected asset.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
            if ((e.key === "Delete" || e.key === "Backspace") && selectedAssetId) {
                e.preventDefault();
                removeAsset(selectedAssetId);
                selectAsset(null);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [selectedAssetId, removeAsset, selectAsset]);

    return (
        <div className="flex h-full w-full flex-col bg-slate-100">
            <RoomToolbar roomName={roomName} />
            <div className="flex min-h-0 flex-1">
                <div className="w-64 shrink-0">
                    <AssetPanel />
                </div>
                <div className="relative flex-1 bg-slate-200">
                    <RoomCanvas />
                </div>
                <PropertiesPanel />
            </div>
        </div>
    );
}
