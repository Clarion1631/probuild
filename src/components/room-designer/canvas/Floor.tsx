// Floor plane. Stage 2: PBR-ready material driven by layout.surfaces.floor,
// click-to-select for the MaterialLibrary, blue wireframe outline when active.

import type { RoomLayout } from "@/components/room-designer/types";
import { roomBounds } from "@/components/room-designer/core/geometry";
import { SurfaceMaterial } from "@/components/room-designer/materials/SurfaceMaterial";
import {
    useHoverPreview,
    useResolvedSurfaceMaterial,
} from "@/components/room-designer/materials/useMaterials";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

interface FloorProps {
    layout: RoomLayout;
}

export function Floor({ layout }: FloorProps) {
    const { minX, maxX, minZ, maxZ } = roomBounds(layout);
    const width = Math.max(maxX - minX, 0.01);
    const depth = Math.max(maxZ - minZ, 0.01);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    const materialId = useResolvedSurfaceMaterial("floor");
    const previewId = useHoverPreview((s) =>
        s.hoveredTarget === "floor" ? s.hoveredMaterialId : null,
    );
    const setActiveSurface = useRoomStore((s) => s.setActiveSurface);
    const isActive = useRoomStore((s) => s.activeSurface === "floor");

    // Tile repeat — 1 unit per ~2 ft of floor so PBR textures don't look stretched.
    const repeat: [number, number] = [Math.max(1, width / 0.6), Math.max(1, depth / 0.6)];

    return (
        <group>
            <mesh
                position={[cx, 0, cz]}
                rotation={[-Math.PI / 2, 0, 0]}
                receiveShadow
                onClick={(e) => {
                    e.stopPropagation();
                    setActiveSurface("floor");
                }}
            >
                <planeGeometry args={[width, depth]} />
                <SurfaceMaterial
                    materialId={materialId}
                    previewMaterialId={previewId}
                    fallbackColor="#e8e5df"
                    roughness={0.9}
                    metalness={0}
                    repeat={repeat}
                />
            </mesh>
            {isActive && (
                <mesh
                    position={[cx, 0.002, cz]}
                    rotation={[-Math.PI / 2, 0, 0]}
                    // Outline ignores raycast so clicks fall through to the floor.
                    raycast={() => null}
                >
                    <planeGeometry args={[width * 1.005, depth * 1.005]} />
                    <meshBasicMaterial color="#2f7dff" wireframe />
                </mesh>
            )}
        </group>
    );
}
