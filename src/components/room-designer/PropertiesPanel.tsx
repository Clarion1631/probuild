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
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import { WallBuilder } from "./WallBuilder";
import { CabinetConfigurator } from "./CabinetConfigurator";
import { ApplianceProperties } from "./ApplianceProperties";
import { FixtureProperties } from "./FixtureProperties";
import { MaterialLibrary } from "./materials/MaterialLibrary";
import { useRoomStore, useSelectedAssetId } from "./hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";
import { M_TO_IN, IN_TO_M, fmtInches, radToDeg, degToRad } from "@/lib/room-designer/units";
import type { AssetCategory, PlacedAsset } from "./types";

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

    const multi = selectionCount > 1;

    return (
        <aside className="flex h-full w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-slate-200 bg-white p-4">
            {/* Stage 2: surface materials. Mutually exclusive with the asset
                panel below — the store enforces it via setActiveSurface/selectAsset. */}
            {activeSurface && (
                <div className="border-b border-slate-100 pb-4">
                    <MaterialLibrary />
                </div>
            )}

            <WallBuilder />

            <div className="border-t border-slate-100 pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
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
                    <p className="mt-2 text-sm text-slate-400">
                        {activeSurface
                            ? "Editing a surface — pick an item to switch back to the inspector."
                            : "Click an item or surface in the scene to inspect it."}
                    </p>
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
            <p className="text-slate-500">
                Use the alignment toolbar above the canvas to align or distribute. Arrow
                keys nudge every selected item.
            </p>
            <button
                type="button"
                onClick={onDelete}
                className="hui-btn w-full border-red-200 bg-red-50 text-xs font-medium text-red-700 hover:border-red-300 hover:bg-red-100"
            >
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
    onDelete: () => void;
}

function SelectedPanel({
    placed,
    registry,
    locked,
    firstInputRef,
    onPositionChange,
    onRotationChange,
    onDelete,
}: SelectedPanelProps) {
    const dims = resolveDimensions(placed, registry);
    const category = placed.assetType;

    return (
        <div className="mt-2 space-y-4 text-sm">
            {/* Thumbnail + title */}
            <div className="flex items-center gap-3">
                <div
                    className="flex h-12 w-12 items-center justify-center rounded text-xl text-white/90"
                    style={{ backgroundColor: CATEGORY_COLORS[category] }}
                >
                    {categoryIcon(category)}
                </div>
                <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900">{registry.name}</div>
                    <div className="truncate text-xs capitalize text-slate-500">
                        {category} · {registry.subcategory}
                        {locked && <span className="ml-1 text-amber-700">· Locked</span>}
                    </div>
                </div>
            </div>

            {/* W × H × D (resolved) */}
            <dl className="grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-2 text-xs">
                <div>
                    <dt className="text-slate-500">W</dt>
                    <dd className="font-medium">{fmtInches(dims.width)}</dd>
                </div>
                <div>
                    <dt className="text-slate-500">H</dt>
                    <dd className="font-medium">{fmtInches(dims.height)}</dd>
                </div>
                <div>
                    <dt className="text-slate-500">D</dt>
                    <dd className="font-medium">{fmtInches(dims.depth)}</dd>
                </div>
            </dl>

            {/* Position (inches, bidirectional with meters) */}
            <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Position (inches)
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                    <AxisInput
                        label="X"
                        meters={placed.position.x}
                        disabled={locked}
                        onChange={(m) => onPositionChange("x", m)}
                        inputRef={firstInputRef}
                    />
                    <AxisInput
                        label="Y"
                        meters={placed.position.y}
                        disabled={locked}
                        onChange={(m) => onPositionChange("y", m)}
                    />
                    <AxisInput
                        label="Z"
                        meters={placed.position.z}
                        disabled={locked}
                        onChange={(m) => onPositionChange("z", m)}
                    />
                </div>
            </section>

            {/* Rotation (degrees ↔ radians) */}
            <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Rotation (°)
                </div>
                <input
                    type="number"
                    step={5}
                    disabled={locked}
                    value={Math.round(radToDeg(placed.rotationY))}
                    onChange={(e) => {
                        const d = parseFloat(e.target.value);
                        if (Number.isFinite(d)) onRotationChange(degToRad(d));
                    }}
                    className="hui-input w-full py-1 text-sm disabled:opacity-50"
                />
            </section>

            {/* Category-specific configurator */}
            {category === "cabinet" && <CabinetConfigurator placed={placed} />}
            {category === "appliance" && <ApplianceProperties placed={placed} />}
            {category === "fixture" && <FixtureProperties placed={placed} />}
            {(category === "window" || category === "door") && (
                <div className="rounded-md border border-dashed border-slate-200 p-2 text-xs text-slate-500">
                    No finish options for {category}s yet.
                </div>
            )}

            {/* Replace (Stage 3 stub) + Delete */}
            <div className="flex gap-2 pt-1">
                <button
                    type="button"
                    disabled
                    title="Coming in Stage 3"
                    className="hui-btn flex-1 border-slate-200 bg-slate-50 text-xs font-medium text-slate-400"
                >
                    Replace
                </button>
                <button
                    type="button"
                    onClick={onDelete}
                    disabled={locked}
                    className="hui-btn flex-1 border-red-200 bg-red-50 text-xs font-medium text-red-700 hover:border-red-300 hover:bg-red-100 disabled:opacity-40"
                >
                    Delete
                </button>
            </div>
        </div>
    );
}

interface AxisInputProps {
    label: string;
    meters: number;
    disabled?: boolean;
    onChange: (nextMeters: number) => void;
    inputRef?: React.RefObject<HTMLInputElement | null>;
}

function AxisInput({ label, meters, disabled, onChange, inputRef }: AxisInputProps) {
    return (
        <label className="flex items-center gap-1.5 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs focus-within:border-slate-400">
            <span className="text-slate-500">{label}</span>
            <input
                ref={inputRef}
                type="number"
                step={1}
                disabled={disabled}
                value={Number((meters * M_TO_IN).toFixed(1))}
                onChange={(e) => {
                    const inches = parseFloat(e.target.value);
                    if (Number.isFinite(inches)) onChange(inches * IN_TO_M);
                }}
                className="min-w-0 flex-1 bg-transparent text-right text-xs text-slate-900 outline-none disabled:opacity-50"
            />
        </label>
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
