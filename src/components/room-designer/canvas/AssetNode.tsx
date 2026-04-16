// Stage 2 renderer for one placed asset.
//
// Two-branch render body:
//   - GLB branch: manifest is ready AND the asset has a public GLB URL →
//     <AssetGLB> inside a <Suspense> with a <PulsingBox> fallback.
//   - Box branch: everything else → the original labeled-box mesh.
//
// The outer <group> origin sits at the asset's vertical CENTER
// (`asset.position.y + height/2`) in BOTH branches. SelectionOutline,
// FloatingAssetToolbar, and the Text label all position relative to a
// centered origin, so moving the GLB branch's origin to the floor would
// drop all three by height/2. The GLB branch instead wraps <primitive>
// in an inner offset group at y = -height/2 so the model's internally
// floor-flushed bottom lines up with the box branch's floor.
//
// Positioning rule (preserved from AssetInstance): the mesh sits with its
// BOTTOM at y=0 (floor). PlacedAsset.position.y is added as an offset on
// top, so wall cabinets store their mount height in position.y.
//
// Stage 3:
//   - Multi-select: shift+click toggles, plain click overwrites.
//   - Double-click → focus PropertiesPanel.
//   - Right-click → open context menu.
//   - Skip render when view.hidden.
//   - Register group ref to CanvasContext meshRefs so TransformGizmo can
//     imperatively attach. Deregister on unmount — a hidden asset unmounts
//     its group and without cleanup `attach(staleGroup)` silently fails.
//   - FloatingAssetToolbar renders above the asset only for single-select.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Text, useGLTF } from "@react-three/drei";
import { Box3, Vector3, type Group, type Material, type Mesh } from "three";
import type { PlacedAsset } from "@/components/room-designer/types";
import { getAsset } from "@/lib/room-designer/asset-registry";
import {
    resolveColor,
    resolveDimensions,
    type ResolvedDimensions,
} from "@/lib/room-designer/asset-resolve";
import { isHidden, isLocked, getLabel } from "@/lib/room-designer/asset-view";
import {
    getModelUrl,
    useManifestReady,
} from "@/lib/room-designer/asset-manifest";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { SelectionOutline } from "./SelectionOutline";
import { FloatingAssetToolbar } from "./FloatingAssetToolbar";
import { useCanvasContext } from "./CanvasContext";

interface AssetNodeProps {
    asset: PlacedAsset;
    selected: boolean;
    isPrimary: boolean; // only the first selection gets the floating toolbar
    onSelect: (id: string, shiftKey: boolean) => void;
}

// LOD threshold — beyond this distance (m) we drop the Text label and shadow
// casting. 4m ≈ 13ft, far enough that the dropped detail isn't perceptible
// but covers most "zoomed out overview" camera positions.
const LOD_FAR_DISTANCE_M = 4;
const LOD_CHECK_EVERY_N_FRAMES = 30;

