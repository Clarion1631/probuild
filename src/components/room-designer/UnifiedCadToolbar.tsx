import { useState, useEffect, useMemo } from "react";
import { useRoomStore, useSelectedAssetId } from "./hooks/useRoomStore";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import { isLocked } from "@/lib/room-designer/asset-view";
import {
    M_TO_IN,
    IN_TO_M,
    fmtInches,
    radToDeg,
    degToRad,
    parseFeetInches,
} from "@/lib/room-designer/units";
import type { CameraPreset, PlacedAsset } from "./types";
import { 
    Maximize2, 
    Layers, 
    Settings, 
    AlignLeft, 
    AlignCenter, 
    AlignRight, 
    AlignStartVertical, 
    AlignEndVertical, 
    Grid3X3,
    Lock,
    Compass
} from "lucide-react";

// Camera Presets config
interface PresetBtn {
    key: CameraPreset | "fit";
    label: string;
    title: string;
}

const PRESETS: PresetBtn[] = [
    { key: "fit", label: "Fit", title: "Fit room to view" },
    { key: "top", label: "Top", title: "Top (plan) view" },
    { key: "front", label: "Front", title: "Front elevation" },
    { key: "right", label: "Side", title: "Right-side elevation" },
    { key: "iso", label: "3D", title: "3D perspective" },
];

// Alignment computation structures
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

export function UnifiedCadToolbar() {
    const selectedAssetId = useSelectedAssetId();
    const selectionCount = useRoomStore((s) => s.selectedAssetIds.length);
    const selectedIds = useRoomStore((s) => s.selectedAssetIds);
    const assets = useRoomStore((s) => s.assets);
    const updateAsset = useRoomStore((s) => s.updateAsset);
    const updateAssets = useRoomStore((s) => s.updateAssets);
    
    // Sidebar drawer states
    const showLayers = useRoomStore((s) => s.showLayers);
    const setShowLayers = useRoomStore((s) => s.setShowLayers);
    const showProperties = useRoomStore((s) => s.showProperties);
    const setShowProperties = useRoomStore((s) => s.setShowProperties);

    // Camera preset states
    const currentPreset = useRoomStore((s) => s.cameraPreset);
    const setCameraPreset = useRoomStore((s) => s.setCameraPreset);
    const viewMode = useRoomStore((s) => s.viewMode);

    const asset = selectedAssetId ? assets.find((a) => a.id === selectedAssetId) ?? null : null;
    const locked = asset ? isLocked(asset) : false;

    // Precompute alignment candidates
    const candidates = useMemo(() => {
        const selectedSet = new Set(selectedIds);
        const picked = assets.filter((a) => selectedSet.has(a.id));
        return computeCandidates(picked);
    }, [assets, selectedIds]);

    // Handle camera preset trigger
    const onPresetClick = (key: PresetBtn["key"]) => {
        if (key === "fit") {
            const target: CameraPreset = viewMode === "2d" ? "top" : "iso";
            setCameraPreset("orbit");
            setTimeout(() => setCameraPreset(target), 0);
            return;
        }
        setCameraPreset(key);
    };

    // Commit single-asset updates
    const commitPosition = (axis: "x" | "y" | "z", input: string) => {
        if (!asset) return;
        const meters = parseFeetInches(input);
        if (meters === null) return;
        updateAsset(asset.id, {
            position: { ...asset.position, [axis]: meters },
        });
    };

    const commitRotation = (input: string) => {
        if (!asset) return;
        const deg = parseFloat(input);
        if (!Number.isFinite(deg)) return;
        updateAsset(asset.id, { rotationY: degToRad(deg) });
    };

    // Apply alignment
    const applyAlign = (axis: AlignAxis) => updateAssets(alignPatches(candidates, axis));
    const applyDistribute = (axis: DistributeAxis) => {
        const patches = distributePatches(candidates, axis);
        if (patches.length > 0) updateAssets(patches);
    };

    return (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-slate-200 bg-white/95 px-3 py-2.5 shadow-md backdrop-blur transition-all">
            
            {/* Drawer Shortcut Toggles */}
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    title="Toggle Layers sidebar (L)"
                    onClick={() => setShowLayers(!showLayers)}
                    className={`rounded p-1.5 transition ${showLayers ? "bg-slate-100 text-blue-600" : "text-slate-500 hover:bg-slate-50"}`}
                >
                    <Layers className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    title="Toggle Properties sidebar (P)"
                    onClick={() => setShowProperties(!showProperties)}
                    className={`rounded p-1.5 transition ${showProperties ? "bg-slate-100 text-blue-600" : "text-slate-500 hover:bg-slate-50"}`}
                >
                    <Settings className="h-4 w-4" />
                </button>
            </div>

            <Divider />

            {/* Section 1: Camera Presets (Always Visible) */}
            <div className="flex items-center gap-0.5">
                {PRESETS.map((p) => {
                    const active = p.key !== "fit" && currentPreset === p.key;
                    return (
                        <button
                            key={p.key}
                            type="button"
                            title={p.title}
                            onClick={() => onPresetClick(p.key)}
                            className={
                                "rounded px-2.5 py-1 text-xs font-semibold transition " +
                                (active
                                    ? "bg-slate-900 text-white shadow-sm"
                                    : "bg-transparent text-slate-600 hover:bg-slate-100")
                            }
                        >
                            {p.key === "fit" ? (
                                <span className="flex items-center gap-1"><Maximize2 className="h-3 w-3" /> Fit</span>
                            ) : p.label}
                        </button>
                    );
                })}
            </div>

            {/* Section 2: Single Selection Dimensional Inputs (Visible only when selectionCount === 1) */}
            {selectionCount === 1 && asset && (
                <>
                    <Divider />
                    <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
                        <DimField
                            label="X"
                            value={asset.position.x}
                            disabled={locked}
                            onCommit={(v) => commitPosition("x", v)}
                        />
                        <DimField
                            label="Y"
                            value={asset.position.y}
                            disabled={locked}
                            onCommit={(v) => commitPosition("y", v)}
                        />
                        <DimField
                            label="Z"
                            value={asset.position.z}
                            disabled={locked}
                            onCommit={(v) => commitPosition("z", v)}
                        />
                        <RotField
                            value={asset.rotationY}
                            disabled={locked}
                            onCommit={commitRotation}
                        />
                        {locked && (
                            <span className="flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                <Lock className="h-2.5 w-2.5" /> Locked
                            </span>
                        )}
                    </div>
                </>
            )}

            {/* Section 3: Multi-Selection Alignment Toolbar (Visible only when selectionCount >= 2) */}
            {selectionCount >= 2 && (
                <>
                    <Divider />
                    <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-150 text-xs">
                        <div className="flex items-center gap-0.5">
                            <Btn title="Align Left" onClick={() => applyAlign("left")}><AlignLeft className="h-3.5 w-3.5" /></Btn>
                            <Btn title="Center Horizontally" onClick={() => applyAlign("centerX")}><AlignCenter className="h-3.5 w-3.5 rotate-90" /></Btn>
                            <Btn title="Align Right" onClick={() => applyAlign("right")}><AlignRight className="h-3.5 w-3.5" /></Btn>
                        </div>
                        <div className="h-3 w-px bg-slate-200" />
                        <div className="flex items-center gap-0.5">
                            <Btn title="Align Top" onClick={() => applyAlign("top")}><AlignStartVertical className="h-3.5 w-3.5" /></Btn>
                            <Btn title="Center Vertically" onClick={() => applyAlign("middle")}><AlignCenter className="h-3.5 w-3.5" /></Btn>
                            <Btn title="Align Bottom" onClick={() => applyAlign("bottom")}><AlignEndVertical className="h-3.5 w-3.5" /></Btn>
                        </div>
                        <div className="h-3 w-px bg-slate-200" />
                        <div className="flex items-center gap-0.5">
                            <Btn
                                title="Distribute Horizontally (needs 3+)"
                                disabled={selectedIds.length < 3}
                                onClick={() => applyDistribute("h")}
                                className="px-1.5 text-[10px]"
                            >
                                ⇔ H
                            </Btn>
                            <Btn
                                title="Distribute Vertically (needs 3+)"
                                disabled={selectedIds.length < 3}
                                onClick={() => applyDistribute("v")}
                                className="px-1.5 text-[10px]"
                            >
                                ⇕ V
                            </Btn>
                        </div>
                        <div className="h-3 w-px bg-slate-200" />
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                            {selectedIds.length} Selected
                        </span>
                    </div>
                </>
            )}

        </div>
    );
}

