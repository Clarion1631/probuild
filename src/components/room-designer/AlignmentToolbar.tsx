// Stage 3: alignment / distribute toolbar for multi-select.
// Visible when >= 2 assets are selected. All operations call updateAssets()
// once so Ctrl+Z reverts the whole alignment in one step.

import { useMemo } from "react";
import { useRoomStore } from "./hooks/useRoomStore";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import { isLocked } from "@/lib/room-designer/asset-view";
import type { PlacedAsset } from "./types";

interface AlignCandidate {
    asset: PlacedAsset;
    minX: number; maxX: number; cx: number;
    minZ: number; maxZ: number; cz: number;
    width: number; depth: number;
}

function computeCandidates(assets: PlacedAsset[]): AlignCandidate[] {
    const out: AlignCandidate[] = [];
    for (const a of assets) {
        if (isLocked(a)) continue;
        const reg = getAsset(a.assetId);
        if (!reg) continue;
        const { width, depth } = resolveDimensions(a, reg);
        const cx = a.position.x;
        const cz = a.position.z;
        out.push({
            asset: a,
            minX: cx - width / 2, maxX: cx + width / 2, cx,
            minZ: cz - depth / 2, maxZ: cz + depth / 2, cz,
            width, depth,
        });
    }
    return out;
}

type AlignAxis = "left" | "centerX" | "right" | "top" | "middle" | "bottom";
type DistributeAxis = "h" | "v";

function alignPatches(cands: AlignCandidate[], axis: AlignAxis) {
    if (cands.length < 2) return [];
    switch (axis) {
        case "left": {
            const target = Math.min(...cands.map((c) => c.minX));
            return cands.map((c) => ({
                id: c.asset.id,
                patch: { position: { ...c.asset.position, x: target + c.width / 2 } },
            }));
        }
        case "right": {
            const target = Math.max(...cands.map((c) => c.maxX));
            return cands.map((c) => ({
                id: c.asset.id,
                patch: { position: { ...c.asset.position, x: target - c.width / 2 } },
            }));
        }
        case "centerX": {
            const center = (Math.min(...cands.map((c) => c.minX)) + Math.max(...cands.map((c) => c.maxX))) / 2;
            return cands.map((c) => ({
                id: c.asset.id,
                patch: { position: { ...c.asset.position, x: center } },
            }));
        }
        case "top": {
            const target = Math.min(...cands.map((c) => c.minZ));
            return cands.map((c) => ({
                id: c.asset.id,
                patch: { position: { ...c.asset.position, z: target + c.depth / 2 } },
            }));
        }
        case "bottom": {
            const target = Math.max(...cands.map((c) => c.maxZ));
            return cands.map((c) => ({
                id: c.asset.id,
                patch: { position: { ...c.asset.position, z: target - c.depth / 2 } },
            }));
        }
        case "middle": {
            const center = (Math.min(...cands.map((c) => c.minZ)) + Math.max(...cands.map((c) => c.maxZ))) / 2;
            return cands.map((c) => ({
                id: c.asset.id,
                patch: { position: { ...c.asset.position, z: center } },
            }));
        }
    }
}

function distributePatches(cands: AlignCandidate[], axis: DistributeAxis) {
    if (cands.length < 3) return [];
    if (axis === "h") {
        const sorted = [...cands].sort((a, b) => a.cx - b.cx);
        const first = sorted[0].cx;
        const last = sorted[sorted.length - 1].cx;
        const step = (last - first) / (sorted.length - 1);
        return sorted.slice(1, -1).map((c, i) => ({
            id: c.asset.id,
            patch: { position: { ...c.asset.position, x: first + step * (i + 1) } },
        }));
    }
    const sorted = [...cands].sort((a, b) => a.cz - b.cz);
    const first = sorted[0].cz;
    const last = sorted[sorted.length - 1].cz;
    const step = (last - first) / (sorted.length - 1);
    return sorted.slice(1, -1).map((c, i) => ({
        id: c.asset.id,
        patch: { position: { ...c.asset.position, z: first + step * (i + 1) } },
    }));
}

export function AlignmentToolbar() {
    const selectedIds = useRoomStore((s) => s.selectedAssetIds);
    const assets = useRoomStore((s) => s.assets);
    const updateAssets = useRoomStore((s) => s.updateAssets);

    const candidates = useMemo(() => {
        const selectedSet = new Set(selectedIds);
        const picked = assets.filter((a) => selectedSet.has(a.id));
        return computeCandidates(picked);
    }, [assets, selectedIds]);

    if (selectedIds.length < 2) return null;

    const apply = (axis: AlignAxis) => updateAssets(alignPatches(candidates, axis));
    const distribute = (axis: DistributeAxis) => {
        const patches = distributePatches(candidates, axis);
        if (patches.length > 0) updateAssets(patches);
    };

    return (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-slate-200 bg-white/95 p-1 shadow-md backdrop-blur">
            <div className="flex items-center gap-1 text-xs">
                <Group label="Align X">
                    <Btn title="Align Left" onClick={() => apply("left")}>L</Btn>
                    <Btn title="Center horizontally" onClick={() => apply("centerX")}>C</Btn>
                    <Btn title="Align Right" onClick={() => apply("right")}>R</Btn>
                </Group>
                <Divider />
                <Group label="Align Z">
                    <Btn title="Align Top (min Z)" onClick={() => apply("top")}>T</Btn>
                    <Btn title="Center vertically" onClick={() => apply("middle")}>M</Btn>
                    <Btn title="Align Bottom (max Z)" onClick={() => apply("bottom")}>B</Btn>
                </Group>
                <Divider />
                <Group label="Distribute">
                    <Btn
                        title="Distribute horizontally (needs 3+)"
                        disabled={selectedIds.length < 3}
                        onClick={() => distribute("h")}
                    >
                        ⇔ H
                    </Btn>
                    <Btn
                        title="Distribute vertically (needs 3+)"
                        disabled={selectedIds.length < 3}
                        onClick={() => distribute("v")}
                    >
                        ⇕ V
                    </Btn>
                </Group>
                <Divider />
                <span className="px-2 text-[11px] text-slate-500">{selectedIds.length} selected</span>
            </div>
        </div>
    );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-0.5" aria-label={label}>
            {children}
        </div>
    );
}

function Divider() {
    return <div className="mx-1 h-5 w-px bg-slate-200" />;
}

function Btn({
    title, onClick, disabled, children,
}: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
            onClick={onClick}
            className="rounded px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
            {children}
        </button>
    );
}
