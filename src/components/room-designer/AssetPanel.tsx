import { useState } from "react";
import type { AssetCategory } from "./types";
import { useRoomStore } from "./hooks/useRoomStore";
import { useAssetLibrary } from "./hooks/useAssetLibrary";
import { getAsset, type Asset } from "@/lib/room-designer/asset-registry";
import { fmtInches } from "@/lib/room-designer/units";
import {
    Compass,
    Box,
    ChefHat,
    Palette,
    DoorOpen,
    Receipt,
    X,
    Grid3X3,
    Sparkles,
    Info,
} from "lucide-react";
import { TabButton } from "./ui/TabButton";
import { CategoryBrowser, type SubCategoryCard } from "./CategoryBrowser";

type TabId = "styling" | "cabinet" | "appliance" | "doors-windows" | "finishing" | "review";

const CABINET_CARDS: SubCategoryCard[] = [
    { id: "base", label: "Base Cabinets", description: "Standard base millwork & sink bases", icon: "Base" },
    { id: "wall", label: "Wall Cabinets", description: "Upper cabinets & glass-door wall units", icon: "Wall" },
    { id: "tall", label: "Oven/Pantry Cabinets", description: "Full height pantries & oven towers", icon: "Pantry" },
    { id: "corner", label: "Bathroom Vanities", description: "Lazy Susans & double vanities", icon: "Vanity" },
    { id: "shelf", label: "Accessories", description: "Floating shelves & millwork accessories", icon: "Accessory" },
    { id: "all", label: "All Cabinets", description: "Browse full cabinet collection", icon: "All" },
];

const APPLIANCE_CARDS: SubCategoryCard[] = [
    { id: "refrigerator", label: "Refrigerators", description: "French door & wine fridges", icon: "Fridge" },
    { id: "range-oven", label: "Stoves & Ovens", description: "Gas ranges & wall double ovens", icon: "Stove" },
    { id: "dishwasher", label: "Dishwashers", description: "Standard undercounter dishwashers", icon: "Wash" },
    { id: "laundry", label: "Laundry", description: "Front-load washers & dryers", icon: "Dryer" },
    { id: "hood-microwave", label: "Hoods & Microwaves", description: "Over-range microwaves & hoods", icon: "Hood" },
    { id: "all", label: "All Appliances", description: "Browse full appliance collection", icon: "All" },
];

const OPENING_CARDS: SubCategoryCard[] = [
    { id: "door", label: "Doors", description: "Single, double, barn & pocket doors", icon: "Doors" },
    { id: "window", label: "Windows", description: "Hung, bay, casement & skylights", icon: "Windows" },
    { id: "all", label: "All Openings", description: "Browse all windows & doors", icon: "All" },
];

const FLOOR_MATERIALS = [
    { id: "wood_light", name: "Oak Hardwood", color: "bg-[#d7b489]" },
    { id: "wood_dark", name: "Dark Walnut", color: "bg-[#5c3e21]" },
    { id: "tile_marble", name: "Marble Tile", color: "bg-[#e2e8f0] border border-slate-200" },
    { id: "concrete", name: "Polished Concrete", color: "bg-[#94a3b8]" },
];

const WALL_MATERIALS = [
    { id: "paint_white", name: "Swiss Coffee Paint", color: "bg-[#fafaf9] border border-slate-200" },
    { id: "paint_slate", name: "Iron Ore Gray Paint", color: "bg-[#27272a]" },
    { id: "brick", name: "Exposed Red Brick", color: "bg-[#b91c1c]/80" },
    { id: "tile_subway", name: "White Subway Tile", color: "bg-[#f1f5f9] border border-dashed border-slate-300" },
];

