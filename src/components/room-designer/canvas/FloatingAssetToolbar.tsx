import { Html } from "@react-three/drei";
import type { PlacedAsset } from "@/components/room-designer/types";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";

interface Props {
    asset: PlacedAsset;
    topY: number;
}

function newDuplicateId(): string {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
}

export function FloatingAssetToolbar({ asset, topY }: Props) {
    const updateAsset = useRoomStore((s) => s.updateAsset);
    const addAsset = useRoomStore((s) => s.addAsset);
    const setAssetLocked = useRoomStore((s) => s.setAssetLocked);
    const removeAsset = useRoomStore((s) => s.removeAsset);
    const gridSize = useRoomStore((s) => s.gridSize);
    const selectAsset = useRoomStore((s) => s.selectAsset);

    const locked = isLocked(asset);

    const rotate90 = () => {
        const TWO_PI = 2 * Math.PI;
        updateAsset(asset.id, {
            rotationY: ((asset.rotationY + Math.PI / 2) % TWO_PI + TWO_PI) % TWO_PI,
        });
    };

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
                <button
                    type="button"
                    title="Rotate 90° (R)"
                    disabled={locked}
                    onClick={rotate90}
                    className="rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    Rotate 90°
                </button>
                <div className="mx-0.5 h-4 w-px bg-slate-200" />
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
