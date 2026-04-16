// Floor plane. Stage 0: plain grey PlaneGeometry + MeshStandardMaterial.
// Stage 2 swaps in a PBR material keyed by layout.surfaces.floor.

import type { RoomLayout } from "@/components/room-designer/types";
import { roomBounds } from "@/components/room-designer/core/geometry";

interface FloorProps {
    layout: RoomLayout;
}

export function Floor({ layout }: FloorProps) {
    const { minX, maxX, minZ, maxZ } = roomBounds(layout);
    const width = Math.max(maxX - minX, 0.01);
    const depth = Math.max(maxZ - minZ, 0.01);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    return (
        <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[width, depth]} />
            <meshStandardMaterial color="#e8e5df" roughness={0.9} metalness={0} />
        </mesh>
    );
}
