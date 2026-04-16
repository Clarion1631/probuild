// Stage 3: camera preset animator.
//
// Runs inside <Canvas> (mounted by RoomCanvas → CameraPresetDriver). When the
// store's `cameraPreset` changes, we compute target camera position + orbit
// target, then lerp both over ~0.3s using useFrame. Orthographic ⇄ perspective
// cannot tween (different camera types) — the preset setter either coerces
// viewMode or we accept a hard swap. For this implementation, Top/Front/
// Side/Back force 2D (ortho), "iso" forces 3D (perspective). Within the same
// camera type we lerp.

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { useRoomStore } from "./useRoomStore";
import { useCanvasContext } from "@/components/room-designer/canvas/CanvasContext";
import { roomBounds } from "@/components/room-designer/core/geometry";
import type { CameraPreset } from "@/components/room-designer/types";

const DURATION = 0.3; // seconds

interface Anim {
    fromPos: Vector3;
    toPos: Vector3;
    fromTgt: Vector3;
    toTgt: Vector3;
    t: number;
}

function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Compute target camera position and orbit target for a preset.
// Returns null for presets whose camera type doesn't match the current view.
function targetsFor(
    preset: CameraPreset,
    cx: number,
    cy: number,
    cz: number,
    span: number,
    height: number,
): { pos: Vector3; tgt: Vector3 } {
    const dist = span * 1.5;
    switch (preset) {
        case "top":
            return { pos: new Vector3(cx, 10, cz), tgt: new Vector3(cx, 0, cz) };
        case "front":
            return { pos: new Vector3(cx, cy, cz + dist), tgt: new Vector3(cx, cy, cz) };
        case "back":
            return { pos: new Vector3(cx, cy, cz - dist), tgt: new Vector3(cx, cy, cz) };
        case "left":
            return { pos: new Vector3(cx - dist, cy, cz), tgt: new Vector3(cx, cy, cz) };
        case "right":
            return { pos: new Vector3(cx + dist, cy, cz), tgt: new Vector3(cx, cy, cz) };
        case "iso":
            return {
                pos: new Vector3(cx + span * 1.2, height * 1.3, cz + span * 1.2),
                tgt: new Vector3(cx, height / 2, cz),
            };
    }
}

export function useCameraPresets() {
    const preset = useRoomStore((s) => s.cameraPreset);
    const layout = useRoomStore((s) => s.layout);
    const viewMode = useRoomStore((s) => s.viewMode);
    const setViewMode = useRoomStore((s) => s.setViewMode);
    const { camera } = useThree();
    const { orbitRef } = useCanvasContext();

    const animRef = useRef<Anim | null>(null);

    // Start an animation whenever the preset changes.
    useEffect(() => {
        if (preset === "orbit") {
            animRef.current = null;
            return;
        }

        // Coerce viewMode to match the preset's camera type. This is a HARD
        // swap — we skip animation for this case because ortho ⇄ perspective
        // cannot lerp smoothly.
        const wantsOrtho = preset !== "iso";
        const desiredViewMode = wantsOrtho ? "2d" : "3d";
        if (viewMode !== desiredViewMode) {
            setViewMode(desiredViewMode);
            // Bail out — CameraRig will rebuild the camera on viewMode change.
            // The next render picks up the new camera at a sensible default.
            animRef.current = null;
            return;
        }

        const { minX, maxX, minZ, maxZ } = roomBounds(layout);
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;
        const cy = layout.dimensions.height / 2;
        const span = Math.max(maxX - minX, maxZ - minZ, 1);

        const t = targetsFor(preset, cx, cy, cz, span, layout.dimensions.height);

        const orbit = orbitRef.current;
        const fromPos = camera.position.clone();
        const fromTgt = orbit ? orbit.target.clone() : new Vector3(cx, cy, cz);

        animRef.current = {
            fromPos,
            toPos: t.pos,
            fromTgt,
            toTgt: t.tgt,
            t: 0,
        };
    }, [preset, viewMode, setViewMode, layout, camera, orbitRef]);

    useFrame((_, dt) => {
        const anim = animRef.current;
        if (!anim) return;
        anim.t = Math.min(1, anim.t + dt / DURATION);
        const e = easeInOutCubic(anim.t);
        camera.position.lerpVectors(anim.fromPos, anim.toPos, e);
        const orbit = orbitRef.current;
        if (orbit) {
            orbit.target.lerpVectors(anim.fromTgt, anim.toTgt, e);
            orbit.update();
        }
        camera.lookAt(orbit?.target ?? anim.toTgt);
        if (anim.t >= 1) animRef.current = null;
    });
}
