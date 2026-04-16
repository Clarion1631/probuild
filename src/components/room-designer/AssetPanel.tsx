// Left sidebar — browse assets and drop them into the room. Stage 0 just uses
// a click-to-place flow (drops the asset at the room origin). Stage 1 will add
// drag-and-drop onto the canvas.

import { useMemo, useState } from "react";
import { ASSETS_BY_CATEGORY, CATEGORY_COLORS, type Asset } from "@/lib/room-designer/asset-registry";
import type { AssetCategory, PlacedAsset } from "./types";
import { useRoomStore } from "./hooks/useRoomStore";

const CATEGORIES: { key: AssetCategory; label: string; icon: string }[] = [
    { key: "cabinet", label: "Cabinets", icon: "▦" },
    { key: "appliance", label: "Appliances", icon: "◨" },
    { key: "fixture", label: "Fixtures", icon: "◉" },
    { key: "window", label: "Windows", icon: "▣" },
    { key: "door", label: "Doors", icon: "▯" },
];

function newId() {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
}

export function AssetPanel() {
    const [active, setActive] = useState<AssetCategory>("cabinet");
    const [query, setQuery] = useState("");
    const addAsset = useRoomStore((s) => s.addAsset);

    const items = useMemo(() => {
        const base = ASSETS_BY_CATEGORY[active];
        const q = query.trim().toLowerCase();
        if (!q) return base;
        return base.filter(
            (a) =>
                a.name.toLowerCase().includes(q) ||
                a.subcategory.toLowerCase().includes(q) ||
                a.tags.some((t) => t.toLowerCase().includes(q)),
        );
    }, [active, query]);

    function place(a: Asset) {
        const placed: PlacedAsset = {
            id: newId(),
            assetId: a.id,
            assetType: a.category,
            position: { x: 0, y: 0, z: 0 },
            rotationY: 0,
            scale: { x: 1, y: 1, z: 1 },
        };
        addAsset(placed);
    }

    return (
        <div className="flex h-full flex-col gap-3 border-r border-slate-200 bg-white p-3">
            <h2 className="text-sm font-semibold text-slate-900">Asset Library</h2>

            <div className="flex flex-wrap gap-1">
                {CATEGORIES.map((c) => (
                    <button
                        key={c.key}
                        onClick={() => setActive(c.key)}
                        className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
                            active === c.key
                                ? "border-slate-800 bg-slate-900 text-white"
                                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                    >
                        <span className="mr-1">{c.icon}</span>
                        {c.label}
                    </button>
                ))}
            </div>

            <input
                type="text"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="hui-input py-1 text-sm"
            />

            <div className="flex-1 overflow-y-auto">
                <div className="grid grid-cols-2 gap-2">
                    {items.map((a) => (
                        <button
                            key={a.id}
                            onClick={() => place(a)}
                            className="group flex flex-col items-stretch overflow-hidden rounded-md border border-slate-200 bg-white text-left transition hover:border-slate-400 hover:shadow-sm"
                            title={`${a.name}\n${(a.dimensions.width * 39.37).toFixed(1)}" W × ${(a.dimensions.height * 39.37).toFixed(1)}" H × ${(a.dimensions.depth * 39.37).toFixed(1)}" D`}
                        >
                            <div
                                className="flex h-16 items-center justify-center text-2xl text-white/90"
                                style={{ backgroundColor: CATEGORY_COLORS[a.category] }}
                            >
                                {CATEGORIES.find((c) => c.key === a.category)?.icon ?? "▦"}
                            </div>
                            <div className="p-1.5">
                                <div className="truncate text-xs font-medium text-slate-800">{a.name}</div>
                                <div className="truncate text-[10px] text-slate-500">{a.subcategory}</div>
                            </div>
                        </button>
                    ))}
                    {items.length === 0 && (
                        <div className="col-span-2 py-8 text-center text-xs text-slate-400">No assets match.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
