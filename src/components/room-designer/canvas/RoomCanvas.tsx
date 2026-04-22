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
// Walls/Floor/Ceiling/AssetNode all render it unchanged.

import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { useEffect, useRef } from "react";
import type { Group, Material, Mesh } from "three";
import { Walls } from "./Walls";
import { Floor } from "./Floor";
import { Ceiling } from "./Ceiling";
import { AssetNode } from "./AssetNode";
import { CameraRig } from "./CameraRig";
import { PlacementGrid } from "./PlacementGrid";
import { PlacementPlane } from "./PlacementPlane";
import { AssetGhost } from "./AssetGhost";
import { CanvasContextProvider } from "./CanvasContext";
import { TransformGizmo } from "./TransformGizmo";
import { DragPlane } from "./DragPlane";
import { NavigationCube } from "./NavigationCube";
import { SnapIndicators, TransformSnapIndicators } from "./SnapIndicators";
import { ClearanceOverlay } from "./ClearanceOverlay";
import { WindowLights } from "./WindowLights";
import { PostEffects } from "./PostEffects";
import { MeasurementsOverlay } from "@/components/room-designer/MeasurementsOverlay";
import { HdriEnvironment } from "@/components/room-designer/HdriEnvironment";
import { useCameraPresets } from "@/components/room-designer/hooks/useCameraPresets";
import { useAssetPlacement } from "@/components/room-designer/hooks/useAssetPlacement";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { DEFAULT_PRESET } from "@/lib/room-designer/hdri-presets";

export function RoomCanvas() {
    const layout = useRoomStore((s) => s.layout);
    const viewMode = useRoomStore((s) => s.viewMode);
    const placingAsset = useRoomStore((s) => s.placingAsset);
    const clearSelection = useRoomStore((s) => s.clearSelection);
    const setActiveSurface = useRoomStore((s) => s.setActiveSurface);
    const closeContextMenu = useRoomStore((s) => s.closeContextMenu);

    const is2D = viewMode === "2d";
    const hdriPreset = layout.lighting?.hdriPreset ?? DEFAULT_PRESET;

    return (
        <Canvas
            shadows
            dpr={[1, 1.5]}
            gl={{
                antialias: true,
                preserveDrawingBuffer: true,
                toneMapping: THREE.ACESFilmicToneMapping,
                toneMappingExposure: 1.0,
            }}
            onPointerMissed={() => {
                // Don't clear selection while actively placing — that would feel like a bug.
                if (placingAsset) return;
                // Clear BOTH selections so MaterialLibrary and "Selected Item"
                // both close together when the user clicks empty canvas.
                clearSelection();
                setActiveSurface(null);
                closeContextMenu();
            }}
        >
            <CanvasContextProvider>
                <SceneRefBridge />
                <CameraRig layout={layout} viewMode={viewMode} />

                {/*
                  Stage 4 lighting: HDRI environment (IBL) + window-derived lights.
                  A small ambient + directional pair remains as fallback fill so
                  the scene never reads as entirely flat if the HDR preset has
                  low envIntensity.
                */}
                <HdriEnvironment preset={hdriPreset} />
                <WindowLights preset={hdriPreset} />
                <ambientLight intensity={0.15} />
                <directionalLight
                    position={[layout.dimensions.width, layout.dimensions.height * 2, layout.dimensions.length]}
                    intensity={0.2}
                    castShadow={false}
                />

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

                <AssetsLayer />

                {/* Stage 3 canvas overlays */}
                <TransformGizmo />
                <DragPlane />
                <TransformSnapIndicators />
                <NavigationCube />
                <ClearanceOverlay />
                <MeasurementsOverlay />
                <CameraPresetDriver />

                {placingAsset && <PlacementLayer />}

                {/*
                  Post-processing must be the LAST child of <Canvas> so it
                  captures the final scene framebuffer. Disabled in 2D (ortho)
                  because SSAO on a top-down plan is perceptually wrong —
                  there are no corners to darken.
                */}
                <PostEffectsBridge disabled={is2D} />
            </CanvasContextProvider>
        </Canvas>
    );
}

// Subscribes to store.effectsEnabled without re-rendering the lights/camera
// tree. Reads `disabled` from the outer 2D/3D toggle and AND's it in.
function PostEffectsBridge({ disabled }: { disabled: boolean }) {
    const effectsEnabled = useRoomStore((s) => s.effectsEnabled);
    return <PostEffects enabled={effectsEnabled && !disabled} />;
}