function Divider() {
    return <div className="h-5 w-px bg-slate-200" />;
}

// Compact DimField implementation
interface DimFieldProps {
    label: string;
    value: number;
    disabled?: boolean;
    onCommit: (raw: string) => void;
}

function DimField({ label, value, disabled, onCommit }: DimFieldProps) {
    const [draft, setDraft] = useState("");
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!focused) setDraft(fmtInches(value));
    }, [value, focused]);

    const display = focused ? draft : fmtInches(value);

    return (
        <label className="flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] focus-within:border-slate-400 focus-within:bg-white transition-all">
            <span className="font-semibold text-slate-400">{label}</span>
            <input
                type="text"
                disabled={disabled}
                value={display}
                onFocus={() => {
                    setFocused(true);
                    setDraft(String(Math.round(value * M_TO_IN)));
                }}
                onBlur={() => {
                    setFocused(false);
                    if (draft.trim().length > 0) onCommit(draft);
                }}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        onCommit(draft);
                        (e.currentTarget as HTMLInputElement).blur();
                    }
                }}
                className="w-12 bg-transparent text-right font-medium text-slate-800 outline-none disabled:opacity-50"
            />
        </label>
    );
}

// Compact RotField implementation
interface RotFieldProps {
    value: number;
    disabled?: boolean;
    onCommit: (raw: string) => void;
}

function RotField({ value, disabled, onCommit }: RotFieldProps) {
    const [draft, setDraft] = useState("");
    const [focused, setFocused] = useState(false);
    const degStr = String(Math.round(radToDeg(value)));

    useEffect(() => {
        if (!focused) setDraft(degStr);
    }, [degStr, focused]);

    return (
        <label className="flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] focus-within:border-slate-400 focus-within:bg-white transition-all">
            <span className="font-semibold text-slate-400">Rot°</span>
            <input
                type="number"
                disabled={disabled}
                value={focused ? draft : degStr}
                onFocus={() => { setFocused(true); setDraft(degStr); }}
                onBlur={() => { setFocused(false); if (draft.length > 0) onCommit(draft); }}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        onCommit(draft);
                        (e.currentTarget as HTMLInputElement).blur();
                    }
                }}
                step={5}
                className="w-10 bg-transparent text-right font-medium text-slate-800 outline-none disabled:opacity-50"
            />
        </label>
    );
}

// Icon helper button
function Btn({
    title, onClick, disabled, children, className = ""
}: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
            onClick={onClick}
            className={`rounded p-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
        >
            {children}
        </button>
    );
}
