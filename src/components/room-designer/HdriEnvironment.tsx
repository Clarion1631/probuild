"use client";

// HdriEnvironment — single-Environment HDR lighting for the Room Designer.
//
// Pattern (borrowed from SurfaceMaterial.tsx at src/components/room-designer/materials/SurfaceMaterial.tsx:12-19):
//   1. <Environment files={HDRI_PRESETS[preset].file} background={false} />
//        — drei's Environment registers the texture on scene.environment, which
//          meshStandardMaterial uses for image-based lighting (IBL) automatically.
//   2. When `preset` changes, we DO re-render with the new `files` prop. drei
//      handles the texture swap internally — but the first render of a new URL
//      suspends the tree, which is why this component is wrapped in Suspense
//      + an error boundary by the caller.
//   3. Exposure fade: renderer.toneMappingExposure eases from the current value
//      toward `HDRI_PRESETS[preset].envIntensity` over 500ms via useFrame. This
//      gives a smooth perceived brightness transition without re-mounting the
//      environment.
//   4. <FallbackLights /> runs during Suspense and from the error boundary so
//      the scene never goes black (matches MaterialErrorBoundary behavior).

import { Component, ReactNode, Suspense, useEffect } from "react";
import { Environment } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { HDRI_PRESETS, type HdriPreset } from "@/lib/room-designer/hdri-presets";

interface HdriEnvironmentProps {
    preset: HdriPreset;
    /** Optional dev override — set background to the HDR for scene debugging. */
    background?: boolean;
}

export function HdriEnvironment({ preset, background = false }: HdriEnvironmentProps) {
    return (
        <EnvErrorBoundary>
            <Suspense fallback={<FallbackLights />}>
                <EnvInner preset={preset} background={background} />
            </Suspense>
        </EnvErrorBoundary>
    );
}

// ───────────── Inner loader — throws during HDR fetch ─────────────
interface EnvInnerProps {
    preset: HdriPreset;
    background: boolean;
}

function EnvInner({ preset, background }: EnvInnerProps) {
    const meta = HDRI_PRESETS[preset];

    // On mount, set tone mapping once. ACESFilmic is the PBR-correct default.
    const gl = useThree((s) => s.gl);
    useEffect(() => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        // No dep on `preset` here — the fade loop drives exposure after this.
    }, [gl]);

    return (
        <>
            <Environment files={meta.file} background={background} />
            <ExposureFade targetExposure={meta.envIntensity} />
        </>
    );
}

// ───────────── Exposure fade — 500ms linear ease ─────────────
function ExposureFade({ targetExposure }: { targetExposure: number }) {
    // useFrame runs every frame; easing is done in-place on the renderer so
    // no state churn. The easing is framerate-independent (delta-based).
    const DURATION_MS = 500;
    useFrame((state, delta) => {
        const gl = state.gl;
        const current = gl.toneMappingExposure;
        if (Math.abs(current - targetExposure) < 0.001) {
            gl.toneMappingExposure = targetExposure;
            return;
        }
        // Progress per frame: delta(seconds) / duration(seconds). Clamp 0..1.
        const step = Math.min(1, (delta * 1000) / DURATION_MS);
        gl.toneMappingExposure = current + (targetExposure - current) * step;
    });
    return null;
}

// ───────────── Fallback lights — Suspense + error fallback ─────────────
// Matches the old RoomCanvas lighting so a missing HDR file degrades to
// the pre-Stage-4 look rather than a black scene.
function FallbackLights() {
    return (
        <>
            <ambientLight intensity={0.55} />
            <directionalLight position={[4, 8, 4]} intensity={0.85} castShadow />
            <hemisphereLight args={["#ffffff", "#cccccc", 0.25]} />
        </>
    );
}

// ───────────── Error boundary ─────────────
// Same shape as MaterialErrorBoundary in SurfaceMaterial.tsx — a 404 on the
// HDR file rejects the fetch promise, which surfaces here rather than
// unmounting the entire canvas subtree.
class EnvErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
    constructor(props: { children: ReactNode }) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError() {
        return { hasError: true };
    }
    componentDidCatch(error: Error) {
        console.warn("[HdriEnvironment] HDR load failed, falling back to flat lights:", error.message);
    }
    render() {
        if (this.state.hasError) return <FallbackLights />;
        return this.props.children;
    }
}
