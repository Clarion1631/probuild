"use client";

// Stage 4 measurements overlay. Two layers render here:
//   A. Selection size pill — ALWAYS visible when an asset is selected
//      (purple W×H×D capsule near the asset's top-back corner). The
//      reference UX shows this regardless of the measurements toggle.
//   B. Room/clearance overlays — gated on `showMeasurements` (M key):
//        1. Cardinal wall dimension lines + labels
//        2. Ceiling height tag at the NE corner
//        3. Floor-plan sqft badge (HTML fullscreen overlay)
//        4. Per-wall clearance distances for the selected asset
//
// ClearanceOverlay (already shipped) renders asset-to-asset clearance pairs;
// keep that separate from this room/selection overlay to avoid re-render
// coupling.
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

    if (!show) {
        // Selection pill stays visible even with room measurements off.
        return (
            <group>
                <SelectedAssetSizePill />
            </group>
        );
    }

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

    const northFrom: [number, number, number] = [b.minX, Y, b.minZ - OFFSET];
    const northTo: [number, number, number] = [b.maxX, Y, b.minZ - OFFSET];
    const northMid: [number, number, number] = [(b.minX + b.maxX) / 2, Y, b.minZ - OFFSET];

    const southFrom: [number, number, number] = [b.minX, Y, b.maxZ + OFFSET];
    const southTo: [number, number, number] = [b.maxX, Y, b.maxZ + OFFSET];

    const eastFrom: [number, number, number] = [b.maxX + OFFSET, Y, b.minZ];
    const eastTo: [number, number, number] = [b.maxX + OFFSET, Y, b.maxZ];
    const eastMid: [number, number, number] = [b.maxX + OFFSET, Y, (b.minZ + b.maxZ) / 2];

    const westFrom: [number, number, number] = [b.minX - OFFSET, Y, b.minZ];
    const westTo: [number, number, number] = [b.minX - OFFSET, Y, b.maxZ];

    // Ceiling label at NE corner (exterior of the room).
    const ceilingLabelPos: [number, number, number] = [b.maxX + OFFSET + 0.3, Y, b.minZ - OFFSET - 0.3];

    return (
        <group>
            {/* Selection pill — independent of room measurements */}
            <SelectedAssetSizePill />

            {/* ─── Wall dimension lines ─── */}
            <Line points={[northFrom, northTo]} color="#475569" lineWidth={1.2} />
            <Line points={[southFrom, southTo]} color="#475569" lineWidth={1.2} />
            <Line points={[eastFrom, eastTo]} color="#475569" lineWidth={1.2} />
            <Line points={[westFrom, westTo]} color="#475569" lineWidth={1.2} />

            <Html position={northMid} center style={{ pointerEvents: "none" }}>
                <div className="rounded bg-slate-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    {widthLabel}
                </div>
            </Html>

            <Html position={eastMid} center style={{ pointerEvents: "none" }}>
                <div className="rounded bg-slate-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    {lengthLabel}
                </div>
            </Html>

            <Html position={ceilingLabelPos} center style={{ pointerEvents: "none" }}>
                <div className="rounded bg-indigo-700/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    Ceiling {ceiling}
                </div>
            </Html>

            {/* Selection-anchored wall clearances — measurements-mode only */}
            <SelectedAssetClearances />

            {/* Sqft badge — HTML fullscreen overlay, top-left */}
            <Html fullscreen prepend style={{ pointerEvents: "none" }}>
                <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-slate-900/85 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
                    {sqftLabel} ft²
                </div>
            </Html>
        </group>
    );
}

// ─────────────── Selection size pill (always-on when selected) ───────────────
function SelectedAssetSizePill() {
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
            <div className="rounded-full bg-[#531b7e] px-2 py-0.5 text-[10px] font-semibold text-white shadow-md">
                {label}
            </div>
        </Html>
    );
}

