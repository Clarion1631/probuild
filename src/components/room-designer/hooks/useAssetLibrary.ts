// Read-only helper that filters the static asset registry by category and
// free-text query. No network, no loading state — the registry is ~37 items
// shipped as a TS module.
//
// Stage 1 (real GLTF models) does not affect this hook: modelPath changes from
// null → string, but this hook only reads name/subcategory/tags/dimensions.

import { useMemo } from "react";
import {
    ASSETS_BY_CATEGORY,
    type Asset,
} from "@/lib/room-designer/asset-registry";
import type { AssetCategory } from "@/components/room-designer/types";

export function useAssetLibrary(category: AssetCategory, query: string): Asset[] {
    return useMemo(() => {
        const base = ASSETS_BY_CATEGORY[category];
        const q = query.trim().toLowerCase();
        if (!q) return base;
        return base.filter(
            (a) =>
                a.name.toLowerCase().includes(q) ||
                a.subcategory.toLowerCase().includes(q) ||
                a.tags.some((t) => t.toLowerCase().includes(q)),
        );
    }, [category, query]);
}