// Stage 4: Before/After fade wrapper.
//
// Group-level opacity + visibility tween driven by `previewMode`:
//   - "design" → group visible, materials at their declared opacity
//   - "empty"  → group hidden, materials faded to 0 over 0.4s
//
// IMPLEMENTATION NOTE: in Stage 0 every AssetNode uses a UNIQUE material
// (per-asset box fallback), so traverse-and-mutate is safe. When Stage 2+
// ships GLB models with SHARED materials (same texture atlas across cabinets),
// this approach would corrupt the shared material. Switch to the GLB-safe
// path then:
//   1. Render a full-screen <Html fullscreen prepend> overlay div.
//   2. On `previewMode` change, fade the overlay white (0→60% opacity) over
//      200ms, toggle `group.visible` at the peak, then fade overlay back to 0.
//   3. Do NOT mutate material opacity at all.
// The logic below mutates materials only DURING the animation, then lets
// React's declarative opacity values (e.g. locked 0.85) take over once
// settled — so at rest there's no corruption.
function AssetsLayer() {
    const previewMode = useRoomStore((s) => s.previewMode);
    const groupRef = useRef<Group | null>(null);
    const opacityRef = useRef(1);
    const animatingRef = useRef(false);

    // Mark animation dirty when mode flips. useFrame drives the actual tween.
    useEffect(() => {
        animatingRef.current = true;
    }, [previewMode]);

    useFrame((_, delta) => {
        const g = groupRef.current;
        if (!g) return;

        const target = previewMode === "design" ? 1 : 0;
        const cur = opacityRef.current;

        // Settled — stop mutating so AssetNode's declarative opacity (e.g. 0.85
        // for locked assets) can render through unchanged.
        if (!animatingRef.current && cur === target) return;

        const wasAnimating = animatingRef.current;

        let next: number;
        let justSettled = false;
        if (Math.abs(target - cur) < 0.005) {
            next = target;
            animatingRef.current = false;
            justSettled = wasAnimating; // true only on the transition frame
        } else {
            // Exponential approach, ~0.4s to settle (time constant ≈ 0.1s).
            next = cur + (target - cur) * Math.min(1, delta * 10);
            animatingRef.current = true;
        }
        opacityRef.current = next;
        g.visible = next > 0.005;

        // Mutate material opacity while animating OR on the frame we just
        // settled. The settle frame reverts `transparent` to false and
        // `opacity` to 1 so unlocked assets don't render with residual
        // alpha blending (z-fighting); locked assets' 0.85 is re-applied
        // on the next React reconciliation pass.
        if (animatingRef.current || justSettled) {
            const settledOpaque = justSettled && target === 1;
            g.traverse((o) => {
                const mesh = o as Mesh;
                const mat = mesh.material as Material | Material[] | undefined;
                if (!mat) return;
                const apply = (m: Material) => {
                    if (!("opacity" in m) || !("transparent" in m)) return;
                    const mm = m as THREE.Material & { transparent: boolean; opacity: number };
                    if (settledOpaque) {
                        mm.transparent = false;
                        mm.opacity = 1;
                    } else {
                        mm.transparent = true;
                        mm.opacity = next;
                    }
                };
                if (Array.isArray(mat)) mat.forEach(apply);
                else apply(mat);
            });
        }
    });

    return (
        <group ref={groupRef}>
            <SceneAssets />
        </group>
    );
}

// Assets are rendered in a child component so selection changes re-render
// this list, not the whole CameraRig/lighting tree.
function SceneAssets() {
    const assets = useRoomStore((s) => s.assets);
    const selectedAssetIds = useRoomStore((s) => s.selectedAssetIds);
    const selectAsset = useRoomStore((s) => s.selectAsset);
    const toggleAssetInSelection = useRoomStore((s) => s.toggleAssetInSelection);

    const selected = new Set(selectedAssetIds);
    const primary = selectedAssetIds[0] ?? null;

    return (
        <>
            {assets.map((asset) => (
                <AssetNode
                    key={asset.id}
                    asset={asset}
                    selected={selected.has(asset.id)}
                    isPrimary={asset.id === primary}
                    onSelect={(id, shiftKey) => {
                        if (shiftKey) toggleAssetInSelection(id);
                        else selectAsset(id);
                    }}
                />
            ))}
        </>
    );
}

// Camera preset driver — runs the tween loop inside <Canvas>. No-op hook
// on days with no pending animation.
function CameraPresetDriver() {
    useCameraPresets();
    return null;
}

// Stage 4: publishes the live renderer/scene/camera to the store so the
// Export buttons (PNG/PDF) can read them imperatively without subscribing.
// Writing happens once on mount and on camera swap (2D↔3D toggle rebuilds
// CameraRig, giving us a new camera ref).
function SceneRefBridge() {
    const { gl, scene, camera } = useThree();
    const setCanvasRefs = useRoomStore((s) => s.setCanvasRefs);
    useEffect(() => {
        setCanvasRefs({ gl, scene, camera });
        return () => setCanvasRefs(null);
    }, [gl, scene, camera, setCanvasRefs]);
    return null;
}

// Placement overlay — kept as a child component so the hook only mounts while
// the user is actively placing. On cancel it unmounts and stops raycasting.
function PlacementLayer() {
    const placingAsset = useRoomStore((s) => s.placingAsset);
    const { pose, pulseKey, handleMove, handleConfirm } = useAssetPlacement();

    if (!placingAsset) return null;

    return (
        <>
            <PlacementGrid />
            <PlacementPlane onMove={handleMove} onConfirm={handleConfirm} />
            {pose && <AssetGhost asset={placingAsset} pose={pose} pulseKey={pulseKey} />}
            {pose && <SnapIndicators pose={pose} />}
        </>
    );
}
