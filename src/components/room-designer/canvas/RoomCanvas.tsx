// R3F root for a single room. This is the only file in `src/components/room-designer/`
// that touches `@react-three/fiber` — the rest are pure React components that
// *happen* to emit R3F primitives.
//
// FUTURE MOBILE: React Three Fiber has a React Native renderer
// (`@react-three/fiber/native`) that takes the exact same JSX tree. When the
// mobile app ships, this file is the only one that changes — swap the <Canvas>
// import for the native build and everything below renders identically.
//
// FUTURE AR: the scene graph is already in real-world meters, so an ARKit/ARCore
// session can drop this scene on top of an anchor with no coordinate conversion.
// When Stage 4 adds AR preview, we render this same subtree inside an
// <ARCanvas /> instead of <Canvas />.
//
// FUTURE LIDAR: once Apple RoomPlan USDZ import lands, the `layout` prop will be
// produced by `importFromRoomPlan(...)` instead of `buildDefaultLayout()`.
// Walls/Floor/Ceiling/AssetInstance all render it unchanged.

import { Canvas } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { Walls } from "./Walls";
import { Floor } from "./Floor";
import { Ceiling } from "./Ceiling";
import { AssetInstance } from "./AssetInstance";
import { CameraRig } from "./CameraRig";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

export function RoomCanvas() {
    const layout = useRoomStore((s) => s.layout);
    const assets = useRoomStore((s) => s.assets);
    const selectedAssetId = useRoomStore((s) => s.selectedAssetId);
    const viewMode = useRoomStore((s) => s.viewMode);
    const selectAsset = useRoomStore((s) => s.selectAsset);

    const is2D = viewMode === "2d";

    return (
        <Canvas
            shadows
            dpr={[1, 2]}
            gl={{ antialias: true, preserveDrawingBuffer: true }}
            onPointerMissed={() => selectAsset(null)}
        >
            <CameraRig layout={layout} viewMode={viewMode} />

            {/* Lighting: ambient + a soft directional "sun" so materials read clearly */}
            <ambientLight intensity={0.55} />
            <directionalLight
                position={[layout.dimensions.width, layout.dimensions.height * 2, layout.dimensions.length]}
                intensity={0.85}
                castShadow
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
            />
            <hemisphereLight args={["#ffffff", "#cccccc", 0.25]} />

            {/* Grid for visual reference — brighter in 2D, subtle in 3D */}
            <Grid
                position={[0, 0.001, 0]}
                args={[40, 40]}
                cellSize={0.3048 /* 1 ft */}
                cellThickness={0.5}
                cellColor="#c9c5bc"
                sectionSize={3.048 /* 10 ft */}
                sectionThickness={1}
                sectionColor="#8a8f97"
                fadeDistance={30}
                fadeStrength={is2D ? 0 : 1}
                infiniteGrid
            />

            <Floor layout={layout} />
            <Walls layout={layout} />
            {/* Hide ceiling in 2D so the plan view stays readable. */}
            <Ceiling layout={layout} visible={!is2D} />

            {assets.map((asset) => (
                <AssetInstance
                    key={asset.id}
                    asset={asset}
                    selected={asset.id === selectedAssetId}
                    onSelect={selectAsset}
                />
            ))}
        </Canvas>
    );
}
