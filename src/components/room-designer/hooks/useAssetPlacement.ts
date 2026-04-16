// Placement pipeline: cursor → snapped ghost pose with collision/wall/adjacent
// snapping. Returns handlers the PlacementPlane calls on pointerMove / click,
// plus the GhostPose that AssetGhost renders.
//
// The ghost rotation is derived from the closest wall when a wall-mount, window,
// or door is being placed. Otherwise rotation stays at 0.
//
// Collision uses full 3D AABB (X, Y, AND Z). Same-Y wall cabinets correctly
// collide with each other; base + wall stack does not.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Asset } from "@/lib/room-designer/asset-registry";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import type { PlacedAsset, Wall } from "@/components/room-designer/types";
import { useRoomStore } from "./useRoomStore";
import type { GhostPose, SnapLine } from "@/components/room-designer/canvas/AssetGhost";

const WALL_SNAP_DISTANCE = 0.1524; // 6"
const ADJACENT_SNAP_DISTANCE = 0.1524; // 6"
const WALL_MOUNT_DEFAULT_Y = 1.3716; // 54" — default wall-cabinet mount height

function newId(): string {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
}

function snap(value: number, grid: number): number {
    return Math.round(value / grid) * grid;
}

interface AABB {
    x1: number; x2: number;
    y1: number; y2: number;
    z1: number; z2: number;
}

function aabbOf(placed: PlacedAsset): AABB | null {
    const reg = getAsset(placed.assetId);
    if (!reg) return null;
    const { width, height, depth } = resolveDimensions(placed, reg);
    const cx = placed.position.x;
    const cz = placed.position.z;
    const cy = placed.position.y + height / 2;
    return {
        x1: cx - width / 2, x2: cx + width / 2,
        y1: cy - height / 2, y2: cy + height / 2,
        z1: cz - depth / 2, z2: cz + depth / 2,
    };
}

function aabbFromPose(asset: Asset, x: number, z: number, yOffset: number): AABB {
    const { width, height, depth } = asset.dimensions;
    const cy = yOffset + height / 2;
    return {
        x1: x - width / 2, x2: x + width / 2,
        y1: cy - height / 2, y2: cy + height / 2,
        z1: z - depth / 2, z2: z + depth / 2,
    };
}

function overlaps(a: AABB, b: AABB): boolean {
    return (
        a.x1 < b.x2 && a.x2 > b.x1 &&
        a.y1 < b.y2 && a.y2 > b.y1 &&
        a.z1 < b.z2 && a.z2 > b.z1
    );
}

// Perpendicular distance from point (px, pz) to line segment (start→end).
function pointSegmentDistance(
    px: number, pz: number,
    sx: number, sz: number,
    ex: number, ez: number,
): { dist: number; proj: { x: number; z: number } } {
    const dx = ex - sx, dz = ez - sz;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) {
        const d = Math.hypot(px - sx, pz - sz);
        return { dist: d, proj: { x: sx, z: sz } };
    }
    let t = ((px - sx) * dx + (pz - sz) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = sx + t * dx;
    const projZ = sz + t * dz;
    return {
        dist: Math.hypot(px - projX, pz - projZ),
        proj: { x: projX, z: projZ },
    };
}

// Signed side of point relative to wall direction (+1 left, -1 right).
function sideOfWall(px: number, pz: number, wall: Wall): number {
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.z - wall.start.z;
    const cross = dx * (pz - wall.start.z) - dz * (px - wall.start.x);
    return Math.sign(cross) || 1;
}

