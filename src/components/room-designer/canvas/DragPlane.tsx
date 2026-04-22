import { useCallback } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { useCanvasContext } from "./CanvasContext";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import {
    snapToWall,
    snapToAdjacent,
    aabbOf,
    type AABB,
} from "@/components/room-designer/core/snap-utils";
import type { SnapLine } from "@/components/room-designer/canvas/AssetGhost";
import type { Group } from "three";

export function DragPlane() {
    const draggingAssetId = useRoomStore((s) => s.draggingAssetId);
    const assets = useRoomStore((s) => s.assets);
    const walls = useRoomStore((s) => s.layout.walls);
    const updateAsset = useRoomStore((s) => s.updateAsset);
    const stopDraggingAsset = useRoomStore((s) => s.stopDraggingAsset);
    const setTransformSnapLines = useRoomStore((s) => s.setTransformSnapLines);
    const { orbitRef, meshRefs } = useCanvasContext();

    const handleMove = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            if (!draggingAssetId) return;
            const obj = meshRefs.current.get(draggingAssetId) as Group | undefined;
            if (!obj) return;

            const asset = assets.find((a) => a.id === draggingAssetId);
            if (!asset) return;
            const registry = getAsset(asset.assetId);
            if (!registry) return;
            const dims = resolveDimensions(asset, registry);

            obj.position.x = e.point.x;
            obj.position.z = e.point.z;
            obj.position.y = asset.position.y + dims.height / 2;
        },
        [draggingAssetId, assets, meshRefs],
    );

    const handleUp = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            if (!draggingAssetId) return;
            e.stopPropagation();

            const obj = meshRefs.current.get(draggingAssetId) as Group | undefined;
            const asset = assets.find((a) => a.id === draggingAssetId);

            if (obj && asset) {
                const registry = getAsset(asset.assetId);
                if (registry) {
                    const dims = resolveDimensions(asset, registry);
                    let finalX = obj.position.x;
                    let finalZ = obj.position.z;
                    let finalRotY = asset.rotationY;
                    const snapLines: SnapLine[] = [];

                    const w = snapToWall(dims.depth, finalX, finalZ, walls);
                    if (w.snapped) {
                        finalX = w.x;
                        finalZ = w.z;
                        finalRotY = w.rotationY;
                        snapLines.push({
                            kind: "wall",
                            from: [asset.position.x, 0.01, asset.position.z],
                            to: [finalX, 0.01, finalZ],
                        });
                    }

                    const otherBoxes: AABB[] = [];
                    for (const a of assets) {
                        if (a.id === draggingAssetId) continue;
                        const box = aabbOf(a);
                        if (box) otherBoxes.push(box);
                    }
                    const adj = snapToAdjacent(dims.width, dims.depth, finalX, finalZ, otherBoxes);
                    if (adj.x !== finalX || adj.z !== finalZ) {
                        snapLines.push({
                            kind: "edge",
                            from: [finalX, 0.01, finalZ],
                            to: [adj.x, 0.01, adj.z],
                        });
                        finalX = adj.x;
                        finalZ = adj.z;
                    }

                    if (snapLines.length > 0) {
                        setTransformSnapLines(snapLines);
                        setTimeout(() => setTransformSnapLines([]), 600);
                    }

                    obj.position.x = finalX;
                    obj.position.z = finalZ;
                    obj.position.y = asset.position.y + dims.height / 2;

                    updateAsset(draggingAssetId, {
                        position: { x: finalX, y: asset.position.y, z: finalZ },
                        rotationY: finalRotY,
                    });
                }
            }

            const orbit = orbitRef.current;
            if (orbit) orbit.enabled = true;
            stopDraggingAsset();
        },
        [draggingAssetId, assets, walls, meshRefs, orbitRef, updateAsset, stopDraggingAsset, setTransformSnapLines],
    );

    if (!draggingAssetId) return null;

    return (
        <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.001, 0]}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
        >
            <planeGeometry args={[1000, 1000]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
    );
}
