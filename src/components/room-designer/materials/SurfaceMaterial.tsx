"use client";

// Branching material renderer — flat color today, full PBR once Stage 1
// flips `hasPBR: true` on each Material. This is the ONLY file that calls
// `useTexture`; every mesh consumes <SurfaceMaterial /> as a child.
//
// Why two inner components instead of a conditional hook:
//   useTexture cannot be called conditionally (React rules-of-hooks). The
//   parent picks FlatMaterial OR PBRMaterial based on `material.hasPBR`,
//   so the hook in PBRMaterial only runs when texturePath is real.
//
// PBR loading is async — wrapped in <Suspense> + a class ErrorBoundary so a
// 404 on any of the 5 texture files (inevitable until Stage 1 lands) cannot
// crash the R3F canvas subtree. Both fallbacks render the flat color.
//
// Texture lifecycle: PBRMaterial acquires each of its 5 map URLs through the
// reference-counted cache in `src/lib/room-designer/texture-refcount.ts` and
// releases them on unmount. The refcount means a texture is only disposed
// when the LAST surface using that URL unmounts — which is the correct
// semantics given drei's shared URL-keyed `useTexture` cache.

import { Component, ReactNode, Suspense, useEffect, useMemo } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import {
    type Material,
    getMaterial,
    resolveMaterial,
} from "@/lib/room-designer/material-registry";
import { acquire, release } from "@/lib/room-designer/texture-refcount";

interface SurfaceMaterialProps {
    /** Id from MATERIAL_REGISTRY, or null for "use fallbackColor". */
    materialId: string | null | undefined;
    /** Hex color used when materialId is missing or doesn't resolve. */
    fallbackColor: string;
    /** Optional override — defaults applied to flat & PBR alike. */
    roughness?: number;
    metalness?: number;
    /** Tile repeat (PBR only). Pass [room_width_ft / 2, room_depth_ft / 2] for floors. */
    repeat?: [number, number];
    /**
     * Hover-preview override. When set, renders this id instead of materialId
     * without writing to the store. Used by MaterialLibrary swatches.
     */
    previewMaterialId?: string | null;
}

export function SurfaceMaterial({
    materialId,
    fallbackColor,
    roughness = 0.85,
    metalness = 0.05,
    repeat,
    previewMaterialId,
}: SurfaceMaterialProps) {
    const effectiveId = previewMaterialId ?? materialId;
    const material = resolveMaterial(effectiveId);

    // Unknown id → fall back to the caller's color (graceful for deleted
    // materials carried over in old layoutJson rows).
    const color = material?.color ?? fallbackColor;

    if (material?.hasPBR && material.texturePath) {
        return (
            <MaterialErrorBoundary fallbackColor={color} roughness={roughness} metalness={metalness}>
                <Suspense fallback={<FlatMaterial color={color} roughness={roughness} metalness={metalness} />}>
                    <PBRMaterial material={material} repeat={repeat} roughness={roughness} metalness={metalness} />
                </Suspense>
            </MaterialErrorBoundary>
        );
    }

    return <FlatMaterial color={color} roughness={roughness} metalness={metalness} />;
}

// ─────────────────────── Inner: flat color ───────────────────────
interface FlatMaterialProps {
    color: string;
    roughness: number;
    metalness: number;
}

function FlatMaterial({ color, roughness, metalness }: FlatMaterialProps) {
    return <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />;
}

// ─────────────────────── Inner: PBR (5-map) ───────────────────────
interface PBRMaterialProps {
    material: Material;
    repeat?: [number, number];
    roughness: number;
    metalness: number;
}

function PBRMaterial({ material, repeat, roughness, metalness }: PBRMaterialProps) {
    // material.hasPBR && material.texturePath are guaranteed by the parent.
    const path = material.texturePath as string;
    const urls = useMemo(
        () => ({
            map: `${path}_albedo.jpg`,
            normalMap: `${path}_normal.jpg`,
            roughnessMap: `${path}_roughness.jpg`,
            metalnessMap: `${path}_metalness.jpg`,
            aoMap: `${path}_ao.jpg`,
        }),
        [path],
    );

    const { map, normalMap, roughnessMap, metalnessMap, aoMap } = useTexture(urls);

    // Configure repeat once per URL set — re-running on every render would
    // thrash the GPU upload queue.
    useMemo(() => {
        const all = [map, normalMap, roughnessMap, metalnessMap, aoMap];
        for (const t of all) {
            if (!t) continue;
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            if (repeat) t.repeat.set(repeat[0], repeat[1]);
            t.needsUpdate = true;
        }
    }, [map, normalMap, roughnessMap, metalnessMap, aoMap, repeat]);

    // Refcount the 5 textures so GPU memory is freed when the LAST consumer
    // of a URL unmounts — not before. See texture-refcount.ts for the why.
    //
    // STAGE 1 NOTE: when `material.texturePath` changes on a live surface
    // (user swaps PBR→PBR), drei's `useTexture` may briefly return stale
    // textures for the NEW urls during the load. The cleanup below releases
    // the OLD urls correctly, but the acquire side will register new urls
    // pointing at possibly-stale texture objects for one render. To eliminate
    // the tiny disposal window, add a loading-state guard here that skips
    // `acquire` until the map URL matches `tex.source.data?.src`. Dormant in
    // Stage 0 (no PBR materials active).
    useEffect(() => {
        const pairs: Array<[string, THREE.Texture]> = [
            [urls.map, map],
            [urls.normalMap, normalMap],
            [urls.roughnessMap, roughnessMap],
            [urls.metalnessMap, metalnessMap],
            [urls.aoMap, aoMap],
        ];
        for (const [url, tex] of pairs) if (tex) acquire(url, tex);
        return () => {
            for (const [url] of pairs) release(url);
        };
    }, [urls, map, normalMap, roughnessMap, metalnessMap, aoMap]);

    return (
        <meshStandardMaterial
            map={map}
            normalMap={normalMap}
            roughnessMap={roughnessMap}
            metalnessMap={metalnessMap}
            aoMap={aoMap}
            roughness={roughness}
            metalness={metalness}
        />
    );
}

// ─────────────────────── Error boundary ───────────────────────
// React's <Suspense> catches THROWN PROMISES (loading state) but NOT errors —
// a 404 on a texture file rejects the load promise, which surfaces as an
// error here. Without this boundary, a single missing texture would unmount
// the whole canvas subtree (white screen).
interface MaterialErrorBoundaryProps {
    children: ReactNode;
    fallbackColor: string;
    roughness: number;
    metalness: number;
}

class MaterialErrorBoundary extends Component<
    MaterialErrorBoundaryProps,
    { hasError: boolean }
> {
    constructor(props: MaterialErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error: Error) {
        console.warn("[SurfaceMaterial] PBR texture load failed, falling back to flat:", error.message);
    }

    render() {
        if (this.state.hasError) {
            return (
                <FlatMaterial
                    color={this.props.fallbackColor}
                    roughness={this.props.roughness}
                    metalness={this.props.metalness}
                />
            );
        }
        return this.props.children;
    }
}

// Re-export getMaterial for callers that need the metadata (e.g. label text).
export { getMaterial };
