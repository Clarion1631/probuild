// Single asset tile in the left-sidebar grid. Shows a colored block (Stage 0
// placeholder — Stage 1 swaps in thumbnailPath rendering), the asset name,
// and a hover tooltip with imperial dimensions.

import type { Asset } from "@/lib/room-designer/asset-registry";
import { CATEGORY_COLORS } from "@/lib/room-designer/asset-registry";
import { isProxyAsset, useManifestReady } from "@/lib/room-designer/asset-manifest";
import type { AssetCategory } from "./types";

const CATEGORY_ICONS: Record<AssetCategory, string> = {
    cabinet: "▦",
    appliance: "◨",
    fixture: "◉",
    window: "▣",
    door: "▯",
    lighting: "✦",
    plants: "❦",
};

const M_TO_IN = 39.3701;

function fmtInches(m: number): string {
    return `${(m * M_TO_IN).toFixed(1)}"`;
}

interface AssetCardProps {
    asset: Asset;
    active: boolean; // true when this is the `placingAsset` — highlight the card
    onSelect: (asset: Asset) => void;
}

export function AssetCard({ asset, active, onSelect }: AssetCardProps) {
    // Subscribe to manifest load so the proxy hint appears once fetched.
    useManifestReady();
    const proxyHint = isProxyAsset(asset.id)
        ? "\n\nPlaceholder model — final asset coming soon"
        : "";
    const title = `${asset.name}\n${fmtInches(asset.dimensions.width)} W × ${fmtInches(asset.dimensions.height)} H × ${fmtInches(asset.dimensions.depth)} D${proxyHint}`;

    return (
        <button
            type="button"
            onClick={() => onSelect(asset)}
            title={title}
            className={`group flex flex-col items-stretch overflow-hidden rounded-md border bg-white text-left transition hover:shadow-sm ${
                active
                    ? "border-blue-500 ring-2 ring-blue-200"
                    : "border-slate-200 hover:border-slate-400"
            }`}
        >
            {asset.thumbnailPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={asset.thumbnailPath}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-16 w-full object-cover"
                />
            ) : (
                <div
                    className="flex h-16 items-center justify-center text-2xl text-white/90"
                    style={{ backgroundColor: CATEGORY_COLORS[asset.category] }}
                >
                    {CATEGORY_ICONS[asset.category]}
                </div>
            )}
            <div className="p-1.5">
                <div className="truncate text-xs font-medium text-slate-800">{asset.name}</div>
                <div className="truncate text-[10px] text-slate-500">{asset.subcategory}</div>
            </div>
        </button>
    );
}