// ─────────────── Selected asset wall clearances (measurements-mode only) ───────────────
function SelectedAssetClearances() {
    const selectedId = useSelectedAssetId();
    const asset = useRoomStore((s) => s.assets.find((a) => a.id === selectedId) ?? null);
    const layout = useRoomStore((s) => s.layout);

    if (!asset) return null;

    const registry = getAsset(asset.assetId);
    if (!registry) return null;

    const { width, depth } = resolveDimensions(asset, registry);
    const b = roomBounds(layout);
    const Y = 0.02;

    // Wall distances (in meters). We assume rotation is cardinal for simple
    // AABB here, which matches standard layout tools.
    const distWest = (asset.position.x - width / 2) - b.minX;
    const distEast = b.maxX - (asset.position.x + width / 2);
    const distNorth = (asset.position.z - depth / 2) - b.minZ;
    const distSouth = b.maxZ - (asset.position.z + depth / 2);

    const westStart: [number, number, number] = [asset.position.x - width / 2, Y, asset.position.z];
    const westEnd: [number, number, number] = [b.minX, Y, asset.position.z];
    const westMid: [number, number, number] = [(asset.position.x - width / 2 + b.minX) / 2, Y, asset.position.z];

    const eastStart: [number, number, number] = [asset.position.x + width / 2, Y, asset.position.z];
    const eastEnd: [number, number, number] = [b.maxX, Y, asset.position.z];
    const eastMid: [number, number, number] = [(asset.position.x + width / 2 + b.maxX) / 2, Y, asset.position.z];

    const northStart: [number, number, number] = [asset.position.x, Y, asset.position.z - depth / 2];
    const northEnd: [number, number, number] = [asset.position.x, Y, b.minZ];
    const northMid: [number, number, number] = [asset.position.x, Y, (asset.position.z - depth / 2 + b.minZ) / 2];

    const southStart: [number, number, number] = [asset.position.x, Y, asset.position.z + depth / 2];
    const southEnd: [number, number, number] = [asset.position.x, Y, b.maxZ];
    const southMid: [number, number, number] = [asset.position.x, Y, (asset.position.z + depth / 2 + b.maxZ) / 2];

    const formatIn = (m: number) => `${Math.round(m * 39.3701)}in`;
    const lineColor = "#7c3aed"; // Violet-600

    return (
        <group>
            {distWest > 0.05 && (
                <group>
                    <Line points={[westStart, westEnd]} color={lineColor} lineWidth={1.5} />
                    <Html position={westMid} center style={{ pointerEvents: "none" }}>
                        <div className="rounded-sm border border-violet-100 bg-white px-1.5 py-0.5 text-[9px] font-bold text-violet-700 shadow-sm">
                            {formatIn(distWest)}
                        </div>
                    </Html>
                </group>
            )}
            {distEast > 0.05 && (
                <group>
                    <Line points={[eastStart, eastEnd]} color={lineColor} lineWidth={1.5} />
                    <Html position={eastMid} center style={{ pointerEvents: "none" }}>
                        <div className="rounded-sm border border-violet-100 bg-white px-1.5 py-0.5 text-[9px] font-bold text-violet-700 shadow-sm">
                            {formatIn(distEast)}
                        </div>
                    </Html>
                </group>
            )}
            {distNorth > 0.05 && (
                <group>
                    <Line points={[northStart, northEnd]} color={lineColor} lineWidth={1.5} />
                    <Html position={northMid} center style={{ pointerEvents: "none" }}>
                        <div className="rounded-sm border border-violet-100 bg-white px-1.5 py-0.5 text-[9px] font-bold text-violet-700 shadow-sm">
                            {formatIn(distNorth)}
                        </div>
                    </Html>
                </group>
            )}
            {distSouth > 0.05 && (
                <group>
                    <Line points={[southStart, southEnd]} color={lineColor} lineWidth={1.5} />
                    <Html position={southMid} center style={{ pointerEvents: "none" }}>
                        <div className="rounded-sm border border-violet-100 bg-white px-1.5 py-0.5 text-[9px] font-bold text-violet-700 shadow-sm">
                            {formatIn(distSouth)}
                        </div>
                    </Html>
                </group>
            )}
        </group>
    );
}
