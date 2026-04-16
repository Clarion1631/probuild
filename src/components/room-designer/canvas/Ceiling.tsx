// Ceiling plane. Hidden in 2D top-down view so the user can see into the room;
// visibility is controlled by the parent canvas via the `visible` prop.

import type { RoomLayout } from "@/components/room-designer/types";
import { roomBounds } from "@/components/room-designer/core/geometry";

interface CeilingProps {
    layout: RoomLayout;
    visible?: boolean;
}

export function Ceiling({ layout, visible = true }: CeilingProps) {
    const { minX, maxX, minZ, maxZ } = roomBounds(layout);
    const width = Math.max(maxX - minX, 0.01);
    const depth = Math.max(maxZ - minZ, 0.01);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const y = layout.dimensions.height;

    return (
        <mesh position={[cx, y, cz]} rotation={[Math.PI / 2, 0, 0]} visible={visible}>
            <planeGeometry args={[width, depth]} />
            <meshStandardMaterial color="#f5f3ee" roughness={0.95} metalness={0} side={2 /* DoubleSide */} />
        </mesh>
    );
}
