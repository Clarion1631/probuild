"use client";

// Right-sidebar swatch grid. Renders when an `activeSurface` is set in the
// store. Cabinet finishes are NOT shown here — CabinetConfigurator owns
// cabinet finish/door style/hardware. MaterialLibrary handles room surfaces:
// floor, walls, ceiling, backsplash, countertop.
//
// Hover preview rules (Stage 2 D6): mouse-enter writes to `useHoverPreview`
// (a separate store, not the room store) so it never marks dirty or pushes
// history. Click commits via `setSurfaceMaterial`, which goes through
// setLayout → pushHistory → autosave.

import { useMemo } from "react";
import {
    MATERIALS_BY_CATEGORY,
    type Material,
    type MaterialCategory,
} from "@/lib/room-designer/material-registry";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { useHoverPreview } from "./useMaterials";
import {
    ALL_SURFACES,
    categoriesForSurface,
    surfaceLabel,
} from "./SurfaceSelector";
import type { RoomSurface } from "@/components/room-designer/types";

export function MaterialLibrary() {
    const activeSurface = useRoomStore((s) => s.activeSurface);
    const setActiveSurface = useRoomStore((s) => s.setActiveSurface);
    const setSurfaceMaterial = useRoomStore((s) => s.setSurfaceMaterial);
    const currentMaterialId = useRoomStore((s) =>
        s.activeSurface ? s.layout.surfaces[s.activeSurface] ?? null : null,
    );
    const setHover = useHoverPreview((s) => s.setHover);
    const clearHover = useHoverPreview((s) => s.clearHover);

    const visibleCategories = useMemo<readonly MaterialCategory[]>(
        () => (activeSurface ? (categoriesForSurface(activeSurface) as MaterialCategory[]) : []),
        [activeSurface],
    );

    if (!activeSurface) return null;

    return (
        <section
            className="space-y-3"
            // Make sure leaving the panel without crossing a swatch resets preview.
            onMouseLeave={clearHover}
        >
            <header className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Materials
                </h3>
                <button
                    type="button"
                    onClick={() => setActiveSurface(null)}
                    className="text-[11px] text-slate-400 hover:text-slate-700"
                    aria-label="Close materials panel"
                >
                    ✕
                </button>
            </header>

            {/* Target dropdown — keeps backsplash/countertop reachable without canvas geometry. */}
            <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Surface
                </span>
                <select
                    value={activeSurface}
                    onChange={(e) => setActiveSurface(e.target.value as RoomSurface)}
                    className="hui-input w-full text-sm"
                >
                    {ALL_SURFACES.map((s) => (
                        <option key={s} value={s}>
                            {surfaceLabel(s)}
                        </option>
                    ))}
                </select>
            </label>

            {visibleCategories.map((cat) => {
                const items = MATERIALS_BY_CATEGORY[cat];
                if (items.length === 0) return null;
                return (
                    <div key={cat}>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            {humanCategory(cat)}
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                            {items.map((m) => (
                                <Swatch
                                    key={m.id}
                                    material={m}
                                    selected={currentMaterialId === m.id}
                                    onHover={() => setHover(activeSurface, m.id)}
                                    onLeave={clearHover}
                                    onCommit={() => {
                                        clearHover();
                                        setSurfaceMaterial(activeSurface, m.id);
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}

            {currentMaterialId && (
                <button
                    type="button"
                    onClick={() => setSurfaceMaterial(activeSurface, null)}
                    className="hui-btn w-full text-xs"
                >
                    Clear material
                </button>
            )}
        </section>
    );
}

function Swatch({
    material,
    selected,
    onHover,
    onLeave,
    onCommit,
}: {
    material: Material;
    selected: boolean;
    onHover: () => void;
    onLeave: () => void;
    onCommit: () => void;
}) {
    return (
        <button
            type="button"
            onMouseEnter={onHover}
            onMouseLeave={onLeave}
            onTouchStart={onHover}
            onClick={onCommit}
            title={material.name}
            aria-label={material.name}
            aria-pressed={selected}
            className={`group flex flex-col items-center gap-1 rounded border-2 p-1 text-[10px] transition ${
                selected
                    ? "border-blue-500 ring-1 ring-blue-200"
                    : "border-slate-200 hover:border-slate-400"
            }`}
        >
            <span
                className="block h-8 w-full rounded"
                style={{ backgroundColor: material.color }}
            />
            <span className="block truncate text-slate-700 group-hover:text-slate-900">
                {material.name}
            </span>
        </button>
    );
}

function humanCategory(c: MaterialCategory): string {
    switch (c) {
        case "wall-paint": return "Paint";
        case "cabinet-finish": return "Cabinet finish";
        default: return c.charAt(0).toUpperCase() + c.slice(1);
    }
}
