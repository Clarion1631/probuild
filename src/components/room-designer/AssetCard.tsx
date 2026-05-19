// Single asset tile in the left-sidebar grid. Shows a thumbnail (or fallback
// category icon while Stage 0 paths are null), a derived display SKU, the asset
// name, and three W/H/D dimension pills. The drag-handle in the top-right is
// purely decorative — clicking anywhere on the card starts placement — but it
// stays visible on touch devices per the project's hover-none mandate.

import type { Asset } from "@/lib/room-designer/asset-registry";
import { CATEGORY_COLORS } from "@/lib/room-designer/asset-registry";
import { isProxyAsset, useManifestReady } from "@/lib/room-designer/asset-manifest";
import { deriveSku } from "@/lib/room-designer/sku";
import { DimensionPill } from "./ui/DimensionPill";
import type { AssetCategory } from "./types";
import { GripVertical } from "lucide-react";

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

function getInchesInt(m: number): number {
    return Math.round(m * M_TO_IN);
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

    const wIn = getInchesInt(asset.dimensions.width);
    const hIn = getInchesInt(asset.dimensions.height);
    const dIn = getInchesInt(asset.dimensions.depth);
    const sku = deriveSku(asset);

    return (
        <button
            type="button"
            onClick={() => onSelect(asset)}
            title={title}
            className={`group relative flex flex-col items-stretch overflow-hidden rounded-xl border bg-white text-left transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#531b7e] focus-visible:ring-offset-1 ${
                active
                    ? "border-[#531b7e] ring-1 ring-[#531b7e] shadow-md"
                    : "border-slate-100 hover:border-purple-200"
            }`}
        >
            <div className="relative flex h-24 w-full items-center justify-center bg-slate-50/50 p-2">
                {asset.thumbnailPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={asset.thumbnailPath}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-contain mix-blend-multiply"
                    />
                ) : (
                    <div
                        className="flex h-12 w-12 items-center justify-center rounded-lg text-2xl text-white/90 shadow-sm"
                        style={{ backgroundColor: CATEGORY_COLORS[asset.category] }}
                    >
                        {CATEGORY_ICONS[asset.category]}
                    </div>
                )}
                {/* Drag-handle affordance. Visible on hover for pointer devices;
                  * always visible on touch devices (CLAUDE.md hover-none rule). */}
                <span
                    aria-hidden
                    className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                >
                    <GripVertical className="h-3.5 w-3.5" />
                </span>
            </div>

            <div className="flex flex-col gap-1.5 p-3">
                <div className="font-mono text-[9px] uppercase tracking-wide text-slate-400">
                    {sku}
                </div>
                <div className="line-clamp-2 text-[11px] font-semibold leading-tight text-slate-700 transition-colors group-hover:text-[#531b7e]">
                    {asset.name}
                </div>
                <div className="mt-auto flex flex-col gap-1">
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                        Dimensions:
                    </span>
                    <div className="flex items-center gap-1.5">
                        <DimensionPill axis="W" inches={wIn} />
                        <DimensionPill axis="H" inches={hIn} />
                        <DimensionPill axis="D" inches={dIn} />
                    </div>
                </div>
            </div>
        </button>
    );
}
