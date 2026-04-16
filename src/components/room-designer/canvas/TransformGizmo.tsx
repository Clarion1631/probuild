// Stage 3: 3D transform gizmo that attaches to the currently-selected asset.
// Uses drei's <TransformControls>. Three landmines addressed here:
//
//   (i) Imperative attach/detach — passing `object={ref.current}` as a JSX
//       prop captures a one-render-stale snapshot and briefly targets the
//       wrong asset. We call controls.attach(obj) in a useEffect instead.
//
//  (ii) Commit on mouseUp, not onObjectChange — onObjectChange fires at
//       60fps during drag; each store write re-renders the AssetNode group
//       and fights the gizmo's imperative transform → jitter. Read the
//       final group transform on mouseUp and commit once.
//
// (iii) `dragging-changed` toggles OrbitControls enabled. Without this,
//       dragging a gizmo arrow also rotates the camera.

import { useEffect, useRef } from "react";
import { TransformControls } from "@react-three/drei";
import type { Group, Object3D } from "three";
import type { TransformControls as TransformControlsImpl } from "three-stdlib";
import { useRoomStore, useSelectedAssetId } from "@/components/room-designer/hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";
import { useCanvasContext } from "./CanvasContext";

export function TransformGizmo() {
    const primaryId = useSelectedAssetId();
    const selectionCount = useRoomStore((s) => s.selectedAssetIds.length);
    const assets = useRoomStore((s) => s.assets);
    const toolMode = useRoomStore((s) => s.toolMode);
    const snapOn = useRoomStore((s) => s.snapToGrid);
    const gridSize = useRoomStore((s) => s.gridSize);
    const updateAsset = useRoomStore((s) => s.updateAsset);

    const asset = primaryId ? assets.find((a) => a.id === primaryId) ?? null : null;
    // Multi-select uses the alignment toolbar, not the gizmo.
    const active = selectionCount === 1 && asset !== null && !isLocked(asset);

    const { orbitRef, meshRefs } = useCanvasContext();
    const transformRef = useRef<TransformControlsImpl | null>(null);

    // (i) Imperative attach/detach on selection change.
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
        } else {
            controls.detach();
        }
    }, [primaryId, active, meshRefs]);

    // (iii) OrbitControls coupling.
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

    // Reset mode on every render — TransformControls mode is an exposed prop.
    // drei rebinds on the prop change. This is cheap.

    return (
        <TransformControls
            ref={(ref) => {
                transformRef.current = (ref ?? null) as TransformControlsImpl | null;
            }}
            mode={toolMode}
            translationSnap={snapOn ? gridSize : null}
            rotationSnap={snapOn ? Math.PI / 12 : null} // 15°
            scaleSnap={snapOn ? 0.1 : null}
            showX
            showZ
            showY={toolMode !== "translate"}
            onMouseUp={() => {
                if (!primaryId || !asset) return;
                const obj = meshRefs.current.get(primaryId) as Group | undefined;
                if (!obj) return;
                const y = toolMode === "translate" ? Math.max(0, obj.position.y) : asset.position.y;
                updateAsset(primaryId, {
                    position: { x: obj.position.x, y, z: obj.position.z },
                    rotationY: obj.rotation.y,
                    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
                });
            }}
        />
    );
}
