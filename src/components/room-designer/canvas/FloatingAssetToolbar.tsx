// Stage 3: floating HTML toolbar that hovers above the currently-selected
// asset. Uses drei's <Html> inside the AssetNode's group so it tracks the
// asset position in screen space. Visible only for single-select.

import { Html } from "@react-three/drei";
import type { PlacedAsset, ToolMode } from "@/components/room-designer/types";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";

interface Props {
    asset: PlacedAsset;
    topY: number; // local Y of the asset's top (height/2)
}

const MODES: Array<{ mode: ToolMode; label: string; short: string }> = [
    { mode: "translate", label: "Move (1)", short: "Move" },
    { mode: "rotate", label: "Rotate (2)", short: "Rotate" },
    { mode: "scale", label: "Scale (3)", short: "Scale" },
];

function newDuplicateId(): string {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
}

export function FloatingAssetToolbar({ asset, topY }: Props) {
    const toolMode = useRoomStore((s) => s.toolMode);
    const setToolMode = useRoomStore((s) => s.setToolMode);
    const addAsset = useRoomStore((s) => s.addAsset);
    const setAssetLocked = useRoomStore((s) => s.setAssetLocked);
    const removeAsset = useRoomStore((s) => s.removeAsset);
    const gridSize = useRoomStore((s) => s.gridSize);
    const selectAsset = useRoomStore((s) => s.selectAsset);

    const locked = isLocked(asset);

    const duplicate = () => {
        const dup: PlacedAsset = {
            ...asset,
            id: newDuplicateId(),
            position: {
                x: asset.position.x + gridSize,
                y: asset.position.y,
                z: asset.position.z + gridSize,
            },
        };
        addAsset(dup);
    };

    return (
        <Html
            position={[0, topY + 0.25, 0]}
            center
            zIndexRange={[100, 0]}
            style={{ pointerEvents: "auto", userSelect: "none" }}
        >
            <div
                className="flex items-center gap-1 rounded-md border border-slate-200 bg-white/95 p-1 shadow-lg backdrop-blur"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
            >
                {MODES.map((m) => (
                    <button
                        key={m.mode}
                        type="button"
                        title={m.label}
                        disabled={locked}
                        onClick={() => setToolMode(m.mode)}
                        className={
                            (toolMode === m.mode
                                ? "bg-blue-500 text-white "
                                : "bg-white text-slate-700 hover:bg-slate-100 ") +
                            "rounded px-2 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                        }
                    >
                        {m.short}
                    </button>
                ))}
                <div className="mx-1 h-4 w-px bg-slate-200" />
                <button
                    type="button"
                    title="Duplicate (Ctrl+D)"
                    disabled={locked}
                    onClick={duplicate}
                    className="rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                >
                    Duplicate
                </button>
                <button
                    type="button"
                    title={locked ? "Unlock position" : "Lock position"}
                    onClick={() => setAssetLocked(asset.id, !locked)}
                    className={
                        "rounded px-2 py-1 text-xs font-medium " +
                        (locked
                            ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                            : "text-slate-700 hover:bg-slate-100")
                    }
                >
                    {locked ? "Locked" : "Lock"}
                </button>
                <button
                    type="button"
                    title="Delete (Del)"
                    disabled={locked}
                    onClick={() => {
                        removeAsset(asset.id);
                        selectAsset(null);
                    }}
                    className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                >
                    Delete
                </button>
            </div>
        </Html>
    );
}