function snapToWall(
    asset: Asset,
    x: number,
    z: number,
    walls: Wall[],
): { x: number; z: number; rotationY: number; snapped: boolean } {
    let best: { wall: Wall; dist: number; proj: { x: number; z: number } } | null = null;
    for (const wall of walls) {
        const { dist, proj } = pointSegmentDistance(x, z, wall.start.x, wall.start.z, wall.end.x, wall.end.z);
        if (dist < WALL_SNAP_DISTANCE && (!best || dist < best.dist)) {
            best = { wall, dist, proj };
        }
    }
    if (!best) return { x, z, rotationY: 0, snapped: false };

    const wall = best.wall;
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.z - wall.start.z;
    if (dx === 0 && dz === 0) return { x, z, rotationY: 0, snapped: false };

    const wallAngle = Math.atan2(dz, dx);
    // Asset's +Z face should point AWAY from the wall (into the room), so rotation
    // is perpendicular to the wall. Determine which side of the wall the cursor
    // is on to pick the correct outward direction.
    const side = sideOfWall(x, z, wall);
    // rotationY rotates the asset's local +Z axis. We want it to face outward
    // from the wall. Perpendicular to wall direction, oriented by side.
    const rotationY = wallAngle + (side > 0 ? Math.PI / 2 : -Math.PI / 2);

    // Push the asset out from the wall face by half its depth so the back edge
    // sits flush against the wall.
    //
    // Outward normal: rotating the wall direction (dx, dz) by +90° gives (-dz, dx).
    // `side` picks the half-plane the cursor is in (same sign convention as
    // `sideOfWall`), so `side * (-dz, dx)` always points from the wall toward
    // the cursor. Works for walls at any angle, not just axis-aligned.
    const pushDist = asset.dimensions.depth / 2;
    const len = Math.hypot(dx, dz);
    const outX = (-side * dz) / len;
    const outZ = (side * dx) / len;
    return {
        x: best.proj.x + outX * pushDist,
        z: best.proj.z + outZ * pushDist,
        rotationY,
        snapped: true,
    };
}

function snapToAdjacent(
    asset: Asset,
    x: number,
    z: number,
    otherBoxes: AABB[],
): { x: number; z: number } {
    const { width, depth } = asset.dimensions;
    let adjustedX = x;
    let adjustedZ = z;

    for (const other of otherBoxes) {
        const cx = (other.x1 + other.x2) / 2;
        const cz = (other.z1 + other.z2) / 2;
        // X-axis adjacency: align edges if within tolerance
        if (Math.abs((x + width / 2) - other.x1) < ADJACENT_SNAP_DISTANCE) {
            adjustedX = other.x1 - width / 2;
        } else if (Math.abs((x - width / 2) - other.x2) < ADJACENT_SNAP_DISTANCE) {
            adjustedX = other.x2 + width / 2;
        }
        // Z-axis adjacency
        if (Math.abs((z + depth / 2) - other.z1) < ADJACENT_SNAP_DISTANCE) {
            adjustedZ = other.z1 - depth / 2;
        } else if (Math.abs((z - depth / 2) - other.z2) < ADJACENT_SNAP_DISTANCE) {
            adjustedZ = other.z2 + depth / 2;
        }
        // Silence unused-var warning for center; retained for future guide-line rendering.
        void cx; void cz;
    }

    return { x: adjustedX, z: adjustedZ };
}

export interface UseAssetPlacement {
    pose: GhostPose | null;
    pulseKey: number;
    handleMove: (x: number, z: number) => void;
    handleConfirm: (x: number, z: number) => void;
}

