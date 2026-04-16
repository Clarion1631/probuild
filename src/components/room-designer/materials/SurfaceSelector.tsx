// Helper module (no JSX, no React component) for surface ↔ wall mapping
// and shared canvas click handlers.
//
// Why a module, not a component: Floor/Walls/Ceiling already render at the
// right place in the scene tree. Wrapping them in a <SurfaceSelector> would
// fight the existing single-source-of-truth tree. Centralizing the helpers
// here keeps intent in one file without restructuring the canvas.

import type { RoomSurface, Wall } from "@/components/room-designer/types";

const WALL_ID_TO_SURFACE: Record<string, RoomSurface> = {
    "wall-n": "wall-north",
    "wall-s": "wall-south",
    "wall-e": "wall-east",
    "wall-w": "wall-west",
};

/**
 * Resolve a Wall to its RoomSurface key. Prefers the wall's own `surface`
 * field (set by `buildDefaultLayout`) and falls back to an id → surface map
 * for older persisted layouts written before the field existed. Free-form
 * walls without either return null and are excluded from material selection.
 */
export function wallSurface(wall: Wall): RoomSurface | null {
    if (wall.surface) return wall.surface;
    return WALL_ID_TO_SURFACE[wall.id] ?? null;
}

/** Pretty label for a RoomSurface (used in MaterialLibrary header + dropdown). */
export function surfaceLabel(surface: RoomSurface): string {
    switch (surface) {
        case "floor": return "Floor";
        case "ceiling": return "Ceiling";
        case "wall-north": return "North wall";
        case "wall-south": return "South wall";
        case "wall-east": return "East wall";
        case "wall-west": return "West wall";
        case "backsplash": return "Backsplash";
        case "countertop": return "Countertop";
        case "cabinet-face": return "Cabinet face";
    }
}

/** Surface → which MaterialCategory's swatches to show. */
export function categoriesForSurface(surface: RoomSurface): readonly string[] {
    switch (surface) {
        case "floor":
            return ["flooring"];
        case "wall-north":
        case "wall-south":
        case "wall-east":
        case "wall-west":
            return ["wall-paint", "tile"];
        case "ceiling":
            return ["wall-paint"]; // ceiling paint = wall paint
        case "backsplash":
            return ["backsplash"];
        case "countertop":
            return ["countertop"];
        case "cabinet-face":
            return ["cabinet-finish"];
    }
}

/**
 * All selectable surfaces, in the order they appear in the target dropdown.
 * Drives the "Change: [Surface ▼]" picker so backsplash/countertop are
 * reachable even without canvas geometry.
 */
export const ALL_SURFACES: readonly RoomSurface[] = [
    "floor",
    "ceiling",
    "wall-north",
    "wall-south",
    "wall-east",
    "wall-west",
    "backsplash",
    "countertop",
];
