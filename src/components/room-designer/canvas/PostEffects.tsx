"use client";

// Stage 4 post-processing: SSAO (ambient occlusion) + Bloom.
//
// Why SSAO: flat gray corners look synthetic. SSAO darkens creases where
// geometry meets, which is the single biggest perceived-quality win when
// moving from flat lighting to PBR.
//
// Why Bloom: highlights from bright HDR sunlight through windows benefit
// from a soft halo. Threshold is tuned high so it only affects
// intentionally-bright pixels (window HDR pass-through), not the diffuse
// scene.
//
// Mounts after the scene graph — EffectComposer must be the LAST child of
// <Canvas> so it captures the final framebuffer.

import { EffectComposer, SSAO, Bloom } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";

interface PostEffectsProps {
    enabled: boolean;
}

export function PostEffects({ enabled }: PostEffectsProps) {
    if (!enabled) return null;
    return (
        <EffectComposer multisampling={4}>
            <SSAO
                radius={0.5}
                intensity={1.2}
                luminanceInfluence={0.5}
                blendFunction={BlendFunction.MULTIPLY}
                // Required by the type system; default values from the postprocessing
                // docs. Prevents banding at low samples.
                samples={16}
                rings={4}
                worldDistanceThreshold={1}
                worldDistanceFalloff={0.2}
                worldProximityThreshold={0.5}
                worldProximityFalloff={0.2}
                distanceScaling
                depthAwareUpsampling
            />
            <Bloom
                luminanceThreshold={0.9}
                luminanceSmoothing={0.2}
                intensity={0.4}
                mipmapBlur
            />
        </EffectComposer>
    );
}