export function AssetPanel() {
    const [activeTab, setActiveTab] = useState<TabId>("cabinet");
    const [expanded, setExpanded] = useState(true);
    const [subFilter, setSubFilter] = useState<string | null>(null);
    const [query, setQuery] = useState("");

    const placingAsset = useRoomStore((s) => s.placingAsset);
    const startPlacing = useRoomStore((s) => s.startPlacing);
    const cancelPlacing = useRoomStore((s) => s.cancelPlacing);

    // Room configurations
    const layout = useRoomStore((s) => s.layout);
    const setLayout = useRoomStore((s) => s.setLayout);
    const snapToGrid = useRoomStore((s) => s.snapToGrid);
    const setSnapToGrid = useRoomStore((s) => s.setSnapToGrid);
    const gridSize = useRoomStore((s) => s.gridSize);
    const setGridSize = useRoomStore((s) => s.setGridSize);
    const setSurfaceMaterial = useRoomStore((s) => s.setSurfaceMaterial);

    // Placed items review list
    const assets = useRoomStore((s) => s.assets);

    // Map tab categories to static asset library queries
    const libraryCategory: AssetCategory | "doors-windows" =
        activeTab === "cabinet" ? "cabinet" :
        activeTab === "appliance" ? "appliance" :
        activeTab === "doors-windows" ? "doors-windows" : "cabinet"; // Fallbacks

    // Resolve filtered assets
    const rawItems = useAssetLibrary(libraryCategory, query);
    const items = rawItems.filter((asset) => {
        if (!subFilter || subFilter === "all") return true;
        if (activeTab === "doors-windows") {
            return asset.category === subFilter; // window vs door
        }
        if (activeTab === "cabinet") {
            if (subFilter === "corner") return asset.subcategory === "corner" || asset.subcategory === "vanity";
            return asset.subcategory === subFilter;
        }
        if (activeTab === "appliance") {
            if (subFilter === "range-oven") return asset.subcategory === "range" || asset.subcategory === "oven";
            if (subFilter === "hood-microwave") return asset.subcategory === "hood" || asset.subcategory === "microwave";
            return asset.subcategory === subFilter;
        }
        return true;
    });

    const handleSelect = (asset: Asset) => {
        if (placingAsset?.id === asset.id) {
            cancelPlacing();
            return;
        }
        startPlacing(asset);
    };

    const handleTabClick = (tab: TabId) => {
        if (activeTab === tab) {
            setExpanded(!expanded);
        } else {
            setActiveTab(tab);
            setExpanded(true);
            setSubFilter(null);
            setQuery("");
        }
    };

    return (
        <div className="z-20 flex h-full min-h-0 shrink-0 select-none">

            {/* 1. Slim vertical stage rail */}
            <div className="flex w-[88px] shrink-0 flex-col items-stretch justify-between border-r border-slate-200 bg-white py-4">
                <div className="flex flex-col items-stretch gap-2.5">
                    <TabButton
                        active={expanded && activeTab === "styling"}
                        label="Room Styling"
                        icon={<Compass />}
                        onClick={() => handleTabClick("styling")}
                    />
                    <TabButton
                        active={expanded && activeTab === "cabinet"}
                        label="Cabinets"
                        icon={<Box />}
                        onClick={() => handleTabClick("cabinet")}
                    />
                    <TabButton
                        active={expanded && activeTab === "appliance"}
                        label="Appliances"
                        icon={<ChefHat />}
                        onClick={() => handleTabClick("appliance")}
                    />
                    <TabButton
                        active={expanded && activeTab === "doors-windows"}
                        label="Openings"
                        icon={<DoorOpen />}
                        onClick={() => handleTabClick("doors-windows")}
                    />
                    <TabButton
                        active={expanded && activeTab === "finishing"}
                        label="Finishing"
                        icon={<Palette />}
                        onClick={() => handleTabClick("finishing")}
                    />
                </div>
                <div className="flex flex-col items-stretch">
                    <TabButton
                        active={expanded && activeTab === "review"}
                        label="Review"
                        icon={<Receipt />}
                        onClick={() => handleTabClick("review")}
                    />
                </div>
            </div>

            {/* 2. Expanded content drawer */}
            {expanded && (
                <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white shadow-sm animate-in slide-in-from-left duration-200">

                    {/* Drawer header */}
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/50 px-4 py-3">
                        <h2 className="text-sm font-bold capitalize text-[#2e103f]">
                            {activeTab === "doors-windows" ? "Doors & Windows" : activeTab}
                        </h2>
                        <button
                            type="button"
                            onClick={() => setExpanded(false)}
                            aria-label="Collapse panel"
                            className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    {/* Drawer scroll container */}
                    <div className="min-h-0 flex-1 overflow-y-auto p-4">

                        {activeTab === "cabinet" && (
                            <CategoryBrowser
                                cards={CABINET_CARDS}
                                subFilter={subFilter}
                                setSubFilter={(id) => { setSubFilter(id); setQuery(""); }}
                                query={query}
                                setQuery={setQuery}
                                searchPlaceholder="Search cabinets..."
                                items={items}
                                placingAsset={placingAsset}
                                onSelect={handleSelect}
                            />
                        )}

                        {activeTab === "appliance" && (
                            <CategoryBrowser
                                cards={APPLIANCE_CARDS}
                                subFilter={subFilter}
                                setSubFilter={(id) => { setSubFilter(id); setQuery(""); }}
                                query={query}
                                setQuery={setQuery}
                                searchPlaceholder="Search appliances..."
                                items={items}
                                placingAsset={placingAsset}
                                onSelect={handleSelect}
                            />
                        )}

                        {activeTab === "doors-windows" && (
                            <CategoryBrowser
                                cards={OPENING_CARDS}
                                subFilter={subFilter}
                                setSubFilter={(id) => { setSubFilter(id); setQuery(""); }}
                                query={query}
                                setQuery={setQuery}
                                searchPlaceholder="Search openings..."
                                items={items}
                                placingAsset={placingAsset}
                                onSelect={handleSelect}
                            />
                        )}

                        {activeTab === "styling" && (
                            <div className="flex flex-col gap-4 animate-in fade-in duration-200">
                                <h3 className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-slate-400">
                                    <Sparkles className="h-3.5 w-3.5 text-[#531b7e]" /> Room Geometry
                                </h3>

                                <div className="flex flex-col gap-3 rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                                    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                                        Room Width
                                        <input
                                            type="text"
                                            value={fmtInches(layout.dimensions.width)}
                                            onChange={(e) => {
                                                const m = parseFloat(e.target.value) / 39.37;
                                                if (Number.isFinite(m) && m > 0.5) setLayout({ ...layout, dimensions: { ...layout.dimensions, width: m } });
                                            }}
                                            className="hui-input py-1 text-xs"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                                        Room Length
                                        <input
                                            type="text"
                                            value={fmtInches(layout.dimensions.length)}
                                            onChange={(e) => {
                                                const m = parseFloat(e.target.value) / 39.37;
                                                if (Number.isFinite(m) && m > 0.5) setLayout({ ...layout, dimensions: { ...layout.dimensions, length: m } });
                                            }}
                                            className="hui-input py-1 text-xs"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                                        Room Height
                                        <input
                                            type="text"
                                            value={fmtInches(layout.dimensions.height)}
                                            onChange={(e) => {
                                                const m = parseFloat(e.target.value) / 39.37;
                                                if (Number.isFinite(m) && m > 0.5) setLayout({ ...layout, dimensions: { ...layout.dimensions, height: m } });
                                            }}
                                            className="hui-input py-1 text-xs"
                                        />
                                    </label>
                                </div>

                                <h3 className="flex items-center gap-1 pt-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                                    <Grid3X3 className="h-3.5 w-3.5 text-[#531b7e]" /> Grid Settings
                                </h3>

                                <div className="flex flex-col gap-3 rounded-lg border border-slate-100 bg-slate-50/50 p-3 text-xs">
                                    <label className="flex items-center justify-between font-semibold text-slate-600">
                                        Snap to Grid
                                        <input
                                            type="checkbox"
                                            checked={snapToGrid}
                                            onChange={(e) => setSnapToGrid(e.target.checked)}
                                            className="h-4 w-4 rounded border-slate-300 text-[#531b7e] focus:ring-[#531b7e]"
                                        />
                                    </label>

                                    <div className="flex flex-col gap-1">
                                        <span className="flex justify-between font-semibold text-slate-600">
                                            Grid Size <span>{Math.round(gridSize * 100)} cm</span>
                                        </span>
                                        <input
                                            type="range"
                                            min="0.05"
                                            max="0.5"
                                            step="0.05"
                                            value={gridSize}
                                            onChange={(e) => setGridSize(parseFloat(e.target.value))}
                                            className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-[#531b7e]"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeTab === "finishing" && (
                            <div className="flex flex-col gap-4 text-xs animate-in fade-in duration-200">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                                    Floor Material
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    {FLOOR_MATERIALS.map((m) => (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => setSurfaceMaterial("floor", m.id)}
                                            className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/40 p-2 text-center transition-all hover:border-purple-200 hover:bg-purple-50/20"
                                        >
                                            <div className={`h-8 w-12 rounded shadow-sm ${m.color}`} />
                                            <span className="text-[10px] font-medium text-slate-700">{m.name}</span>
                                        </button>
                                    ))}
                                </div>

                                <h3 className="pt-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                                    Wall Finish
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    {WALL_MATERIALS.map((m) => (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => {
                                                setSurfaceMaterial("wall-north", m.id);
                                                setSurfaceMaterial("wall-south", m.id);
                                                setSurfaceMaterial("wall-east", m.id);
                                                setSurfaceMaterial("wall-west", m.id);
                                            }}
                                            className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/40 p-2 text-center transition-all hover:border-purple-200 hover:bg-purple-50/20"
                                        >
                                            <div className={`h-8 w-12 rounded shadow-sm ${m.color}`} />
                                            <span className="text-[10px] font-medium text-slate-700">{m.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeTab === "review" && (
                            <div className="flex flex-col gap-3 text-xs animate-in fade-in duration-200">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                                    Placed Assets checklist
                                </h3>

                                {assets.length === 0 ? (
                                    <p className="p-2 text-center italic text-slate-400">No items placed in this room yet.</p>
                                ) : (
                                    <div className="flex max-h-60 flex-col gap-1.5 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                                        {assets.map((a) => {
                                            const reg = getAsset(a.assetId);
                                            return (
                                                <div key={a.id} className="flex items-center justify-between border-b border-slate-100 py-1 font-medium text-slate-700 last:border-0">
                                                    <span className="max-w-[160px] truncate">{reg?.name ?? "Custom"}</span>
                                                    <span className="rounded bg-slate-200/60 px-1.5 py-0.5 text-[10px] font-semibold capitalize text-slate-600">{a.assetType}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="mt-2 flex flex-col gap-1 rounded-lg border border-purple-100 bg-purple-50 p-3">
                                    <div className="flex justify-between font-bold text-[#2e103f]">
                                        <span>Estimated Cost</span>
                                        <span>${assets.length * 179 + 450}</span>
                                    </div>
                                    <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-purple-700">
                                        <Info className="h-3 w-3" /> Fully integrated with Goldentouch Estimates
                                    </p>
                                </div>
                            </div>
                        )}

                    </div>

                    {/* Placement helper message */}
                    {placingAsset && (
                        <div className="m-4 animate-pulse rounded-md border border-blue-200 bg-blue-50/60 p-2.5 text-[10px] leading-normal text-blue-900">
                            Click on the canvas to place <b>{placingAsset.name}</b>, or press <b>Esc</b> to cancel.
                        </div>
                    )}

                </div>
            )}

        </div>
    );
}
