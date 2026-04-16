// Stage 3: dimension / clearance overlay. Toggled by `showMeasurements` (M key).
// For every adjacent pair of placed assets on the same axis (X or Z), renders
// a small dimension arrow + numeric label. Color codes the label by clearance
// vs. code-minimum walkway (36" / 24").
//
// Rotation caveat: `aabbOf` here is axis-aligned. Cabinets rotated at non-
// cardinal angles show a conservative (larger) AABB, so the clearance reading
// is a worst-case estimate. Kitchen cabinets are almost always axis-aligned in
// practice; the yellow/red labels include a tooltip hint noting the caveat.

import { Line, Html } from "@react-three/drei";
import { useMemo } from "react";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import { isHidden } from "@/lib/room-designer/asset-view";
import { fmtInches } from "@/lib/room-designer/units";
import type { PlacedAsset } from "@/components/room-designer/types";

const CLEARANCE_OK = 0.9144;   // 36"
const CLEARANCE_WARN = 0.6096; // 24"

interface Box {
    asset: PlacedAsset;
    minX: number; maxX: number; cx: number;
    minZ: number; maxZ: number; cz: number;
}

function makeBoxes(assets: PlacedAsset[]): Box[] {
    const out: Box[] = [];
    for (const a of assets) {
        if (isHidden(a)) continue;
        const reg = getAsset(a.assetId);
        if (!reg) continue;
        const { width, depth } = resolveDimensions(a, reg);
        out.push({
            asset: a,
            minX: a.position.x - width / 2,
            maxX: a.position.x + width / 2,
            cx: a.position.x,
            minZ: a.position.z - depth / 2,
            maxZ: a.position.z + depth / 2,
            cz: a.position.z,
        });
    }
    return out;
}

function colorFor(m: number): string {
    if (m >= CLEARANCE_OK) return "#22c55e";
    if (m >= CLEARANCE_WARN) return "#eab308";
    return "#ef4444";
}

interface Pair {
    kind: "x" | "z";
    from: [number, number, number];
    to: [number, number, number];
    labelPos: [number, number, number];
    meters: number;
}

// Overlap tolerance for deciding whether two boxes "share" the cross axis.
const SHARED_AXIS_TOL = 0.15; // 15 cm — slightly more than grid cell

function adjacentPairs(boxes: Box[]): Pair[] {
    const pairs: Pair[] = [];
    const n = boxes.length;

    // X-axis adjacency: overlap on Z, smallest positive gap along X.
    const byX = [...boxes].sort((a, b) => a.cx - b.cx);
    for (let i = 0; i < byX.length - 1; i++) {
        const a = byX[i];
        // Find the next box to the right whose Z extent overlaps `a`.
        for (let j = i + 1; j < byX.length; j++) {
            const b = byX[j];
            const zOverlap = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
            if (zOverlap < -SHARED_AXIS_TOL) continue;
            const gap = b.minX - a.maxX;
            if (gap <= 0) break; // overlapping assets, stop scanning this row
            const midZ = (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2;
            pairs.push({
                kind: "x",
                from: [a.maxX, 0.02, midZ],
                to: [b.minX, 0.02, midZ],
                labelPos: [(a.maxX + b.minX) / 2, 0.02, midZ],
                meters: gap,
            });
            break; // nearest neighbour only
        }
    }

    // Z-axis adjacency: overlap on X, smallest positive gap along Z.
    const byZ = [...boxes].sort((a, b) => a.cz - b.cz);
    for (let i = 0; i < byZ.length - 1; i++) {
        const a = byZ[i];
        for (let j = i + 1; j < byZ.length; j++) {
            const b = byZ[j];
            const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
            if (xOverlap < -SHARED_AXIS_TOL) continue;
            const gap = b.minZ - a.maxZ;
            if (gap <= 0) break;
            const midX = (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2;
            pairs.push({
                kind: "z",
                from: [midX, 0.02, a.maxZ],
                to: [midX, 0.02, b.minZ],
                labelPos: [midX, 0.02, (a.maxZ + b.minZ) / 2],
                meters: gap,
            });
            break;
        }
    }

    void n;
    return pairs;
}

export function ClearanceOverlay() {
    const show = useRoomStore((s) => s.showMeasurements);
    const assets = useRoomStore((s) => s.assets);

    const pairs = useMemo(() => (show ? adjacentPairs(makeBoxes(assets)) : []), [show, assets]);

    if (!show) return null;

    return (
        <group>
            {pairs.map((p, i) => {
                const color = colorFor(p.meters);
                return (
                    <group key={i}>
                        <Line
                            points={[p.from, p.to]}
                            color={color}
                            lineWidth={1.5}
                        />
                        <Html
                            position={p.labelPos}
                            center
                            style={{ pointerEvents: "none" }}
                        >
                            <div
                                title={
                                    p.meters < CLEARANCE_OK
                                        ? "Conservative estimate — rotated cabinets show worst-case AABB."
                                        : undefined
                                }
                                className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
                                style={{ backgroundColor: color }}
                            >
                                {fmtInches(p.meters)}
                            </div>
                        </Html>
                    </group>
                );
            })}
        </group>
    );
}
