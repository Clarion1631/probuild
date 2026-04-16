// Left sidebar — browse assets and start placement.
//
// Stage 2 behavior:
//   Click an asset card → startPlacing(asset) — asset attaches to cursor,
//   AssetGhost follows the PlacementPlane's cursor in the canvas, click
//   on the canvas confirms. Escape cancels.
//
// Stage 1 (real GLTF + thumbnails): AssetCard will render asset.thumbnailPath
// in the image slot when present. No changes needed here.

import { useState } from "react";
import type { Asset } from "@/lib/room-designer/asset-registry";
import type { AssetCategory } from "./types";
import { AssetGrid } from "./AssetGrid";
import { AssetSearch } from "./AssetSearch";
import { CategoryTabs } from "./CategoryTabs";
import { useAssetLibrary } from "./hooks/useAssetLibrary";
import { useRoomStore } from "./hooks/useRoomStore";

export function AssetPanel() {
    const [category, setCategory] = useState<AssetCategory>("cabinet");
    const [query, setQuery] = useState("");

    const placingAsset = useRoomStore((s) => s.placingAsset);
    const startPlacing = useRoomStore((s) => s.startPlacing);
    const cancelPlacing = useRoomStore((s) => s.cancelPlacing);

    const items = useAssetLibrary(category, query);

    function handleSelect(asset: Asset) {
        // Clicking the active asset again cancels placement — nice escape hatch.
        if (placingAsset?.id === asset.id) {
            cancelPlacing();
            return;
        }
        startPlacing(asset);
    }

    return (
        <div className="flex h-full flex-col gap-3 border-r border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Asset Library</h2>
                {placingAsset && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                        Placing: {placingAsset.name}
                    </span>
                )}
            </div>

            <AssetSearch value={query} onChange={setQuery} />
            <CategoryTabs active={category} onChange={setCategory} />

            {/* AssetGrid owns its own scroll container so it can window rows. */}
            <AssetGrid
                items={items}
                activeAssetId={placingAsset?.id ?? null}
                onSelect={handleSelect}
            />

            {placingAsset && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-2 text-[11px] text-blue-900">
                    Click on the canvas to place, or press Esc to cancel.
                </div>
            )}
        </div>
    );
}
