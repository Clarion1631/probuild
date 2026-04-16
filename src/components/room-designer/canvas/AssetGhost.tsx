// Transparent preview box rendered at the snapped cursor position while the
// user is placing a new asset. Green when placement is valid, red when it
// would collide. Pulses briefly on invalid click so the user gets feedback
// rather than a silent ignore.
//
// The ghost's dimensions come straight from `placingAsset.dimensions` — at
// placement time we don't yet have a PlacedAsset with metadata overrides, so
// registry dimensions are authoritative. The CabinetConfigurator edits the
// asset AFTER placement.

import { useRef, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import type { Mesh } from "three";
import type { Asset } from "@/lib/room-designer/asset-registry";

export type SnapLineKind = "grid" | "wall" | "edge";
export interface SnapLine {
    kind: SnapLineKind;
    from: [number, number, number];
    to: [number, number, number];
}

export interface GhostPose {
    x: number;
    z: number;
    rotationY: number;
    yOffset: number; // vertical offset (wall cabinets store this in position.y)
    valid: boolean;
    // Stage 3 snap feedback:
    snapLines?: SnapLine[];
    // Distance in meters from ghost center to the nearest wall; null if > 2m.
    nearestWallDistance?: number | null;
}

interface AssetGhostProps {
    asset: Asset;
    pose: GhostPose;
    pulseKey: number; // incremented to trigger a 200ms opacity pulse on invalid click
}

const VALID_COLOR = "#10b981";
const INVALID_COLOR = "#ef4444";
const PULSE_MS = 200;

export function AssetGhost({ asset, pose, pulseKey }: AssetGhostProps) {
    const meshRef = useRef<Mesh>(null);
    const pulseStart = useRef<number | null>(null);

    const { width, height, depth } = asset.dimensions;
    const y = pose.yOffset + height / 2;

    useEffect(() => {
        if (pulseKey > 0) pulseStart.current = performance.now();
    }, [pulseKey]);

    useFrame(() => {
        if (!meshRef.current) return;
        const mat = meshRef.current.material as { opacity?: number };
        let opacity = 0.35;
        if (pulseStart.current !== null) {
            const elapsed = performance.now() - pulseStart.current;
            if (elapsed < PULSE_MS) {
                // Strong fade pulse: goes to ~0.8 then back.
                const t = elapsed / PULSE_MS;
                opacity = 0.35 + 0.45 * Math.sin(t * Math.PI);
            } else {
                pulseStart.current = null;
            }
        }
        if ("opacity" in mat) mat.opacity = opacity;
    });

    return (
        <group position={[pose.x, y, pose.z]} rotation={[0, pose.rotationY, 0]}>
            <mesh ref={meshRef}>
                <boxGeometry args={[width, height, depth]} />
                <meshStandardMaterial
                    color={pose.valid ? VALID_COLOR : INVALID_COLOR}
                    transparent
                    opacity={0.35}
                    roughness={0.7}
                    metalness={0}
                    depthWrite={false}
                />
            </mesh>
        </group>
    );
}
