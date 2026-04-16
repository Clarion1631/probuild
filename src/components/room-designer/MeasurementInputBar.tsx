// Stage 3: bottom measurement input bar. Visible only when exactly one asset
// is selected. X / Y / Z input feet-inches, Rot inputs degrees. Enter commits;
// Tab/Shift+Tab cycles. Uses the shared parseFeetInches from units.ts.

import { useState, useEffect } from "react";
import { useRoomStore, useSelectedAssetId } from "./hooks/useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";
import {
    M_TO_IN,
    IN_TO_M,
    fmtInches,
    radToDeg,
    degToRad,
    parseFeetInches,
} from "@/lib/room-designer/units";

export function MeasurementInputBar() {
    const id = useSelectedAssetId();
    const selectionCount = useRoomStore((s) => s.selectedAssetIds.length);
    const assets = useRoomStore((s) => s.assets);
    const updateAsset = useRoomStore((s) => s.updateAsset);

    const asset = id ? assets.find((a) => a.id === id) ?? null : null;
    // Hide for multi-select — the alignment toolbar drives N-asset operations.
    if (!asset || selectionCount !== 1) return null;

    const locked = isLocked(asset);

    const commit = (axis: "x" | "y" | "z", input: string) => {
        const meters = parseFeetInches(input);
        if (meters === null) return;
        updateAsset(asset.id, {
            position: { ...asset.position, [axis]: meters },
        });
    };

    const commitRot = (input: string) => {
        const deg = parseFloat(input);
        if (!Number.isFinite(deg)) return;
        updateAsset(asset.id, { rotationY: degToRad(deg) });
    };

    return (
        <div
            className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-slate-200 bg-white/95 px-2 py-1.5 shadow-md backdrop-blur"
        >
            <DimField
                label="X"
                value={asset.position.x}
                disabled={locked}
                onCommit={(v) => commit("x", v)}
            />
            <DimField
                label="Y"
                value={asset.position.y}
                disabled={locked}
                onCommit={(v) => commit("y", v)}
            />
            <DimField
                label="Z"
                value={asset.position.z}
                disabled={locked}
                onCommit={(v) => commit("z", v)}
            />
            <RotField
                value={asset.rotationY}
                disabled={locked}
                onCommit={commitRot}
            />
            {locked && <span className="text-[10px] text-amber-700">Locked</span>}
        </div>
    );
}

interface DimFieldProps {
    label: string;
    value: number; // meters
    disabled?: boolean;
    onCommit: (raw: string) => void;
}

function DimField({ label, value, disabled, onCommit }: DimFieldProps) {
    const [draft, setDraft] = useState("");
    const [focused, setFocused] = useState(false);

    // Reflect external changes (arrow nudges, gizmo commits) into the field
    // when not actively editing.
    useEffect(() => {
        if (!focused) setDraft(fmtInches(value));
    }, [value, focused]);

    const display = focused ? draft : fmtInches(value);

    return (
        <label className="flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-xs focus-within:border-slate-400">
            <span className="text-slate-500">{label}</span>
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
                className="w-16 bg-transparent text-right outline-none disabled:opacity-50"
            />
        </label>
    );
}

interface RotFieldProps {
    value: number; // radians
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
        <label className="flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-xs focus-within:border-slate-400">
            <span className="text-slate-500">Rot°</span>
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
                className="w-14 bg-transparent text-right outline-none disabled:opacity-50"
            />
        </label>
    );
}

// Silence lint when IN_TO_M isn't directly used (kept in import so the shared
// module stays the one import site if future consumers need it).
void IN_TO_M;
