// Root layout shell for a single room editing session. Mounts the canvas,
// toolbar, and side panels; loads the initial snapshot into the store; wires
// up autosave, undo/redo keyboard, and the Stage 2 asset-selection keyboard
// shortcuts (arrows/R/G/Ctrl+D/Delete/Escape/L/M/1/2/3).
//
// This component is rendered inside <next/dynamic { ssr: false }> at the page
// level — R3F's <Canvas> needs `window` and WebGL, which don't exist in Node.
//
// Stage 3 panel layout: LayersPanel is a DOM sibling of the canvas (not a
// canvas overlay) so HTML5 events aren't swallowed by WebGL. Alignment /
// measurement / preset toolbars are absolute overlays INSIDE the canvas
// wrapper with `pointer-events-auto` so they only consume their own clicks.

import { useEffect } from "react";
import { RoomCanvas } from "./canvas/RoomCanvas";
import { RoomToolbar } from "./RoomToolbar";
import { PropertiesPanel } from "./PropertiesPanel";
import { LayersPanel } from "./LayersPanel";
import { AlignmentToolbar } from "./AlignmentToolbar";
import { MeasurementInputBar } from "./MeasurementInputBar";
import { ViewPresetToolbar } from "./ViewPresetToolbar";
import { AssetContextMenu } from "./AssetContextMenu";
import { OnboardingCoach } from "./OnboardingCoach";
import { ShortcutLegend } from "./ShortcutLegend";
import { useRoomStore } from "./hooks/useRoomStore";
import { useRoomSave } from "./hooks/useRoomSave";
import { useUndoRedoKeyboard } from "./hooks/useUndoRedo";
import { useAssetSelection } from "./hooks/useAssetSelection";
import type { RoomSnapshot } from "./types";
import type { OwnerContext } from "@/lib/room-designer/owner-context";
import type { RoomDesignerInitialShareState } from "./RoomDesignerClient";

interface RoomDesignerProps {
    snapshot: RoomSnapshot;
    roomName: string;
    ownerContext: OwnerContext;
    initialShareState: RoomDesignerInitialShareState;
}

export function RoomDesigner({ snapshot, roomName, ownerContext, initialShareState }: RoomDesignerProps) {
    const loadSnapshot = useRoomStore((s) => s.loadSnapshot);

    // Hydrate the store once on mount — re-run only when the roomId changes.
    useEffect(() => {
        loadSnapshot(snapshot);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshot.roomId]);

    // Kick R3F's ResizeObserver a few ticks after mount. Without this the
    // <Canvas> stays at the HTML default 300×150 because its initial observer
    // callback fires before the ancestor flex chain has settled, and the
    // follow-up tick doesn't always arrive. Dispatching window resize at
    // staggered delays forces `react-use-measure` to re-read the container
    // size until the canvas matches the parent.
    useEffect(() => {
        const timers = [0, 80, 250].map((ms) =>
            setTimeout(() => window.dispatchEvent(new Event("resize")), ms)
        );
        return () => timers.forEach(clearTimeout);
    }, []);

    // Autosave + keyboard shortcuts.
    useRoomSave(snapshot.roomId);
    useUndoRedoKeyboard(true);
    useAssetSelection();

    return (
        <div className="flex h-full w-full flex-col bg-slate-100">
            <RoomToolbar
                roomName={roomName}
                ownerContext={ownerContext}
                initialShareState={initialShareState}
            />
            <div className="flex min-h-0 flex-1">
                <LayersPanel />
                <div className="relative flex-1 bg-slate-200">
                    <div className="absolute inset-0">
                        <RoomCanvas />
                    </div>
                    {/* DOM overlays — pointer-events-auto only on their own surfaces */}
                    <ViewPresetToolbar />
                    <AlignmentToolbar />
                    <MeasurementInputBar />
                </div>
                <PropertiesPanel />
            </div>
            {/* Portals to document.body — outside the flex tree. */}
            <AssetContextMenu />
            <OnboardingCoach />
            <ShortcutLegend />
        </div>
    );
}
