// Stage drawer body for asset categories (Cabinets / Appliances / Openings).
// First entry shows the SubCatCard grid; selecting a card swaps in a breadcrumb
// header + "Filter by" chip rail + search + asset grid. Replaces the
// duplicated cabinet/appliance/doors-windows branches that previously lived
// inline in AssetPanel.

import { useState } from "react";
import type { Asset } from "@/lib/room-designer/asset-registry";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { AssetGrid } from "./AssetGrid";
import { AssetSearch } from "./AssetSearch";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface SubCategoryCard {
    id: string;
    label: string;
    description: string;
    icon: string;
}

interface CategoryBrowserProps {
    cards: SubCategoryCard[];
    subFilter: string | null;
    setSubFilter: (id: string | null) => void;
    query: string;
    setQuery: (q: string) => void;
    searchPlaceholder: string;
    items: Asset[];
    placingAsset: Asset | null;
    onSelect: (asset: Asset) => void;
}

export function CategoryBrowser({
    cards,
    subFilter,
    setSubFilter,
    query,
    setQuery,
    searchPlaceholder,
    items,
    placingAsset,
    onSelect,
}: CategoryBrowserProps) {
    if (subFilter === null) {
        return (
            <div className="grid grid-cols-2 gap-3 animate-in fade-in duration-200">
                {cards.map((c) => (
                    <SubCatCard
                        key={c.id}
                        card={c}
                        onClick={() => setSubFilter(c.id)}
                    />
                ))}
            </div>
        );
    }

    const activeLabel = cards.find((c) => c.id === subFilter)?.label ?? subFilter;

    return (
        <div className="flex flex-col gap-3 animate-in fade-in duration-200">
            <Breadcrumb
                items={[
                    { label: "Home", onClick: () => setSubFilter(null) },
                    { label: activeLabel },
                ]}
                onBack={() => setSubFilter(null)}
            />
            <FilterByChips
                cards={cards}
                active={subFilter}
                onChange={setSubFilter}
            />
            <AssetSearch value={query} onChange={setQuery} placeholder={searchPlaceholder} />
            <AssetGrid
                items={items}
                activeAssetId={placingAsset?.id ?? null}
                onSelect={onSelect}
            />
        </div>
    );
}

interface FilterByChipsProps {
    cards: SubCategoryCard[];
    active: string;
    onChange: (id: string) => void;
}

function FilterByChips({ cards, active, onChange }: FilterByChipsProps) {
    const [open, setOpen] = useState(true);
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-slate-100 bg-slate-50/40 px-2.5 py-2">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500 focus:outline-none focus-visible:text-[#531b7e]"
                aria-expanded={open}
            >
                <span>Filter by</span>
                {open ? (
                    <ChevronUp className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                )}
            </button>
            {open && (
                <div className="flex flex-wrap gap-1.5">
                    {cards.map((c) => {
                        const isActive = c.id === active;
                        return (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => onChange(c.id)}
                                aria-pressed={isActive}
                                className={
                                    "rounded-full border px-2.5 py-0.5 text-[10px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#531b7e] " +
                                    (isActive
                                        ? "border-[#531b7e] bg-purple-50 text-[#531b7e]"
                                        : "border-slate-200 bg-white text-slate-600 hover:border-purple-200 hover:text-[#531b7e]")
                                }
                            >
                                {c.label}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function SubCatCard({ card, onClick }: { card: SubCategoryCard; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex flex-col items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/30 p-3 text-center transition-all hover:border-purple-200 hover:bg-purple-50/20 active:scale-[0.98]"
        >
            <div className="flex h-12 w-16 items-center justify-center rounded-lg border border-slate-200/40 bg-slate-100/60 text-xs font-bold tracking-wider text-slate-500 shadow-sm transition-colors group-hover:bg-[#531b7e]/10 group-hover:text-[#531b7e]">
                {card.icon}
            </div>
            <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold leading-tight text-slate-800 transition-colors group-hover:text-[#531b7e]">
                    {card.label}
                </span>
                <span className="max-w-[120px] text-[9px] font-medium leading-normal text-slate-400">
                    {card.description}
                </span>
            </div>
        </button>
    );
}
