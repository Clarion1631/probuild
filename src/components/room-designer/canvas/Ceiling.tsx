// Ceiling plane. Hidden in 2D top-down view. Stage 2: clickable in 3D, driven
// by layout.surfaces.ceiling, blue wireframe outline when active.

import type { RoomLayout } from "@/components/room-designer/types";
import { roomBounds } from "@/components/room-designer/core/geometry";
import { SurfaceMaterial } from "@/components/room-designer/materials/SurfaceMaterial";
import {
    useHoverPreview,
    useResolvedSurfaceMaterial,
} from "@/components/room-designer/materials/useMaterials";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

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

    const materialId = useResolvedSurfaceMaterial("ceiling");
    const previewId = useHoverPreview((s) =>
        s.hoveredTarget === "ceiling" ? s.hoveredMaterialId : null,
    );
    const isActive = useRoomStore((s) => s.activeSurface === "ceiling");
    const setActiveSurface = useRoomStore((s) => s.setActiveSurface);

    return (
        <group visible={visible}>
            <mesh
                position={[cx, y, cz]}
                rotation={[Math.PI / 2, 0, 0]}
                onClick={(e) => {
                    e.stopPropagation();
                    setActiveSurface("ceiling");
                }}
            >
                <planeGeometry args={[width, depth]} />
                <SurfaceMaterial
                    materialId={materialId}
                    previewMaterialId={previewId}
                    fallbackColor="#f5f3ee"
                    roughness={0.95}
                    metalness={0}
                />
            </mesh>
            {isActive && (
                <mesh
                    position={[cx, y - 0.002, cz]}
                    rotation={[Math.PI / 2, 0, 0]}
                    raycast={() => null}
                >
                    <planeGeometry args={[width * 1.005, depth * 1.005]} />
                    <meshBasicMaterial color="#2f7dff" wireframe />
                </mesh>
            )}
        </group>
    );
}
