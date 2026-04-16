"use client";

// Stage 4 measurements overlay — activated by `showMeasurements` (M key).
// Three things render here:
//   1. Cardinal-wall dimension lines (drei <Line> inside <Canvas>)
//   2. Ceiling height label at the NE corner (<Html>)
//   3. Floor-plan sqft badge, top-left (<Html fullscreen prepend>)
//   4. Selected asset W×H×D floating near its anchor
//
// ClearanceOverlay (already shipped) renders the asset-to-asset clearance
// pairs, so THIS component is strictly about room dimensions + selection
// dims. Keep the two split to avoid re-render coupling.
//
// IMPORTANT: this component mounts INSIDE <Canvas>. It uses drei <Line> and
// <Html> which only work in that context.

import { Line, Html } from "@react-three/drei";
import { useMemo } from "react";
import { useRoomStore, useSelectedAssetId } from "@/components/room-designer/hooks/useRoomStore";
import { roomBounds } from "@/components/room-designer/core/geometry";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import {
    ceilingFtInLabel,
    metersToFtInLabel,
    roomLengthMeters,
    roomWidthMeters,
    sqFt,
} from "@/lib/room-designer/measurements";

export function MeasurementsOverlay() {
    const show = useRoomStore((s) => s.showMeasurements);
    const layout = useRoomStore((s) => s.layout);

    // Expensive derivations are memoized; cheap ones (labels) are inline.
    const b = useMemo(() => roomBounds(layout), [layout]);

    if (!show) return null;

    const widthM = roomWidthMeters(layout);
    const lengthM = roomLengthMeters(layout);
    const widthLabel = metersToFtInLabel(widthM);
    const lengthLabel = metersToFtInLabel(lengthM);
    const ceiling = ceilingFtInLabel(layout);
    const sqftLabel = sqFt(layout).toFixed(0);

    // Offset dimension lines 0.3 m outside the wall so they don't overlap the
    // wall mesh. Y = 0.02 puts them just above the floor for readability.
    const OFFSET = 0.3;
    const Y = 0.02;

    // North wall (z = b.minZ): draw line at z = b.minZ - OFFSET from minX to maxX
    const northFrom: [number, number, number] = [b.minX, Y, b.minZ - OFFSET];
    const northTo: [number, number, number] = [b.maxX, Y, b.minZ - OFFSET];
    const northMid: [number, number, number] = [(b.minX + b.maxX) / 2, Y, b.minZ - OFFSET];

    // South wall (z = b.maxZ)
    const southFrom: [number, number, number] = [b.minX, Y, b.maxZ + OFFSET];
    const southTo: [number, number, number] = [b.maxX, Y, b.maxZ + OFFSET];

    // East wall (x = b.maxX)
    const eastFrom: [number, number, number] = [b.maxX + OFFSET, Y, b.minZ];
    const eastTo: [number, number, number] = [b.maxX + OFFSET, Y, b.maxZ];
    const eastMid: [number, number, number] = [b.maxX + OFFSET, Y, (b.minZ + b.maxZ) / 2];

    // West wall (x = b.minX)
    const westFrom: [number, number, number] = [b.minX - OFFSET, Y, b.minZ];
    const westTo: [number, number, number] = [b.minX - OFFSET, Y, b.maxZ];

    // Ceiling label at NE corner (exterior of the room, so it doesn't collide
    // with wall dimension labels).
    const ceilingLabelPos: [number, number, number] = [b.maxX + OFFSET + 0.3, Y, b.minZ - OFFSET - 0.3];

    return (
        <group>
            {/* ─── Wall dimension lines ─── */}
            <Line points={[northFrom, northTo]} color="#475569" lineWidth={1.2} />
            <Line points={[southFrom, southTo]} color="#475569" lineWidth={1.2} />
            <Line points={[eastFrom, eastTo]} color="#475569" lineWidth={1.2} />
            <Line points={[westFrom, westTo]} color="#475569" lineWidth={1.2} />

            {/* Width label (shared N/S) */}
            <Html position={northMid} center style={{ pointerEvents: "none" }}>
                <div className="rounded bg-slate-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    {widthLabel}
                </div>
            </Html>

            {/* Length label (shared E/W) */}
            <Html position={eastMid} center style={{ pointerEvents: "none" }}>
                <div className="rounded bg-slate-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    {lengthLabel}
                </div>
            </Html>

            {/* Ceiling height at the NE corner */}
            <Html position={ceilingLabelPos} center style={{ pointerEvents: "none" }}>
                <div className="rounded bg-indigo-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    Ceiling {ceiling}
                </div>
            </Html>

            {/* ─── Selected-asset W×H×D ─── */}
            <SelectedAssetDims />

            {/* ─── Sqft badge — HTML fullscreen overlay, absolute top-left ─── */}
            {/*
              `fullscreen prepend` mounts at the root of the canvas wrapper as
              an absolutely-positioned div. Useful for chrome that shouldn't
              follow the 3D camera.
            */}
            <Html fullscreen prepend style={{ pointerEvents: "none" }}>
                <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-slate-900/85 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
                    {sqftLabel} ft²
                </div>
            </Html>
        </group>
    );
}

// ─────────────── Selected asset W×H×D readout ───────────────
function SelectedAssetDims() {
    const selectedId = useSelectedAssetId();
    const asset = useRoomStore((s) => s.assets.find((a) => a.id === selectedId) ?? null);

    if (!asset) return null;

    const registry = getAsset(asset.assetId);
    if (!registry) return null;

    const { width, height, depth } = resolveDimensions(asset, registry);
    const label = `${metersToFtInLabel(width)} × ${metersToFtInLabel(height)} × ${metersToFtInLabel(depth)}`;

    // Anchor at the asset's top-back-left so the tag doesn't block the gizmo.
    const pos: [number, number, number] = [
        asset.position.x - width / 2,
        asset.position.y + height + 0.08,
        asset.position.z - depth / 2,
    ];

    return (
        <Html position={pos} style={{ pointerEvents: "none" }}>
            <div className="rounded bg-slate-900/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                {label}
            </div>
        </Html>
    );
}
