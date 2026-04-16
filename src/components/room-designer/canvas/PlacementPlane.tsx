// Invisible 1000m × 1000m plane at Y=0 — the raycast target during active
// placement. It covers far more than the visual Floor so assets can be placed
// anywhere the camera reaches, not just inside the current room footprint.
//
// Mounted only when `placingAsset != null` so it doesn't intercept normal
// scene clicks and let users click through existing AssetNode meshes.

import type { ThreeEvent } from "@react-three/fiber";

interface PlacementPlaneProps {
    onMove: (x: number, z: number) => void;
    onConfirm: (x: number, z: number) => void;
}

export function PlacementPlane({ onMove, onConfirm }: PlacementPlaneProps) {
    const handleMove = (e: ThreeEvent<PointerEvent>) => {
        onMove(e.point.x, e.point.z);
    };
    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onConfirm(e.point.x, e.point.z);
    };

    return (
        <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0, 0]}
            onPointerMove={handleMove}
            onClick={handleClick}
        >
            <planeGeometry args={[1000, 1000]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
    );
}
