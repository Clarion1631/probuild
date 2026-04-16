// Simple room dimensions editor — W × L × H in feet + inches.
// When the user changes dimensions, we rebuild the rectangular wall layout.
// Stage 1 will replace this with free-form wall drawing on the 2D canvas.

import { useMemo } from "react";
import { useRoomStore } from "./hooks/useRoomStore";
import { DEFAULT_ROOM_DIMENSIONS } from "./types";

const METERS_PER_FOOT = 0.3048;
const METERS_PER_INCH = 0.0254;

function metersToFtIn(m: number): { ft: number; in: number } {
    const totalInches = m / METERS_PER_INCH;
    const ft = Math.floor(totalInches / 12);
    const inches = Math.round(totalInches - ft * 12);
    if (inches === 12) return { ft: ft + 1, in: 0 };
    return { ft, in: inches };
}

function ftInToMeters(ft: number, inches: number): number {
    return ft * METERS_PER_FOOT + inches * METERS_PER_INCH;
}

function rebuildRectangularWalls(width: number, length: number, height: number) {
    const halfW = width / 2;
    const halfL = length / 2;
    const thickness = 0.1;
    return [
        { id: "wall-n", start: { x: -halfW, z: -halfL }, end: { x: halfW, z: -halfL }, height, thickness },
        { id: "wall-s", start: { x: halfW, z: halfL }, end: { x: -halfW, z: halfL }, height, thickness },
        { id: "wall-e", start: { x: halfW, z: -halfL }, end: { x: halfW, z: halfL }, height, thickness },
        { id: "wall-w", start: { x: -halfW, z: halfL }, end: { x: -halfW, z: -halfL }, height, thickness },
    ];
}

export function WallBuilder() {
    const layout = useRoomStore((s) => s.layout);
    const setLayout = useRoomStore((s) => s.setLayout);

    const current = useMemo(
        () => ({
            width: metersToFtIn(layout.dimensions.width || DEFAULT_ROOM_DIMENSIONS.width),
            length: metersToFtIn(layout.dimensions.length || DEFAULT_ROOM_DIMENSIONS.length),
            height: metersToFtIn(layout.dimensions.height || DEFAULT_ROOM_DIMENSIONS.height),
        }),
        [layout.dimensions],
    );

    function update(axis: "width" | "length" | "height", ft: number, inches: number) {
        const meters = Math.max(0.3048, ftInToMeters(ft, inches)); // min 1 ft
        const next = { ...layout.dimensions, [axis]: meters };
        setLayout({
            ...layout,
            dimensions: next,
            walls: rebuildRectangularWalls(next.width, next.length, next.height),
        });
    }

    return (
        <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Room Dimensions</h3>
            {(["width", "length", "height"] as const).map((axis) => {
                const label = axis[0].toUpperCase() + axis.slice(1);
                const val = current[axis];
                return (
                    <div key={axis} className="flex items-center gap-2">
                        <label className="w-16 text-sm text-slate-700">{label}</label>
                        <input
                            type="number"
                            min={1}
                            max={100}
                            value={val.ft}
                            onChange={(e) => update(axis, Number(e.target.value) || 0, val.in)}
                            className="hui-input w-16 py-1 text-sm"
                        />
                        <span className="text-xs text-slate-500">ft</span>
                        <input
                            type="number"
                            min={0}
                            max={11}
                            value={val.in}
                            onChange={(e) => update(axis, val.ft, Number(e.target.value) || 0)}
                            className="hui-input w-16 py-1 text-sm"
                        />
                        <span className="text-xs text-slate-500">in</span>
                    </div>
                );
            })}
        </div>
    );
}
