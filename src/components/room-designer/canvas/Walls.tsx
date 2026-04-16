// Renders all walls in the layout as thin boxes. Stage 2: each cardinal wall
// (with a `surface` field, or matching id in wallSurface()) is clickable and
// driven by layout.surfaces.<wall-X>. Free-form walls without a surface key
// fall back to the flat fallback color and are not selectable.

import type { RoomLayout, RoomSurface } from "@/components/room-designer/types";
import { wallTransform } from "@/components/room-designer/core/geometry";
import { SurfaceMaterial } from "@/components/room-designer/materials/SurfaceMaterial";
import {
    useHoverPreview,
    useResolvedSurfaceMaterial,
} from "@/components/room-designer/materials/useMaterials";
import { wallSurface } from "@/components/room-designer/materials/SurfaceSelector";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

interface WallsProps {
    layout: RoomLayout;
}

export function Walls({ layout }: WallsProps) {
    return (
        <group>
            {layout.walls.map((wall) => {
                const { center, length, angleY } = wallTransform(wall);
                if (length <= 0) return null;
                const surface = wallSurface(wall);
                return (
                    <WallBox
                        key={wall.id}
                        surface={surface}
                        position={[center.x, wall.height / 2, center.z]}
                        rotation={[0, angleY, 0]}
                        size={[length, wall.height, wall.thickness]}
                    />
                );
            })}
        </group>
    );
}

function WallBox({
    surface,
    position,
    rotation,
    size,
}: {
    surface: RoomSurface | null;
    position: [number, number, number];
    rotation: [number, number, number];
    size: [number, number, number];
}) {
    // Hooks must run unconditionally — pass a benign surface ("floor") to the
    // resolver when this wall has no surface slot, then ignore the result below.
    const persistedId = useResolvedSurfaceMaterial(surface ?? "floor");
    const previewId = useHoverPreview((s) =>
        surface !== null && s.hoveredTarget === surface ? s.hoveredMaterialId : null,
    );
    const isActive = useRoomStore((s) => surface !== null && s.activeSurface === surface);
    const setActiveSurface = useRoomStore((s) => s.setActiveSurface);

    const handleClick = surface
        ? (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            setActiveSurface(surface);
        }
        : undefined;

    return (
        <group position={position} rotation={rotation}>
            <mesh castShadow receiveShadow onClick={handleClick}>
                <boxGeometry args={size} />
                <SurfaceMaterial
                    materialId={surface ? persistedId : null}
                    previewMaterialId={surface ? previewId : null}
                    fallbackColor="#f2ece1"
                    roughness={0.85}
                    metalness={0}
                />
            </mesh>
            {isActive && (
                <mesh raycast={() => null}>
                    <boxGeometry args={[size[0] * 1.01, size[1] * 1.01, size[2] * 1.5]} />
                    <meshBasicMaterial color="#2f7dff" wireframe />
                </mesh>
            )}
        </group>
    );
}