export function AssetNode({ asset, selected, isPrimary, onSelect }: AssetNodeProps) {
    const [hovered, setHovered] = useState(false);
    const [isFar, setIsFar] = useState(false);
    const frameCounter = useRef(0);
    const registry = getAsset(asset.assetId);
    const { meshRefs } = useCanvasContext();
    const groupRef = useRef<Group | null>(null);
    const openContextMenu = useRoomStore((s) => s.openContextMenu);
    const requestFocusProperties = useRoomStore((s) => s.requestFocusProperties);

    // Subscribe to manifest readiness so the GLB branch can activate after
    // the Supabase fetch resolves. No-op once loaded.
    const manifestReady = useManifestReady();

    // LOD: every 30 frames (~2Hz at 60fps), check camera distance to this
    // group and toggle `isFar` to drop shadow casting + label. Throttled to
    // keep this cheap with many assets in-scene.
    useFrame((state) => {
        frameCounter.current = (frameCounter.current + 1) % LOD_CHECK_EVERY_N_FRAMES;
        if (frameCounter.current !== 0) return;
        const g = groupRef.current;
        if (!g) return;
        const dx = state.camera.position.x - g.position.x;
        const dy = state.camera.position.y - g.position.y;
        const dz = state.camera.position.z - g.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const far = distSq > LOD_FAR_DISTANCE_M * LOD_FAR_DISTANCE_M;
        if (far !== isFar) setIsFar(far);
    });

    // Hidden assets don't render. They still show up in LayersPanel.
    const hidden = isHidden(asset);
    const locked = isLocked(asset);

    // Mount / unmount registration with the shared mesh-ref map.
    // Must run even when we later early-return in the missing-registry branch,
    // so we register regardless.
    useEffect(() => {
        const id = asset.id;
        return () => {
            meshRefs.current.delete(id);
        };
    }, [asset.id, meshRefs]);

    const registerGroup = (g: Group | null) => {
        groupRef.current = g;
        if (g) meshRefs.current.set(asset.id, g);
        else meshRefs.current.delete(asset.id);
    };

    if (hidden) return null;

    if (!registry) {
        // Missing registry entry — render a magenta box so it's obvious.
        return (
            <mesh
                position={[asset.position.x, 0.25, asset.position.z]}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect(asset.id, e.nativeEvent.shiftKey);
                }}
            >
                <boxGeometry args={[0.5, 0.5, 0.5]} />
                <meshStandardMaterial color="#ff00ff" />
            </mesh>
        );
    }

    const dims = resolveDimensions(asset, registry);
    const { width, height, depth } = dims;
    const color = resolveColor(asset, registry);

    // Position the asset with its base on the floor (y = height/2), then add
    // any vertical offset the user stored (wall cabinets, shelves).
    const y = asset.position.y + height / 2;

    // Suppress the label at long range — it's unreadable anyway and each
    // <Text> spins up an SDF font atlas. Hover/select overrides LOD so the
    // user still gets affordance when they interact.
    const showLabel = (hovered || selected) && !isFar;
    const label = getLabel(asset, registry);

    const modelUrl = manifestReady ? getModelUrl(asset.assetId) : null;

    return (
        <group
            ref={registerGroup}
            position={[asset.position.x, y, asset.position.z]}
            rotation={[0, asset.rotationY, 0]}
            scale={[asset.scale.x, asset.scale.y, asset.scale.z]}
            onClick={(e) => {
                e.stopPropagation();
                onSelect(asset.id, e.nativeEvent.shiftKey);
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                onSelect(asset.id, false);
                requestFocusProperties();
            }}
            onContextMenu={(e) => {
                e.stopPropagation();
                e.nativeEvent.preventDefault();
                onSelect(asset.id, false);
                openContextMenu(asset.id, e.nativeEvent.clientX, e.nativeEvent.clientY);
            }}
            onPointerEnter={(e) => {
                e.stopPropagation();
                setHovered(true);
            }}
            onPointerLeave={() => setHovered(false)}
        >
            {modelUrl ? (
                <Suspense fallback={<PulsingBox dims={dims} />}>
                    <group position={[0, -height / 2, 0]}>
                        <AssetGLB url={modelUrl} target={dims} isFar={isFar} />
                    </group>
                </Suspense>
            ) : (
                <mesh castShadow={!isFar} receiveShadow>
                    <boxGeometry args={[width, height, depth]} />
                    <meshStandardMaterial
                        color={color}
                        roughness={0.6}
                        metalness={0.05}
                        transparent={locked}
                        opacity={locked ? 0.85 : 1}
                    />
                </mesh>
            )}

            {showLabel && (
                <Text
                    position={[0, height / 2 + 0.08, 0]}
                    fontSize={0.08}
                    color="#1f2937"
                    anchorX="center"
                    anchorY="bottom"
                    outlineWidth={0.004}
                    outlineColor="#ffffff"
                >
                    {locked ? `🔒 ${label}` : label}
                </Text>
            )}

            {selected && <SelectionOutline width={width} height={height} depth={depth} />}

            {selected && isPrimary && (
                <FloatingAssetToolbar asset={asset} topY={height / 2} />
            )}
        </group>
    );
}

