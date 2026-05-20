// Right sidebar. Stage 2: WallBuilder (room dimensions) at top, then selected-
// asset details — thumbnail, dimensions, position/rotation inputs, and the
// category-specific configurator. Replace (Stage 3 stub) and Delete buttons
// at the bottom.
//
// Stage 3:
//   - Multi-select summary when more than one asset is picked.
//   - Inputs disabled while the target is locked.
//   - Unit helpers moved to `src/lib/room-designer/units.ts` so the
//     MeasurementInputBar shares one source of truth.

import { useEffect, useRef } from "react";
import { getAsset, CATEGORY_COLORS, type Asset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions, CABINET_FINISH_COLORS } from "@/lib/room-designer/asset-resolve";
import { WallBuilder } from "./WallBuilder";
import { CabinetConfigurator } from "./CabinetConfigurator";
import { ApplianceProperties } from "./ApplianceProperties";
import { FixtureProperties } from "./FixtureProperties";
import { MaterialLibrary } from "./materials/MaterialLibrary";
import { useRoomStore, useSelectedAssetId } from "./hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";
import { M_TO_IN, IN_TO_M, fmtInches, radToDeg, degToRad } from "@/lib/room-designer/units";
import { roomBounds } from "@/components/room-designer/core/geometry";
import type { AssetCategory, PlacedAsset, CabinetMeta, CabinetDoorStyle, CabinetFinishPreset, CabinetHardware } from "./types";
import { X, Copy, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function PropertiesPanel() {
    const selectedAssetId = useSelectedAssetId();
    const selectionCount = useRoomStore((s) => s.selectedAssetIds.length);
    const assets = useRoomStore((s) => s.assets);
    const updateAsset = useRoomStore((s) => s.updateAsset);
    const removeAsset = useRoomStore((s) => s.removeAsset);
    const clearSelection = useRoomStore((s) => s.clearSelection);
    const focusPropertiesTick = useRoomStore((s) => s.focusPropertiesTick);
    const activeSurface = useRoomStore((s) => s.activeSurface);
    const selectedAssetIds = useRoomStore((s) => s.selectedAssetIds);
    const setShowProperties = useRoomStore((s) => s.setShowProperties);
    const addAsset = useRoomStore((s) => s.addAsset);
    const gridSize = useRoomStore((s) => s.gridSize);

    const placed = selectedAssetId ? assets.find((a) => a.id === selectedAssetId) ?? null : null;
    const registry = placed ? getAsset(placed.assetId) : null;
    const locked = placed ? isLocked(placed) : false;

    const firstInputRef = useRef<HTMLInputElement | null>(null);

    // `G` key → store bumps focusPropertiesTick → we focus the first input.
    useEffect(() => {
        if (focusPropertiesTick > 0 && firstInputRef.current) {
            firstInputRef.current.focus();
            firstInputRef.current.select();
        }
    }, [focusPropertiesTick]);

    const onDuplicate = () => {
        if (!placed || locked) return;
        const dup: PlacedAsset = {
            ...placed,
            id: `temp-${Math.random().toString(36).slice(2, 10)}`,
            position: {
                x: placed.position.x + gridSize,
                y: placed.position.y,
                z: placed.position.z + gridSize,
            },
        };
        addAsset(dup);
    };

    const multi = selectionCount > 1;

    return (
        <aside className="flex h-full w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-slate-200 bg-white p-4">
            {/* Header with Close X Button */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="text-xs font-bold text-[#2e103f] uppercase tracking-wider">Object Properties</h2>
                <button
                    type="button"
                    onClick={() => setShowProperties(false)}
                    className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
                    aria-label="Close properties panel"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {/* Stage 2: surface materials. Mutually exclusive with the asset
                panel below — the store enforces it via setActiveSurface/selectAsset. */}
            {activeSurface && (
                <div className="border-b border-slate-100 pb-4">
                    <MaterialLibrary />
                </div>
            )}

            <WallBuilder />

            <div className="border-t border-slate-100 pt-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    {multi ? `${selectionCount} items selected` : "Selected Item"}
                </h3>

                {multi ? (
                    <MultiSelectSummary
                        count={selectionCount}
                        onDelete={() => {
                            for (const id of selectedAssetIds) removeAsset(id);
                            clearSelection();
                        }}
                    />
                ) : !placed || !registry ? (
                    <div className="space-y-4">
                        <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                            {activeSurface
                                ? "Editing a surface — pick an item to switch back to the inspector."
                                : "Click an item or surface in the scene to inspect it."}
                        </p>
                        {!activeSurface && <GlobalCabinetSync />}
                    </div>
                ) : (
                    <SelectedPanel
                        placed={placed}
                        registry={registry}
                        locked={locked}
                        firstInputRef={firstInputRef}
                        onPositionChange={(axis, meters) =>
                            updateAsset(placed.id, {
                                position: { ...placed.position, [axis]: meters },
                            })
                        }
                        onRotationChange={(radians) =>
                            updateAsset(placed.id, { rotationY: radians })
                        }
                        onDuplicate={onDuplicate}
                        onDelete={() => {
                            removeAsset(placed.id);
                            clearSelection();
                        }}
                    />
                )}
            </div>
        </aside>
    );
}

interface MultiSelectSummaryProps {
    count: number;
    onDelete: () => void;
}

function MultiSelectSummary({ count, onDelete }: MultiSelectSummaryProps) {
    return (
        <div className="mt-2 space-y-3 text-sm">
            <p className="text-slate-500 text-xs leading-normal">
                Use the alignment toolbar above the canvas to align or distribute. Arrow
                keys nudge every selected item.
            </p>
            <button
                type="button"
                onClick={onDelete}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 py-2 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-100 transition-colors"
            >
                <Trash2 className="h-3.5 w-3.5" />
                Delete {count} items
            </button>
        </div>
    );
}

interface SelectedPanelProps {
    placed: PlacedAsset;
    registry: Asset;
    locked: boolean;
    firstInputRef: React.RefObject<HTMLInputElement | null>;
    onPositionChange: (axis: "x" | "y" | "z", meters: number) => void;
    onRotationChange: (radians: number) => void;
    onDuplicate: () => void;
    onDelete: () => void;
}

function SelectedPanel({
    placed,
    registry,
    locked,
    firstInputRef,
    onPositionChange,
    onRotationChange,
    onDuplicate,
    onDelete,
}: SelectedPanelProps) {
    const dims = resolveDimensions(placed, registry);
    const category = placed.assetType;
    const sku = `${registry.category.slice(0, 2).toUpperCase()}-${placed.id.slice(5, 12).toUpperCase()}`;

    // Get current room bounds from store layout
    const layout = useRoomStore((s) => s.layout);
    const bounds = roomBounds(layout);

    // X axis wall offsets (Left/Right)
    const leftDist = (placed.position.x - dims.width / 2) - bounds.minX;
    const rightDist = bounds.maxX - (placed.position.x + dims.width / 2);

    // Z axis wall offsets (Front/Back)
    const backDist = (placed.position.z - dims.depth / 2) - bounds.minZ;
    const frontDist = bounds.maxZ - (placed.position.z + dims.depth / 2);

    // Dynamic Cabinet Details matching RTA visual design
    const meta = (placed.metadata?.cabinet ?? {}) as CabinetMeta;
    const doorStyle = meta.doorStyle ? meta.doorStyle.charAt(0).toUpperCase() + meta.doorStyle.slice(1) : "Shaker";
    const finish = meta.finish ? meta.finish.charAt(0).toUpperCase() + meta.finish.slice(1) : "Brilliant White Shaker";
    const installType = "Ready-to-Assemble";
    // Mock realistic pricing based on dimensions
    const price = Math.round(dims.width * dims.height * dims.depth * 2250);

    return (
        <div className="mt-3 space-y-4 text-sm">
            {/* Top Side-by-side Actions (Duplicate / Delete) */}
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={onDuplicate}
                    disabled={locked}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-[#531b7e] bg-white py-2 text-xs font-semibold text-[#531b7e] hover:bg-purple-50 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                >
                    <Copy className="h-3.5 w-3.5" />
                    Duplicate
                </button>
                <button
                    type="button"
                    onClick={onDelete}
                    disabled={locked}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-[#531b7e] py-2 text-xs font-semibold text-white hover:bg-[#431466] transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                </button>
            </div>

            {/* Beautiful Centered Asset Showcase Card */}
            <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50 border border-slate-100 p-5 shadow-sm relative overflow-hidden group">
                <div
                    className="flex h-16 w-16 items-center justify-center rounded-full text-3xl text-white/90 shadow-md transition-transform duration-300 group-hover:scale-105"
                    style={{ backgroundColor: CATEGORY_COLORS[category] }}
                >
                    {categoryIcon(category)}
                </div>
                <div className="mt-3 text-center min-w-0 w-full px-1">
                    <h4 className="font-bold text-[#2e103f] text-sm truncate leading-snug">{registry.name}</h4>
                    <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 font-mono">
                        SKU: {sku}
                    </p>
                    {locked && (
                        <span className="inline-block mt-1 px-1.5 py-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 border border-amber-200 rounded">
                            Locked
                        </span>
                    )}
                </div>
            </div>

            {/* Detailed RTA Cabinet Metadata & Live Mock Pricing */}
            {category === "cabinet" && (
                <div className="rounded-xl border border-slate-100 bg-slate-50/20 p-3.5 space-y-2.5 text-xs">
                    <div className="flex justify-between border-b border-slate-100 pb-1.5">
                        <span className="text-slate-400 font-medium">Cabinet Details</span>
                        <span className="font-bold text-slate-700">
                            {Math.round(dims.width * M_TO_IN)}x{Math.round(dims.height * M_TO_IN)}x{Math.round(dims.depth * M_TO_IN)} {registry.name}
                        </span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-slate-400 font-medium">Door Style:</span>
                        <span className="font-bold text-slate-700">{doorStyle}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-slate-400 font-medium">Door Finish:</span>
                        <span className="font-bold text-slate-700 truncate max-w-[150px]">{finish}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-100 pb-2">
                        <span className="text-slate-400 font-medium">Installation:</span>
                        <span className="font-bold text-slate-700">{installType}</span>
                    </div>
                    <div className="flex justify-between items-center pt-1">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Pricing</span>
                        <div className="text-right">
                            <span className="text-xs text-slate-400 line-through mr-1.5">${Math.round(price * 1.2)}</span>
                            <span className="text-sm font-extrabold text-[#531b7e]">${price}</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Dimensions (W x H x D) */}
            <div className="grid grid-cols-3 gap-2 border-y border-slate-100 py-3 text-xs">
                <div className="text-center border-r border-slate-100">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Width</div>
                    <div className="text-sm font-bold text-[#2e103f] mt-0.5">{fmtInches(dims.width)}</div>
                </div>
                <div className="text-center border-r border-slate-100">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Height</div>
                    <div className="text-sm font-bold text-[#2e103f] mt-0.5">{fmtInches(dims.height)}</div>
                </div>
                <div className="text-center">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Depth</div>
                    <div className="text-sm font-bold text-[#2e103f] mt-0.5">{fmtInches(dims.depth)}</div>
                </div>
            </div>

            {/* RTA Positioning Controls (2x2/2x3 Clean Grid) */}
            <section className="space-y-4 pt-1">
                <div className="text-xs font-bold text-[#531b7e] border-b border-slate-100 pb-1.5 flex items-center justify-between">
                    <span>Position</span>
                    <span className="text-[10px] text-slate-400 font-normal uppercase font-mono">Inches / Degrees</span>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
                    {/* Front & Back */}
                    <PositionInputField
                        label="Front *"
                        value={frontDist}
                        unit="in"
                        disabled={locked}
                        onChange={(val) => onPositionChange("z", bounds.maxZ - val * IN_TO_M - dims.depth / 2)}
                    />
                    <PositionInputField
                        label="Back *"
                        value={backDist}
                        unit="in"
                        disabled={locked}
                        onChange={(val) => onPositionChange("z", val * IN_TO_M + bounds.minZ + dims.depth / 2)}
                    />

                    {/* Left & Right */}
                    <PositionInputField
                        label="Left *"
                        value={leftDist}
                        unit="in"
                        disabled={locked}
                        inputRef={firstInputRef}
                        onChange={(val) => onPositionChange("x", val * IN_TO_M + bounds.minX + dims.width / 2)}
                    />
                    <PositionInputField
                        label="Right *"
                        value={rightDist}
                        unit="in"
                        disabled={locked}
                        onChange={(val) => onPositionChange("x", bounds.maxX - val * IN_TO_M - dims.width / 2)}
                    />

                    {/* Rotation & Elevation */}
                    <PositionInputField
                        label="Rotation *"
                        value={Math.round(radToDeg(placed.rotationY))}
                        unit="°"
                        disabled={locked}
                        onChange={(val) => onRotationChange(degToRad(val))}
                    />
                    <PositionInputField
                        label="Distance from floor *"
                        value={placed.position.y}
                        unit="in"
                        disabled={locked}
                        isMeters={true}
                        onChange={(val) => onPositionChange("y", val * IN_TO_M)}
                    />
                </div>
            </section>

            {/* Category-specific configurator */}
            {category === "cabinet" && <CabinetConfigurator placed={placed} />}
            {category === "appliance" && <ApplianceProperties placed={placed} />}
            {category === "fixture" && <FixtureProperties placed={placed} />}
        </div>
    );
}

interface PositionInputFieldProps {
    label: string;
    value: number;
    unit: string;
    disabled?: boolean;
    isMeters?: boolean;
    onChange: (nextValue: number) => void;
    inputRef?: React.RefObject<HTMLInputElement | null>;
}

function PositionInputField({
    label,
    value,
    unit,
    disabled,
    isMeters = false,
    onChange,
    inputRef,
}: PositionInputFieldProps) {
    const numericValue = unit === "in" ? value * M_TO_IN : value;
    const displayValue = Math.max(0, Number(numericValue.toFixed(1)));

    return (
        <div className="flex flex-col gap-1 w-full text-xs">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                {label}
            </span>
            <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/30 px-3 py-2 transition-colors focus-within:border-[#531b7e] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#531b7e]/10">
                <input
                    ref={inputRef}
                    type="number"
                    step={unit === "in" ? 1 : 5}
                    disabled={disabled}
                    value={displayValue}
                    onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (Number.isFinite(val)) onChange(val);
                    }}
                    className="w-full bg-transparent text-left font-bold text-[#531b7e] outline-none disabled:opacity-50"
                />
                <span className="text-slate-400 font-bold ml-1 text-[11px] uppercase tracking-wide">
                    {unit}
                </span>
            </label>
        </div>
    );
}

function categoryIcon(c: AssetCategory): string {
    switch (c) {
        case "cabinet": return "▦";
        case "appliance": return "◨";
        case "fixture": return "◉";
        case "window": return "▣";
        case "door": return "▯";
        case "lighting": return "✦";
        case "plants": return "❦";
    }
}

// ─────────────── Global Cabinet Sync ───────────────

const PRESET_COLLECTIONS = [
    {
        name: "Classic White Shaker",
        description: "Timeless shaker door in bright white finish with sleek bar pulls.",
        cabinet: { doorStyle: "shaker" as CabinetDoorStyle, finish: "white" as CabinetFinishPreset, hardware: "bar-pull" as CabinetHardware },
        bgHex: "#ffffff",
    },
    {
        name: "Navy Brass",
        description: "Modern flat doors in deep navy blue paired with sleek edge pulls.",
        cabinet: { doorStyle: "flat" as CabinetDoorStyle, finish: "navy" as CabinetFinishPreset, hardware: "edge-pull" as CabinetHardware },
        bgHex: "#0f1e36",
    },
    {
        name: "Walnut Deluxe",
        description: "Warm walnut wood slab cabinet fronts with minimal design.",
        cabinet: { doorStyle: "flat" as CabinetDoorStyle, finish: "walnut" as CabinetFinishPreset, hardware: "none" as CabinetHardware },
        bgHex: "#5c4033",
    },
    {
        name: "Gray Traditional",
        description: "Elegant raised panels in charcoal gray with traditional brass knobs.",
        cabinet: { doorStyle: "raised" as CabinetDoorStyle, finish: "gray" as CabinetFinishPreset, hardware: "knob" as CabinetHardware },
        bgHex: "#5a5a5a",
    },
    {
        name: "Cream Luxury",
        description: "Warm cream raised panels with classic vintage cup pulls.",
        cabinet: { doorStyle: "raised" as CabinetDoorStyle, finish: "cream" as CabinetFinishPreset, hardware: "cup-pull" as CabinetHardware },
        bgHex: "#fdf6e2",
    },
];

const DOOR_STYLES: CabinetDoorStyle[] = ["shaker", "flat", "raised", "glass", "open"];
const HARDWARE: CabinetHardware[] = ["none", "bar-pull", "cup-pull", "knob", "edge-pull"];
const FINISH_PRESETS: CabinetFinishPreset[] = [
    "white", "gray", "navy", "green", "wood", "walnut", "two-tone", "black", "cream",
];

function cap(s: string): string {
    return s
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

export function GlobalCabinetSync() {
    const assets = useRoomStore((s) => s.assets);
    const updateAssets = useRoomStore((s) => s.updateAssets);

    const cabinetsCount = assets.filter((a) => a.assetType === "cabinet").length;

    const applyGlobalStyle = (cabinetPatch: Partial<CabinetMeta>, description: string) => {
        const cabinets = assets.filter((a) => a.assetType === "cabinet");
        if (cabinets.length === 0) {
            toast.error("No cabinets placed in the room to sync.");
            return;
        }

        const patches = cabinets.map((c) => {
            const oldMeta = c.metadata ?? {};
            const oldCab = (oldMeta.cabinet ?? {}) as Record<string, unknown>;
            return {
                id: c.id,
                patch: {
                    metadata: {
                        ...oldMeta,
                        cabinet: {
                            ...oldCab,
                            ...cabinetPatch,
                        },
                    },
                },
            };
        });

        updateAssets(patches);
        toast.success(`Applied ${description} to all ${cabinets.length} cabinets!`);
    };

    return (
        <div className="space-y-4 rounded-xl border border-slate-100 bg-slate-50/20 p-3.5 mt-2">
            <div>
                <h4 className="text-[11px] font-bold text-[#531b7e] uppercase tracking-wider">
                    Global Cabinet Sync
                </h4>
                <p className="text-[10px] text-slate-400 mt-0.5 leading-normal">
                    Batch-apply door styles, finishes, or hardware across all placed cabinets.
                </p>
            </div>

            {/* Presets Grid */}
            <div className="space-y-2">
                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block">
                    Preset Collections
                </span>
                <div className="grid grid-cols-1 gap-2">
                    {PRESET_COLLECTIONS.map((p) => (
                        <button
                            key={p.name}
                            type="button"
                            onClick={() => applyGlobalStyle(p.cabinet, `${p.name} Style Preset`)}
                            className="group flex items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5 text-left transition hover:border-[#531b7e] hover:shadow-sm"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="text-xs font-bold text-slate-800 group-hover:text-[#531b7e] flex items-center gap-1.5">
                                    <span
                                        className="h-2.5 w-2.5 shrink-0 rounded-full border shadow-sm"
                                        style={{ backgroundColor: p.bgHex }}
                                    />
                                    {p.name}
                                </div>
                                <div className="text-[9px] text-slate-400 truncate mt-0.5">
                                    {p.description}
                                </div>
                            </div>
                            <span className="text-[9px] font-bold uppercase tracking-wider text-[#531b7e]/70 bg-purple-50 group-hover:bg-[#531b7e] group-hover:text-white px-1.5 py-0.5 rounded transition">
                                Apply
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            <hr className="border-slate-100" />

            {/* Individual Attribute Selectors */}
            <div className="space-y-3">
                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block">
                    Sync Individual Attributes
                </span>

                {/* Door Style Sync */}
                <div className="space-y-1">
                    <span className="text-[10px] font-semibold text-slate-400">Door Style</span>
                    <div className="flex flex-wrap gap-1">
                        {DOOR_STYLES.map((style) => (
                            <button
                                key={style}
                                type="button"
                                onClick={() => applyGlobalStyle({ doorStyle: style }, `${cap(style)} Door Style`)}
                                className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-[#531b7e] hover:bg-purple-50/20 hover:text-[#531b7e] transition"
                            >
                                {cap(style)}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Finish Sync */}
                <div className="space-y-1">
                    <span className="text-[10px] font-semibold text-slate-400">Finish Color</span>
                    <div className="grid grid-cols-5 gap-1.5">
                        {FINISH_PRESETS.map((f) => {
                            const hex = CABINET_FINISH_COLORS[f];
                            return (
                                <button
                                    key={f}
                                    type="button"
                                    onClick={() => applyGlobalStyle({ finish: f }, `${cap(f)} Finish`)}
                                    title={`Sync all to ${cap(f)}`}
                                    aria-label={f}
                                    className="h-6 rounded border border-slate-200 hover:border-[#531b7e] hover:scale-105 transition shadow-sm"
                                    style={{ backgroundColor: hex }}
                                />
                            );
                        })}
                    </div>
                </div>

                {/* Hardware Sync */}
                <div className="space-y-1">
                    <span className="text-[10px] font-semibold text-slate-400">Hardware Pulls</span>
                    <div className="flex flex-wrap gap-1">
                        {HARDWARE.map((hw) => (
                            <button
                                key={hw}
                                type="button"
                                onClick={() => applyGlobalStyle({ hardware: hw }, `${cap(hw)} Hardware`)}
                                className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[9px] font-semibold text-slate-600 hover:border-[#531b7e] hover:bg-purple-50/20 hover:text-[#531b7e] transition truncate"
                            >
                                {cap(hw)}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {cabinetsCount > 0 ? (
                <div className="text-[9px] text-center text-emerald-600 font-semibold bg-emerald-50 rounded py-1 px-1.5 mt-2 border border-emerald-100">
                    ✓ Found {cabinetsCount} cabinet{cabinetsCount > 1 ? "s" : ""} in room
                </div>
            ) : (
                <div className="text-[9px] text-center text-amber-600 font-semibold bg-amber-50 rounded py-1 px-1.5 mt-2 border border-amber-100">
                    ⚠ Place cabinets from library to enable sync
                </div>
            )}
        </div>
    );
}
