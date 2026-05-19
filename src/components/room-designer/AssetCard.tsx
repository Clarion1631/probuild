// Single asset tile in the left-sidebar grid. Shows a colored block (Stage 0
// placeholder — Stage 1 swaps in thumbnailPath rendering), the asset name,
// and a hover tooltip with imperial dimensions.

import type { Asset } from "@/lib/room-designer/asset-registry";
import { CATEGORY_COLORS } from "@/lib/room-designer/asset-registry";
import { isProxyAsset, useManifestReady } from "@/lib/room-designer/asset-manifest";
import type { AssetCategory } from "./types";
import { Component } from "lucide-react";

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

    return (
        <button
            type="button"
            onClick={() => onSelect(asset)}
            title={title}
            className={`group relative flex flex-col items-stretch overflow-hidden rounded-xl border bg-white text-left transition-all hover:shadow-md ${
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
                {/* Top right icon */}
                <div className="absolute right-2 top-2 text-[#7c3aed]/40">
                    <Component className="h-4 w-4" />
                </div>
            </div>
            
            <div className="flex flex-col gap-2 p-3">
                <div className="line-clamp-2 text-[11px] font-semibold leading-tight text-slate-700 group-hover:text-[#531b7e] transition-colors">
                    {asset.name}
                </div>
                
                <div className="flex items-center gap-1.5 mt-auto">
                    <span className="flex items-center justify-center rounded bg-purple-50 px-1.5 py-0.5 text-[9px] font-bold text-purple-600 border border-purple-100/50">
                        W <span className="ml-1 text-purple-400">{wIn}</span>
                    </span>
                    <span className="flex items-center justify-center rounded bg-purple-50 px-1.5 py-0.5 text-[9px] font-bold text-purple-600 border border-purple-100/50">
                        H <span className="ml-1 text-purple-400">{hIn}</span>
                    </span>
                    <span className="flex items-center justify-center rounded bg-purple-50 px-1.5 py-0.5 text-[9px] font-bold text-purple-600 border border-purple-100/50">
                        D <span className="ml-1 text-purple-400">{dIn}</span>
                    </span>
                </div>
            </div>
        </button>
    );
}
