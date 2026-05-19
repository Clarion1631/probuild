import { useState } from "react";
import type { AssetCategory } from "./types";
import { useRoomStore } from "./hooks/useRoomStore";
import { useAssetLibrary } from "./hooks/useAssetLibrary";
import { getAsset, ASSETS_BY_CATEGORY, type Asset } from "@/lib/room-designer/asset-registry";
import { fmtInches } from "@/lib/room-designer/units";
import {
    Compass,
    Box,
    ChefHat,
    Palette,
    DoorOpen,
    Layers,
    Receipt,
    ArrowLeft,
    X,
    Search,
    Maximize2,
    Grid3X3,
    Sparkles,
    Info,
    ChevronLeft,
    ListFilter
} from "lucide-react";
import { AssetGrid } from "./AssetGrid";
import { AssetSearch } from "./AssetSearch";

type TabId = "styling" | "cabinet" | "appliance" | "doors-windows" | "finishing" | "review";

interface SubCategoryCard {
    id: string;
    label: string;
    description: string;
    icon: string;
}

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

    const handleSubCategoryClick = (cardId: string) => {
        setSubFilter(cardId);
        setQuery("");
    };

    return (
        <div className="flex h-full min-h-0 shrink-0 select-none z-20">
            
            {/* 1. Slim Vertical Brand Navigation Strip */}
            <div className="flex w-20 flex-col items-center justify-between border-r border-[#261537] bg-[#14061F] py-4 text-slate-400 shrink-0">
                <div className="flex w-full flex-col items-center gap-3">
                    {/* Logo Accent */}
                    <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-[#531b7e] font-bold text-white text-base shadow-inner">
                        G
                    </div>

                    {/* Navigation Items */}
                    <NavBtn
                        active={expanded && activeTab === "styling"}
                        label="Room Styling"
                        onClick={() => handleTabClick("styling")}
                    >
                        <Compass className="h-5 w-5" />
                    </NavBtn>

                    <NavBtn
                        active={expanded && activeTab === "cabinet"}
                        label="Cabinets"
                        onClick={() => handleTabClick("cabinet")}
                    >
                        <Box className="h-5 w-5" />
                    </NavBtn>

                    <NavBtn
                        active={expanded && activeTab === "appliance"}
                        label="Appliances"
                        onClick={() => handleTabClick("appliance")}
                    >
                        <ChefHat className="h-5 w-5" />
                    </NavBtn>

                    <NavBtn
                        active={expanded && activeTab === "finishing"}
                        label="Finishing"
                        onClick={() => handleTabClick("finishing")}
                    >
                        <Palette className="h-5 w-5" />
                    </NavBtn>

                    <NavBtn
                        active={expanded && activeTab === "doors-windows"}
                        label="Openings"
                        onClick={() => handleTabClick("doors-windows")}
                    >
                        <DoorOpen className="h-5 w-5" />
                    </NavBtn>
                </div>

                {/* Bottom navigation hooks */}
                <div className="flex w-full flex-col items-center gap-3">
                    <NavBtn
                        active={expanded && activeTab === "review"}
                        label="Review"
                        onClick={() => handleTabClick("review")}
                    >
                        <Receipt className="h-5 w-5" />
                    </NavBtn>
                </div>
            </div>

            {/* 2. Expanded Content Drawer */}
            {expanded && (
                <div className="flex w-80 flex-col border-r border-slate-200 bg-white shrink-0 shadow-sm animate-in slide-in-from-left duration-200">
                    
                    {/* Drawer Header */}
                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 bg-slate-50/50">
                        <h2 className="text-sm font-bold text-[#2e103f] capitalize">
                            {activeTab === "doors-windows" ? "Doors & Windows" : activeTab}
                        </h2>
                        <button
                            type="button"
                            onClick={() => setExpanded(false)}
                            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    {/* Drawer Scroll Container */}
                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                        
                        {/* A. CABINETS PANEL */}
                        {activeTab === "cabinet" && (
                            <>
                                {subFilter === null ? (
                                    <div className="grid grid-cols-2 gap-3 animate-in fade-in duration-200">
                                        {CABINET_CARDS.map((c) => (
                                            <SubCatCard
                                                key={c.id}
                                                card={c}
                                                onClick={() => handleSubCategoryClick(c.id)}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3 animate-in fade-in duration-200">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#531b7e] mb-1">
                                            <button
                                                type="button"
                                                onClick={() => setSubFilter(null)}
                                                className="hover:bg-purple-50 p-0.5 rounded transition-colors"
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </button>
                                            <button onClick={() => setSubFilter(null)} className="hover:underline">Home</button>
                                            <span className="text-slate-300">/</span>
                                            <span className="text-slate-700 capitalize">{subFilter}</span>
                                        </div>
                                        <AssetSearch value={query} onChange={setQuery} placeholder="Search cabinets..." />
                                        <AssetGrid
                                            items={items}
                                            activeAssetId={placingAsset?.id ?? null}
                                            onSelect={handleSelect}
                                        />
                                    </div>
                                )}
                            </>
                        )}

                        {/* B. APPLIANCES PANEL */}
                        {activeTab === "appliance" && (
                            <>
                                {subFilter === null ? (
                                    <div className="grid grid-cols-2 gap-3 animate-in fade-in duration-200">
                                        {APPLIANCE_CARDS.map((c) => (
                                            <SubCatCard
                                                key={c.id}
                                                card={c}
                                                onClick={() => handleSubCategoryClick(c.id)}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3 animate-in fade-in duration-200">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#531b7e] mb-1">
                                            <button
                                                type="button"
                                                onClick={() => setSubFilter(null)}
                                                className="hover:bg-purple-50 p-0.5 rounded transition-colors"
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </button>
                                            <button onClick={() => setSubFilter(null)} className="hover:underline">Home</button>
                                            <span className="text-slate-300">/</span>
                                            <span className="text-slate-700 capitalize">{subFilter === "range-oven" ? "Stoves & Ovens" : subFilter === "hood-microwave" ? "Hoods & Microwaves" : subFilter}</span>
                                        </div>
                                        <AssetSearch value={query} onChange={setQuery} placeholder="Search appliances..." />
                                        <AssetGrid
                                            items={items}
                                            activeAssetId={placingAsset?.id ?? null}
                                            onSelect={handleSelect}
                                        />
                                    </div>
                                )}
                            </>
                        )}

                        {/* C. DOORS & WINDOWS PANEL */}
                        {activeTab === "doors-windows" && (
                            <>
                                {subFilter === null ? (
                                    <div className="grid grid-cols-2 gap-3 animate-in fade-in duration-200">
                                        {OPENING_CARDS.map((c) => (
                                            <SubCatCard
                                                key={c.id}
                                                card={c}
                                                onClick={() => handleSubCategoryClick(c.id)}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3 animate-in fade-in duration-200">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#531b7e] mb-1">
                                            <button
                                                type="button"
                                                onClick={() => setSubFilter(null)}
                                                className="hover:bg-purple-50 p-0.5 rounded transition-colors"
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </button>
                                            <button onClick={() => setSubFilter(null)} className="hover:underline">Home</button>
                                            <span className="text-slate-300">/</span>
                                            <span className="text-slate-700 capitalize">{subFilter}</span>
                                        </div>
                                        <AssetSearch value={query} onChange={setQuery} placeholder="Search openings..." />
                                        <AssetGrid
                                            items={items}
                                            activeAssetId={placingAsset?.id ?? null}
                                            onSelect={handleSelect}
                                        />
                                    </div>
                                )}
                            </>
                        )}

                        {/* D. ROOM STYLING CONFIGURATIONS */}
                        {activeTab === "styling" && (
                            <div className="flex flex-col gap-4 animate-in fade-in duration-200">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
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

                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1 pt-2">
                                    <Grid3X3 className="h-3.5 w-3.5 text-[#531b7e]" /> Grid Settings
                                </h3>

                                <div className="flex flex-col gap-3 rounded-lg border border-slate-100 bg-slate-50/50 p-3 text-xs">
                                    <label className="flex items-center justify-between font-semibold text-slate-600">
                                        Snap to Grid
                                        <input
                                            type="checkbox"
                                            checked={snapToGrid}
                                            onChange={(e) => setSnapToGrid(e.target.checked)}
                                            className="rounded border-slate-300 text-[#531b7e] focus:ring-[#531b7e] h-4 w-4"
                                        />
                                    </label>
                                    
                                    <div className="flex flex-col gap-1">
                                        <span className="font-semibold text-slate-600 flex justify-between">
                                            Grid Size <span>{Math.round(gridSize * 100)} cm</span>
                                        </span>
                                        <input
                                            type="range"
                                            min="0.05"
                                            max="0.5"
                                            step="0.05"
                                            value={gridSize}
                                            onChange={(e) => setGridSize(parseFloat(e.target.value))}
                                            className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#531b7e]"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* E. FINISHING MATERIALS */}
                        {activeTab === "finishing" && (
                            <div className="flex flex-col gap-4 animate-in fade-in duration-200 text-xs">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                                    Floor Material
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    {FLOOR_MATERIALS.map((m) => (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => setSurfaceMaterial("floor", m.id)}
                                            className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/40 p-2 hover:border-purple-200 hover:bg-purple-50/20 transition-all text-center"
                                        >
                                            <div className={`h-8 w-12 rounded shadow-sm ${m.color}`} />
                                            <span className="font-medium text-slate-700 text-[10px]">{m.name}</span>
                                        </button>
                                    ))}
                                </div>

                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 pt-2">
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
                                            className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50/40 p-2 hover:border-purple-200 hover:bg-purple-50/20 transition-all text-center"
                                        >
                                            <div className={`h-8 w-12 rounded shadow-sm ${m.color}`} />
                                            <span className="font-medium text-slate-700 text-[10px]">{m.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* F. REVIEW & QUOTE SUMMARY */}
                        {activeTab === "review" && (
                            <div className="flex flex-col gap-3 animate-in fade-in duration-200 text-xs">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                                    Placed Assets checklist
                                </h3>
                                
                                {assets.length === 0 ? (
                                    <p className="text-slate-400 italic p-2 text-center">No items placed in this room yet.</p>
                                ) : (
                                    <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                                        {assets.map((a) => {
                                            const reg = getAsset(a.assetId);
                                            return (
                                                <div key={a.id} className="flex justify-between items-center py-1 border-b border-slate-100 last:border-0 font-medium text-slate-700">
                                                    <span className="truncate max-w-[160px]">{reg?.name ?? "Custom"}</span>
                                                    <span className="text-[10px] bg-slate-200/60 rounded px-1.5 py-0.5 capitalize text-slate-600 font-semibold">{a.assetType}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                <div className="rounded-lg bg-purple-50 border border-purple-100 p-3 mt-2 flex flex-col gap-1">
                                    <div className="flex justify-between font-bold text-[#2e103f]">
                                        <span>Estimated Cost</span>
                                        <span>${assets.length * 179 + 450}</span>
                                    </div>
                                    <p className="text-[10px] text-purple-700 font-medium flex items-center gap-1 mt-1">
                                        <Info className="h-3 w-3" /> Fully integrated with Goldentouch Estimates
                                    </p>
                                </div>
                            </div>
                        )}

                    </div>

                    {/* Placement Helper Message */}
                    {placingAsset && (
                        <div className="m-4 rounded-md border border-blue-200 bg-blue-50/60 p-2.5 text-[10px] text-blue-900 leading-normal animate-pulse">
                            Click on the canvas to place <b>{placingAsset.name}</b>, or press <b>Esc</b> to cancel.
                        </div>
                    )}

                </div>
            )}

        </div>
    );
}

// Nav strip button helper
function NavBtn({
    active, label, onClick, children
}: {
    active: boolean;
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={
                "group flex w-full flex-col items-center gap-1.5 py-3 transition text-center outline-none " +
                (active
                    ? "bg-[#2E103F] text-white border-l-4 border-purple-500 font-semibold"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/30")
            }
        >
            {children}
            <span className="text-[9px] font-medium tracking-wide uppercase px-1 leading-tight max-w-[70px] truncate">
                {label}
            </span>
        </button>
    );
}

// Visual category card helper
function SubCatCard({
    card, onClick
}: {
    card: SubCategoryCard;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex flex-col items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/30 p-3 hover:border-purple-200 hover:bg-purple-50/20 active:scale-[0.98] transition-all text-center group"
        >
            <div className="flex h-12 w-16 items-center justify-center rounded-lg bg-slate-100/60 border border-slate-200/40 text-slate-500 text-xs font-bold tracking-wider group-hover:bg-[#531b7e]/10 group-hover:text-[#531b7e] transition-colors shadow-sm">
                {card.icon}
            </div>
            <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-slate-800 text-[11px] group-hover:text-[#531b7e] transition-colors leading-tight">
                    {card.label}
                </span>
                <span className="text-[9px] text-slate-400 leading-normal max-w-[120px] font-medium">
                    {card.description}
                </span>
            </div>
        </button>
    );
}
