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
import type { PlacedAsset } from "@/components/room-designer/types";
import { useRoomStore } from "./useRoomStore";
import type { GhostPose, SnapLine } from "@/components/room-designer/canvas/AssetGhost";
import {
    snap,
    aabbOf,
    aabbFromPose,
    overlaps,
    pointSegmentDistance,
    snapToWall,
    snapToAdjacent,
    type AABB,
} from "@/components/room-designer/core/snap-utils";

const WALL_MOUNT_DEFAULT_Y = 1.3716; // 54" — default wall-cabinet mount height

function newId(): string {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
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
                const w = snapToWall(placingAsset.dimensions.depth, x, z, walls);
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
            const adj = snapToAdjacent(placingAsset.dimensions.width, placingAsset.dimensions.depth, x, z, existingBoxes);
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
