"use client";

// WindowLights — photoreal "sun through window" lights derived from placed
// window assets. One primary shadow-casting directionalLight + cheap
// pointLight fills for additional windows (Codex Q10a fix: shadow-map passes
// are the expensive cost; one caster + fills gives the directional feel
// without torching the frame budget on 5+ windows).
//
// Interior normal computation:
//   Windows sit flush against a wall. The interior normal points from the
//   wall plane INTO the room — we compute it from the nearest wall's
//   midpoint → roomCenter vector. This is enough for the 4-cardinal-wall
//   rectangular layouts Stage 0 produces; L-shape/U-shape rooms (Stage 1)
//   will need a more careful nearest-point-on-segment projection.

import { useMemo } from "react";
import * as THREE from "three";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { roomBounds } from "@/components/room-designer/core/geometry";
import type { Wall, PlacedAsset, RoomLayout } from "@/components/room-designer/types";
import { HDRI_PRESETS, type HdriPreset } from "@/lib/room-designer/hdri-presets";

interface WindowLightsProps {
    preset: HdriPreset;
}

export function WindowLights({ preset }: WindowLightsProps) {
    const assets = useRoomStore((s) => s.assets);
    const layout = useRoomStore((s) => s.layout);

    const windows = useMemo(
        () => assets.filter((a) => a.assetType === "window"),
        [assets],
    );

    const meta = HDRI_PRESETS[preset];

    if (windows.length === 0) return null;

    const center = roomCenter(layout);

    return (
        <>
            {windows.map((w, idx) => {
                const interiorPoint = stepInto(w, layout, 0.3); // 30 cm INSIDE the room
                const exteriorPoint = stepInto(w, layout, -1.5); // 1.5 m OUTSIDE the room

                if (idx === 0) {
                    // Primary: directional light, shadow-casting. Position it outside
                    // the window aiming at the room center so shadows project inward.
                    return (
                        <PrimaryWindowLight
                            key={w.id}
                            position={[exteriorPoint.x, meta.envIntensity > 1 ? 3 : 2.2, exteriorPoint.z]}
                            target={[center.x, 0.8, center.z]}
                            color={meta.windowLightColor}
                            intensity={meta.windowLightIntensity}
                        />
                    );
                }

                // Fills: cheap point lights just INSIDE the window, no shadows.
                return (
                    <pointLight
                        key={w.id}
                        position={[interiorPoint.x, 1.8, interiorPoint.z]}
                        color={meta.windowLightColor}
                        intensity={meta.windowLightIntensity * 0.6}
                        distance={8}
                        decay={2}
                        castShadow={false}
                    />
                );
            })}
        </>
    );
}

// ───────────── Primary shadow caster ─────────────
// Split out so the shadow-map config + target setup doesn't rerun for fills.
function PrimaryWindowLight({
    position,
    target,
    color,
    intensity,
}: {
    position: [number, number, number];
    target: [number, number, number];
    color: number;
    intensity: number;
}) {
    // Three's directionalLight needs its `target` object added to the scene AND
    // its position set. Using an <object3D> target at the desired world point
    // plus `ref.current.target = targetRef.current` is the idiomatic R3F
    // approach. Here we use the Three.js built-in convention: set
    // `target.position` AFTER mount via a ref.
    const targetObj = useMemo(() => {
        const o = new THREE.Object3D();
        o.position.set(target[0], target[1], target[2]);
        return o;
    }, [target]);

    return (
        <>
            <primitive object={targetObj} />
            <directionalLight
                position={position}
                color={color}
                intensity={intensity}
                castShadow
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
                shadow-bias={-0.0005}
                shadow-camera-near={0.5}
                shadow-camera-far={20}
                shadow-camera-left={-6}
                shadow-camera-right={6}
                shadow-camera-top={6}
                shadow-camera-bottom={-6}
                target={targetObj}
            />
        </>
    );
}

// ───────────── Geometry helpers ─────────────
function roomCenter(layout: RoomLayout): { x: number; z: number } {
    const b = roomBounds(layout);
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
}

/**
 * Project a window asset by `distance` meters along the interior normal
 * (positive = INTO the room). Negative distance moves OUTSIDE the room.
 */
function stepInto(
    w: PlacedAsset,
    layout: RoomLayout,
    distance: number,
): { x: number; z: number } {
    const center = roomCenter(layout);
    // Vector from window to room center = interior normal direction.
    const dx = center.x - w.position.x;
    const dz = center.z - w.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return { x: w.position.x, z: w.position.z };
    const nx = dx / len;
    const nz = dz / len;
    return { x: w.position.x + nx * distance, z: w.position.z + nz * distance };
}

// Keep the walls reference "used" so tree-shaking doesn't complain — the
// nearest-wall refinement is a known Stage 1 follow-up (see module header).
// (Intentionally not exported; documents the future API expansion.)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _reservedForNearestWallProjection(_w: PlacedAsset, _walls: Wall[]): void {}
