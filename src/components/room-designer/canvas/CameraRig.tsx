// Swaps between a top-down orthographic camera (2D plan view) and a tilted
// perspective camera (3D view) based on the store's viewMode. OrbitControls
// let the user pan/zoom/rotate in 3D; in 2D they're locked to pan + zoom only.
//
// Stage 3: exposes the OrbitControls instance via CanvasContext so the
// TransformGizmo can disable orbit during drag, and useCameraPresets can
// tween the target when the user clicks a view preset.

import { OrbitControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import type { RoomLayout, ViewMode } from "@/components/room-designer/types";
import { roomBounds } from "@/components/room-designer/core/geometry";
import { useCanvasContext } from "./CanvasContext";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

interface CameraRigProps {
    layout: RoomLayout;
    viewMode: ViewMode;
}

export function CameraRig({ layout, viewMode }: CameraRigProps) {
    const { orbitRef } = useCanvasContext();
    const { minX, maxX, minZ, maxZ } = roomBounds(layout);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 1);

    if (viewMode === "2d") {
        // Top-down ortho. Height above the ceiling so the whole room fits.
        return (
            <>
                <OrthographicCamera
                    makeDefault
                    position={[cx, 10, cz]}
                    zoom={Math.max(40, 600 / span)}
                    near={0.1}
                    far={100}
                    up={[0, 0, -1]}
                />
                <OrbitControls
                    ref={orbitRef as React.RefObject<OrbitControlsImpl>}
                    enableRotate={false}
                    enablePan
                    enableZoom
                    target={[cx, 0, cz]}
                    mouseButtons={{ LEFT: 2 /* PAN */, MIDDLE: 1 /* DOLLY */, RIGHT: 2 /* PAN */ }}
                />
            </>
        );
    }

    // 3D perspective: seat the camera outside one corner looking at room center.
    const camPos: [number, number, number] = [
        layout.camera.position[0] ?? span * 1.2,
        layout.camera.position[1] ?? layout.dimensions.height * 1.3,
        layout.camera.position[2] ?? span * 1.2,
    ];
    const camTarget: [number, number, number] = [
        layout.camera.target[0] ?? cx,
        layout.camera.target[1] ?? layout.dimensions.height / 2,
        layout.camera.target[2] ?? cz,
    ];

    return (
        <>
            <PerspectiveCamera makeDefault position={camPos} fov={50} near={0.1} far={500} />
            <OrbitControls
                ref={orbitRef as React.RefObject<OrbitControlsImpl>}
                enableRotate
                enablePan
                enableZoom
                target={camTarget}
                maxPolarAngle={Math.PI / 2 - 0.05}
                minDistance={0.5}
                maxDistance={50}
            />
        </>
    );
}