// Loading-state fallback while useGLTF fetches the GLB. Gentle sine pulse
// (0.95–1.0 scale) at the asset's registry dimensions, 40% opacity. Lives
// inside the GLB-branch's inner offset group, so its center-at-y=height/2
// position puts the bottom flush with the floor in world space.
function PulsingBox({ dims }: { dims: ResolvedDimensions }) {
    const ref = useRef<Mesh>(null);
    useFrame(({ clock }) => {
        if (!ref.current) return;
        const s = 0.95 + 0.05 * Math.sin(clock.elapsedTime * 2);
        ref.current.scale.setScalar(s);
    });
    return (
        <mesh ref={ref} position={[0, dims.height / 2, 0]}>
            <boxGeometry args={[dims.width, dims.height, dims.depth]} />
            <meshStandardMaterial color="#999" transparent opacity={0.4} />
        </mesh>
    );
}

// GLTF renderer for one placed asset. Fetches via drei's useGLTF (cached),
// deep-clones the scene + materials so per-instance opacity mutations from
// AssetsLayer's preview-mode fade don't leak across instances, and
// normalizes the mesh to match the registry's declared dimensions.
function AssetGLB({
    url,
    target,
    isFar,
}: {
    url: string;
    target: ResolvedDimensions;
    isFar: boolean;
}) {
    const { scene } = useGLTF(url);

    const { normalized, clonedMaterials } = useMemo(() => {
        const clone = scene.clone(true); // recursive clone; geometry stays shared

        // Clone every material so per-instance opacity mutation in
        // AssetsLayer's preview-mode fade (RoomCanvas.tsx:207-226) does NOT
        // leak across other instances of the same GLB. Track each cloned
        // material so we can dispose on unmount.
        const mats: Material[] = [];
        clone.traverse((o) => {
            const mesh = o as Mesh;
            const mat = mesh.material as Material | Material[] | undefined;
            if (!mat) return;
            if (Array.isArray(mat)) {
                const cloned = mat.map((m) => m.clone());
                mesh.material = cloned;
                mats.push(...cloned);
            } else {
                const cloned = mat.clone();
                mesh.material = cloned;
                mats.push(cloned);
            }
        });

        // Normalize to registry dimensions. Uniform scale to the MIN
        // per-axis ratio keeps proportions correct: the model fits inside
        // the target box with at least one axis flush, no axis overflows.
        const box = new Box3().setFromObject(clone);
        const size = new Vector3();
        const center = new Vector3();
        box.getSize(size);
        box.getCenter(center);
        const scale = Math.min(
            target.width / Math.max(size.x, 1e-6),
            target.height / Math.max(size.y, 1e-6),
            target.depth / Math.max(size.z, 1e-6),
        );
        clone.scale.setScalar(scale);

        // Arithmetic shift — uniform scale with no rotation means the
        // scaled center/min are just original*scale. No second Box3 pass.
        clone.position.x -= center.x * scale;
        clone.position.z -= center.z * scale;
        clone.position.y -= box.min.y * scale;

        return { normalized: clone, clonedMaterials: mats };
    }, [scene, target.width, target.height, target.depth]);

    // Shadow props — <primitive> doesn't pick up R3F's declarative
    // castShadow/receiveShadow props, so set directly on each Mesh in the
    // cloned tree. Re-runs on isFar changes to honor AssetNode's LOD.
    useEffect(() => {
        normalized.traverse((o) => {
            const mesh = o as Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = !isFar;
            mesh.receiveShadow = true;
        });
    }, [normalized, isFar]);

    // Dispose cloned materials on unmount. DO NOT dispose geometries —
    // BufferGeometry is shared with the useGLTF loader cache and other
    // live instances of the same asset.
    useEffect(() => {
        return () => {
            for (const m of clonedMaterials) m.dispose();
        };
    }, [clonedMaterials]);

    return <primitive object={normalized} />;
}
