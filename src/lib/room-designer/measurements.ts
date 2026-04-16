// Pure measurement helpers for the Room Designer. No React, no Three.js —
// this module is safe to import from server code (PDF generation), from
// canvas components (via MeasurementsOverlay), and from React Native later.

import type { PlacedAsset, RoomLayout } from "@/components/room-designer/types";
import { roomBounds } from "@/components/room-designer/core/geometry";
import type { Asset } from "@/lib/room-designer/asset-registry";

// ─────────────── Unit conversions ───────────────
const METERS_PER_FOOT = 0.3048;
const METERS_PER_INCH = 0.0254;

export function metersToFt(m: number): number {
    return m / METERS_PER_FOOT;
}

export function metersToIn(m: number): number {
    return m / METERS_PER_INCH;
}

/** Format a meter value as feet-inches, e.g. 2.5908 → `8' 6"`. */
export function metersToFtInLabel(m: number): string {
    const totalIn = Math.round(metersToIn(m)); // round to whole inch
    const ft = Math.floor(totalIn / 12);
    const inches = totalIn - ft * 12;
    return `${ft}' ${inches}"`;
}

// ─────────────── Room measurements ───────────────
export function roomWidthMeters(layout: RoomLayout): number {
    const b = roomBounds(layout);
    return b.maxX - b.minX;
}

export function roomLengthMeters(layout: RoomLayout): number {
    const b = roomBounds(layout);
    return b.maxZ - b.minZ;
}

export function sqFt(layout: RoomLayout): number {
    const w = metersToFt(roomWidthMeters(layout));
    const l = metersToFt(roomLengthMeters(layout));
    // Two decimal places at the source; callers can round further for display.
    return Math.round(w * l * 100) / 100;
}

export function ceilingFtInLabel(layout: RoomLayout): string {
    return metersToFtInLabel(layout.dimensions.height);
}

// ─────────────── Clearance thresholds (kitchen-design convention) ───────────────
const CLEARANCE_GOOD = 0.9144; // 36" — NKBA recommended clearance between opposing runs
const CLEARANCE_OK = 0.6096; // 24" — absolute minimum (fire code in some jurisdictions)

export type ClearanceColor = "green" | "yellow" | "red";

export function clearanceColor(clearanceM: number): ClearanceColor {
    if (clearanceM >= CLEARANCE_GOOD) return "green";
    if (clearanceM >= CLEARANCE_OK) return "yellow";
    return "red";
}

/** Hex color for a clearance band — consumed by the overlay renderer. */
export function clearanceHex(color: ClearanceColor): string {
    switch (color) {
        case "green":
            return "#16a34a"; // tailwind emerald-600
        case "yellow":
            return "#eab308"; // tailwind yellow-500
        case "red":
            return "#dc2626"; // tailwind red-600
    }
}

// ─────────────── Asset → asset clearance (XZ AABB gap) ───────────────
interface Dims {
    width: number;
    height: number;
    depth: number;
}

/**
 * Closest gap between two placed assets in the XZ plane, in meters.
 * Returns 0 if their AABBs overlap — callers can treat 0 as "red". Ignores
 * Y because clearance in kitchens is about walking space on the floor, not
 * stacking.
 *
 * We treat each asset as an axis-aligned bbox based on its dims. Real
 * rotated bboxes would require SAT — overkill for the warning layer.
 */
export function clearanceBetween(
    a: PlacedAsset,
    b: PlacedAsset,
    aDims: Dims,
    bDims: Dims,
): number {
    const aHalfW = aDims.width / 2;
    const aHalfD = aDims.depth / 2;
    const bHalfW = bDims.width / 2;
    const bHalfD = bDims.depth / 2;

    // Per-axis gap: center distance minus the sum of half-extents. Negative
    // means the boxes overlap on that axis.
    const gapX = Math.abs(a.position.x - b.position.x) - (aHalfW + bHalfW);
    const gapZ = Math.abs(a.position.z - b.position.z) - (aHalfD + bHalfD);

    // If BOTH axes overlap, the boxes intersect → gap = 0.
    if (gapX < 0 && gapZ < 0) return 0;

    // If one axis overlaps and the other is apart, the Euclidean gap is the
    // non-overlap axis value. If both are positive, the true gap is the
    // hypotenuse of the corner-to-corner vector.
    if (gapX < 0) return Math.max(0, gapZ);
    if (gapZ < 0) return Math.max(0, gapX);
    return Math.hypot(gapX, gapZ);
}

/**
 * Every asset pair whose AABB gap is under `maxM` meters (default 1.2 m,
 * slightly over the 36" "good" threshold so the user can see yellow/red
 * pairs as they place). Skips category pairs where clearance isn't
 * meaningful (e.g. window ↔ cabinet).
 */
export function adjacentPairs(
    assets: PlacedAsset[],
    registry: Asset[],
    maxM: number = 1.2,
): Array<{ a: PlacedAsset; b: PlacedAsset; clearance: number }> {
    const byId = new Map(registry.map((r) => [r.id, r] as const));
    const result: Array<{ a: PlacedAsset; b: PlacedAsset; clearance: number }> = [];

    for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        const aReg = byId.get(a.assetId);
        if (!aReg) continue;
        // Windows and doors don't participate in floor-clearance.
        if (aReg.category === "window" || aReg.category === "door") continue;

        for (let j = i + 1; j < assets.length; j++) {
            const b = assets[j];
            const bReg = byId.get(b.assetId);
            if (!bReg) continue;
            if (bReg.category === "window" || bReg.category === "door") continue;

            const gap = clearanceBetween(a, b, aReg.dimensions, bReg.dimensions);
            if (gap < maxM) {
                result.push({ a, b, clearance: gap });
            }
        }
    }
    return result;
}
