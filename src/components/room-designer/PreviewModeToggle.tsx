// Before/After (Design/Empty) segmented toggle. When "empty", placed assets
// are hidden; walls, floor, ceiling, and their material selections remain
// visible so clients can see what the bare room looks like vs the proposed
// furnishing.
//
// The fade itself is driven from RoomCanvas — this component only flips the
// store flag. Store action `togglePreviewMode` is view-only (not in history,
// not autosaved).

import { useRoomStore } from "./hooks/useRoomStore";

export function PreviewModeToggle() {
    const previewMode = useRoomStore((s) => s.previewMode);
    const togglePreviewMode = useRoomStore((s) => s.togglePreviewMode);

    return (
        <div className="flex overflow-hidden rounded-md border border-slate-200" title="Before / After (B)">
            <button
                onClick={() => {
                    if (previewMode !== "empty") togglePreviewMode();
                }}
                className={`px-2 py-1 text-xs font-medium transition ${
                    previewMode === "empty"
                        ? "bg-slate-900 text-white"
                        : "bg-white text-slate-700 hover:bg-slate-50"
                }`}
            >
                Before
            </button>
            <button
                onClick={() => {
                    if (previewMode !== "design") togglePreviewMode();
                }}
                className={`px-2 py-1 text-xs font-medium transition ${
                    previewMode === "design"
                        ? "bg-slate-900 text-white"
                        : "bg-white text-slate-700 hover:bg-slate-50"
                }`}
            >
                After
            </button>
        </div>
    );
}
