// Wall / room geometry helpers. Pure functions only — no React, no Three.js.
// Keeping this module dependency-free makes it trivially portable to RN later.

import type { Wall, RoomLayout } from "@/components/room-designer/types";

// Snap a meters value to the given grid size (meters). Default 0.0254 m = 1".
export function snapToGrid(value: number, grid: number = 0.0254): number {
    return Math.round(value / grid) * grid;
}

// Axis-aligned XZ bounding box for a layout's walls. Handles arbitrary polygons,
// not just rectangles — we'll need this once Stage 1 lets users draw L-shapes.
export function roomBounds(layout: RoomLayout): {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
} {
    if (layout.walls.length === 0) {
        const { width, length } = layout.dimensions;
        return { minX: -width / 2, maxX: width / 2, minZ: -length / 2, maxZ: length / 2 };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const w of layout.walls) {
        minX = Math.min(minX, w.start.x, w.end.x);
        maxX = Math.max(maxX, w.start.x, w.end.x);
        minZ = Math.min(minZ, w.start.z, w.end.z);
        maxZ = Math.max(maxZ, w.start.z, w.end.z);
    }
    return { minX, maxX, minZ, maxZ };
}

// Midpoint + length + angle (radians, CCW from +X) for a wall, used to position
// a box mesh representing the wall.
export function wallTransform(wall: Wall): {
    center: { x: number; z: number };
    length: number;
    angleY: number;
} {
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.z - wall.start.z;
    const length = Math.hypot(dx, dz);
    const center = {
        x: (wall.start.x + wall.end.x) / 2,
        z: (wall.start.z + wall.end.z) / 2,
    };
    // Three.js rotates around Y with +angle going from +X to -Z.
    // atan2(-dz, dx) gives that convention for a segment from start→end.
    const angleY = Math.atan2(-dz, dx);
    return { center, length, angleY };
}

// Clamp a position to stay inside the room footprint by the given margin.
export function clampToRoom(
    pos: { x: number; z: number },
    layout: RoomLayout,
    margin: number = 0,
): { x: number; z: number } {
    const b = roomBounds(layout);
    return {
        x: Math.min(Math.max(pos.x, b.minX + margin), b.maxX - margin),
        z: Math.min(Math.max(pos.z, b.minZ + margin), b.maxZ - margin),
    };
}
