// Stage 0 asset renderer. Draws a box sized from the registry's real-world
// dimensions and colored by category. Stage 1 will swap in a <Gltf /> from
// @react-three/drei using the asset's modelPath.
//
// The mesh sits with its BOTTOM at y=0 (floor). Position from the store is
// applied as an offset on top of that — so (0,0,0) puts a 0.876m-tall base
// cabinet standing on the floor at the room origin.

import { useRef } from "react";
import type { Mesh } from "three";
import type { PlacedAsset } from "@/components/room-designer/types";
import { getAsset, CATEGORY_COLORS } from "@/lib/room-designer/asset-registry";

interface AssetInstanceProps {
    asset: PlacedAsset;
    selected: boolean;
    onSelect: (id: string) => void;
}

export function AssetInstance({ asset, selected, onSelect }: AssetInstanceProps) {
    const meshRef = useRef<Mesh>(null);
    const registry = getAsset(asset.assetId);

    if (!registry) {
        // Missing registry entry — render a magenta box so it's obvious in a demo.
        return (
            <mesh
                position={[asset.position.x, 0.25, asset.position.z]}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect(asset.id);
                }}
            >
                <boxGeometry args={[0.5, 0.5, 0.5]} />
                <meshStandardMaterial color="#ff00ff" />
            </mesh>
        );
    }

    const { width, height, depth } = registry.dimensions;
    const color = CATEGORY_COLORS[asset.assetType];

    // Position the asset with its base on the floor (y = height/2), then add
    // any vertical offset the user stored (wall cabinets, shelves).
    const y = asset.position.y + height / 2;

    return (
        <group
            position={[asset.position.x, y, asset.position.z]}
            rotation={[0, asset.rotationY, 0]}
            scale={[asset.scale.x, asset.scale.y, asset.scale.z]}
        >
            <mesh
                ref={meshRef}
                castShadow
                receiveShadow
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect(asset.id);
                }}
            >
                <boxGeometry args={[width, height, depth]} />
                <meshStandardMaterial color={color} roughness={0.6} metalness={0.05} />
            </mesh>
            {selected && (
                <mesh>
                    <boxGeometry args={[width * 1.02, height * 1.02, depth * 1.02]} />
                    <meshBasicMaterial color="#2f7dff" wireframe />
                </mesh>
            )}
        </group>
    );
}
