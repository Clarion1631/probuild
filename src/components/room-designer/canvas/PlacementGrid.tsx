// Brighter overlay grid shown during active placement. Sits slightly above the
// base Grid in RoomCanvas so its lines read clearly against the floor. Rendered
// only while `placingAsset != null`.

import { Grid } from "@react-three/drei";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

export function PlacementGrid() {
    const gridSize = useRoomStore((s) => s.gridSize);

    return (
        <Grid
            position={[0, 0.005, 0]}
            args={[40, 40]}
            cellSize={gridSize}
            cellThickness={0.8}
            cellColor="#2f7dff"
            sectionSize={gridSize * 4}
            sectionThickness={1.2}
            sectionColor="#1e5dcc"
            fadeDistance={30}
            fadeStrength={1}
            infiniteGrid
        />
    );
}