export function useAssetPlacement(): UseAssetPlacement {
    const placingAsset = useRoomStore((s) => s.placingAsset);
    const snapToGridEnabled = useRoomStore((s) => s.snapToGrid);
    const gridSize = useRoomStore((s) => s.gridSize);
    const assets = useRoomStore((s) => s.assets);
    const walls = useRoomStore((s) => s.layout.walls);
    const addAsset = useRoomStore((s) => s.addAsset);
    const cancelPlacing = useRoomStore((s) => s.cancelPlacing);

    const [pose, setPose] = useState<GhostPose | null>(null);
    const [pulseKey, setPulseKey] = useState(0);

    // Precompute collision boxes for every existing asset — recomputed only when
    // assets change, not on every pointer move.
    const existingBoxes = useMemo<AABB[]>(() => {
        return assets.map((a) => aabbOf(a)).filter((b): b is AABB => b !== null);
    }, [assets]);

    const computePose = useCallback(
        (rawX: number, rawZ: number): GhostPose | null => {
            if (!placingAsset) return null;

            // Wall-mount assets get a default Y offset so they sit at 54" above floor.
            const needsWallMount =
                placingAsset.subcategory === "wall" ||
                placingAsset.category === "window" ||
                placingAsset.category === "door";
            const yOffset = needsWallMount ? WALL_MOUNT_DEFAULT_Y : 0;

            const snapLines: SnapLine[] = [];

            // 1. grid snap
            let x = snapToGridEnabled ? snap(rawX, gridSize) : rawX;
            let z = snapToGridEnabled ? snap(rawZ, gridSize) : rawZ;
            if (snapToGridEnabled) {
                // Faint axis lines through the snapped point to hint grid alignment.
                snapLines.push({
                    kind: "grid",
                    from: [x - 1, 0.005, z],
                    to: [x + 1, 0.005, z],
                });
                snapLines.push({
                    kind: "grid",
                    from: [x, 0.005, z - 1],
                    to: [x, 0.005, z + 1],
                });
            }

            // 2. wall snap (only for wall-mount categories or when close enough)
            let rotationY = 0;
            if (needsWallMount) {
                const w = snapToWall(placingAsset, x, z, walls);
                if (w.snapped) {
                    x = w.x;
                    z = w.z;
                    rotationY = w.rotationY;
                }
            }

            // Track nearest wall regardless of snap outcome (for clearance badge).
            let nearestWallDistance: number | null = null;
            for (const wall of walls) {
                const { dist } = pointSegmentDistance(x, z, wall.start.x, wall.start.z, wall.end.x, wall.end.z);
                if (nearestWallDistance === null || dist < nearestWallDistance) {
                    nearestWallDistance = dist;
                }
            }
            if (nearestWallDistance !== null && nearestWallDistance > 2) {
                nearestWallDistance = null;
            }

            // 3. adjacent snap
            const adj = snapToAdjacent(placingAsset, x, z, existingBoxes);
            if (adj.x !== x || adj.z !== z) {
                snapLines.push({
                    kind: "edge",
                    from: [x, 0.01, z],
                    to: [adj.x, 0.01, adj.z],
                });
            }
            x = adj.x;
            z = adj.z;

            // 4. collision check
            const ghostBox = aabbFromPose(placingAsset, x, z, yOffset);
            const valid = !existingBoxes.some((b) => overlaps(ghostBox, b));

            return { x, z, rotationY, yOffset, valid, snapLines, nearestWallDistance };
        },
        [placingAsset, snapToGridEnabled, gridSize, walls, existingBoxes],
    );

    const handleMove = useCallback(
        (x: number, z: number) => {
            const next = computePose(x, z);
            if (next) setPose(next);
        },
        [computePose],
    );

    const handleConfirm = useCallback(
        (x: number, z: number) => {
            if (!placingAsset) return;
            const next = computePose(x, z);
            if (!next) return;
            if (!next.valid) {
                setPulseKey((k) => k + 1);
                setPose(next);
                return;
            }
            const placed: PlacedAsset = {
                id: newId(),
                assetId: placingAsset.id,
                assetType: placingAsset.category,
                position: { x: next.x, y: next.yOffset, z: next.z },
                rotationY: next.rotationY,
                scale: { x: 1, y: 1, z: 1 },
            };
            addAsset(placed);
            cancelPlacing();
            setPose(null);
        },
        [placingAsset, computePose, addAsset, cancelPlacing],
    );

    // Reset local pose when the user cancels placement externally (Escape key,
    // picking a different asset, etc).
    useEffect(() => {
        if (!placingAsset) setPose(null);
    }, [placingAsset]);

    return { pose, pulseKey, handleMove, handleConfirm };
}
