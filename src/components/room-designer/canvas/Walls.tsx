// Renders all walls in the layout as thin boxes. Stage 0 uses a flat painted
// material; Stage 2 swaps in wall-specific PBR materials from layout.surfaces.

import type { RoomLayout } from "@/components/room-designer/types";
import { wallTransform } from "@/components/room-designer/core/geometry";

interface WallsProps {
    layout: RoomLayout;
}

export function Walls({ layout }: WallsProps) {
    return (
        <group>
            {layout.walls.map((wall) => {
                const { center, length, angleY } = wallTransform(wall);
                if (length <= 0) return null;
                return (
                    <mesh
                        key={wall.id}
                        position={[center.x, wall.height / 2, center.z]}
                        rotation={[0, angleY, 0]}
                        castShadow
                        receiveShadow
                    >
                        <boxGeometry args={[length, wall.height, wall.thickness]} />
                        <meshStandardMaterial color="#f2ece1" roughness={0.85} metalness={0} />
                    </mesh>
                );
            })}
        </group>
    );
}
