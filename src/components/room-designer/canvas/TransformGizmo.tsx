import { useEffect, useRef } from "react";
import { TransformControls } from "@react-three/drei";
import type { Group, Object3D, Material, Mesh } from "three";
import type { TransformControls as TransformControlsImpl } from "three-stdlib";
import { useRoomStore, useSelectedAssetId } from "@/components/room-designer/hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import {
    snapToWall,
    snapToAdjacent,
    aabbOf,
    type AABB,
} from "@/components/room-designer/core/snap-utils";
import type { SnapLine } from "@/components/room-designer/canvas/AssetGhost";
import { useCanvasContext } from "./CanvasContext";

export function TransformGizmo() {
    const primaryId = useSelectedAssetId();
    const selectionCount = useRoomStore((s) => s.selectedAssetIds.length);
    const assets = useRoomStore((s) => s.assets);
    const toolMode = useRoomStore((s) => s.toolMode);
    const snapOn = useRoomStore((s) => s.snapToGrid);
    const gridSize = useRoomStore((s) => s.gridSize);
    const walls = useRoomStore((s) => s.layout.walls);
    const updateAsset = useRoomStore((s) => s.updateAsset);
    const setTransformSnapLines = useRoomStore((s) => s.setTransformSnapLines);

    const asset = primaryId ? assets.find((a) => a.id === primaryId) ?? null : null;
    const active = selectionCount === 1 && asset !== null && !isLocked(asset);

    const { orbitRef, meshRefs } = useCanvasContext();
    const transformRef = useRef<TransformControlsImpl | null>(null);

    // Imperative attach/detach on selection change.
    useEffect(() => {
        const controls = transformRef.current;
        if (!controls) return;
        if (!active || !primaryId) {
            controls.detach();
            return;
        }
        const obj = meshRefs.current.get(primaryId);
        if (obj) {
            controls.attach(obj as Object3D);
            controls.traverse((child) => {
                child.renderOrder = 9999;
                const mesh = child as Mesh;
                const mat = mesh.material as Material | undefined;
                if (mat && "depthTest" in mat) {
                    (mat as Material & { depthTest: boolean }).depthTest = false;
                }
            });
        } else {
            controls.detach();
        }
    }, [primaryId, active, meshRefs]);

    // OrbitControls coupling — disable orbit while dragging gizmo.
    useEffect(() => {
        const controls = transformRef.current;
        if (!controls) return;
        const cb = (e: unknown) => {
            const orbit = orbitRef.current;
            if (!orbit) return;
            const value = (e as { value: boolean }).value;
            orbit.enabled = !value;
        };
        // @ts-expect-error — three EventDispatcher uses string events
        controls.addEventListener("dragging-changed", cb);
        return () => {
            // @ts-expect-error
            controls.removeEventListener("dragging-changed", cb);
        };
    }, [orbitRef]);

    return (
        <TransformControls
            ref={(ref) => {
                transformRef.current = (ref ?? null) as TransformControlsImpl | null;
            }}
            mode={toolMode}
            size={2.5}
            translationSnap={snapOn ? gridSize : null}
            rotationSnap={snapOn ? Math.PI / 12 : null}
            scaleSnap={snapOn ? 0.1 : null}
            showX
            showZ
            showY
            onMouseUp={() => {
                if (!primaryId || !asset) return;
                const obj = meshRefs.current.get(primaryId) as Group | undefined;
                if (!obj) return;

                let finalX = obj.position.x;
                let finalZ = obj.position.z;
                let finalY = toolMode === "translate" ? Math.max(0, obj.position.y) : asset.position.y;
                let finalRotY = obj.rotation.y;

                if (toolMode === "translate") {
                    const registry = getAsset(asset.assetId);
                    if (registry) {
                        const dims = resolveDimensions(asset, registry);
                        const snapLines: SnapLine[] = [];

                        // Wall snap (snap-on-release: no feedback loop)
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

                        // Adjacent snap — exclude self
                        const otherBoxes: AABB[] = [];
                        for (const a of assets) {
                            if (a.id === primaryId) continue;
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

                        // Flash snap indicators briefly, then clear
                        if (snapLines.length > 0) {
                            setTransformSnapLines(snapLines);
                            setTimeout(() => setTransformSnapLines([]), 600);
                        }

                        // Apply snapped position back to the 3D object so it
                        // visually jumps to the final position
                        obj.position.set(finalX, finalY, finalZ);
                        obj.rotation.y = finalRotY;
                    }
                }

                updateAsset(primaryId, {
                    position: { x: finalX, y: finalY, z: finalZ },
                    rotationY: finalRotY,
                    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
                });
            }}
        />
    );
}
