// Stage 3: helpers for reading per-asset view state (hidden/locked/label)
// out of `PlacedAsset.metadata.view`. Do NOT promote these to top-level
// PlacedAsset fields — Prisma would drop them.

import type { AssetViewMeta, PlacedAsset } from "@/components/room-designer/types";
import type { Asset } from "@/lib/room-designer/asset-registry";

export function getViewMeta(asset: PlacedAsset): AssetViewMeta {
    const md = asset.metadata as Record<string, unknown> | undefined;
    const view = md?.view as AssetViewMeta | undefined;
    return view ?? {};
}

export function isHidden(asset: PlacedAsset): boolean {
    return getViewMeta(asset).hidden === true;
}

export function isLocked(asset: PlacedAsset): boolean {
    return getViewMeta(asset).locked === true;
}

export function getLabel(asset: PlacedAsset, registry: Asset | null): string {
    const v = getViewMeta(asset).label;
    if (v && v.length > 0) return v;
    return registry?.name ?? "Asset";
}
