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

const BTN =
    "flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold transition-all duration-150 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed";

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
            position={[0, topY + 0.35, 0]}
            center
            zIndexRange={[100, 0]}
            style={{ pointerEvents: "auto", userSelect: "none" }}
        >
            <div
                className="flex items-center gap-1.5 rounded-xl border border-slate-200/80 bg-white/95 p-1.5 shadow-xl backdrop-blur-sm"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
            >
                <button
                    type="button"
                    title="Rotate 90° (R)"
                    disabled={locked}
                    onClick={rotate90}
                    className={BTN + " bg-blue-50 text-blue-700 hover:bg-blue-100"}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 2v6h-6" />
                        <path d="M21 8A9 9 0 1 0 6.343 6.343" />
                    </svg>
                    90°
                </button>
                <button
                    type="button"
                    title="Duplicate (Ctrl+D)"
                    disabled={locked}
                    onClick={duplicate}
                    className={BTN + " bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    Copy
                </button>
                <button
                    type="button"
                    title={locked ? "Unlock (click to edit)" : "Lock in place"}
                    onClick={() => setAssetLocked(asset.id, !locked)}
                    className={
                        BTN +
                        (locked
                            ? " bg-amber-100 text-amber-800 hover:bg-amber-200"
                            : " bg-slate-50 text-slate-600 hover:bg-slate-100")
                    }
                >
                    {locked ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" />
                            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                        </svg>
                    )}
                </button>
                <div className="mx-0.5 h-6 w-px bg-slate-200" />
                <button
                    type="button"
                    title="Delete (Del)"
                    disabled={locked}
                    onClick={() => {
                        removeAsset(asset.id);
                        selectAsset(null);
                    }}
                    className={BTN + " bg-red-50 text-red-600 hover:bg-red-100"}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                </button>
            </div>
        </Html>
    );
}
