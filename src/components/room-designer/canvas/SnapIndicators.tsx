// Stage 3: render the snap-line metadata produced by useAssetPlacement.
// Mounted inside PlacementLayer during drag. Uses drei's <Line>.
//
// Colors:
//   - grid:  blue  #3b82f6 (dashed, faint)
//   - edge:  orange #f97316 (solid)
//   - wall:  green  #22c55e (solid)
//
// Also renders a small Html badge with the nearest-wall clearance.

import { Line, Html } from "@react-three/drei";
import type { GhostPose } from "./AssetGhost";
import { fmtInches } from "@/lib/room-designer/units";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

const COLOR: Record<string, string> = {
    grid: "#3b82f6",
    edge: "#f97316",
    wall: "#22c55e",
};

interface Props {
    pose: GhostPose;
}

export function SnapIndicators({ pose }: Props) {
    const lines = pose.snapLines ?? [];
    const distance = pose.nearestWallDistance;

    return (
        <group>
            {lines.map((line, i) => (
                <Line
                    key={i}
                    points={[line.from, line.to]}
                    color={COLOR[line.kind] ?? "#94a3b8"}
                    lineWidth={line.kind === "grid" ? 1 : 1.8}
                    dashed={line.kind === "grid"}
                    dashSize={0.05}
                    gapSize={0.05}
                    transparent
                    opacity={line.kind === "grid" ? 0.55 : 0.9}
                />
            ))}
            {distance !== null && distance !== undefined && (
                <Html
                    position={[pose.x + 0.25, 0.1, pose.z + 0.25]}
                    style={{ pointerEvents: "none" }}
                    center
                >
                    <div className="rounded bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {fmtInches(distance)}
                    </div>
                </Html>
            )}
        </group>
    );
}

export function TransformSnapIndicators() {
    const lines = useRoomStore((s) => s.transformSnapLines);
    if (lines.length === 0) return null;

    return (
        <group>
            {lines.map((line, i) => (
                <Line
                    key={i}
                    points={[line.from, line.to]}
                    color={COLOR[line.kind] ?? "#94a3b8"}
                    lineWidth={1.8}
                    transparent
                    opacity={0.9}
                />
            ))}
        </group>
    );
}
