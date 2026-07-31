"use client";

import { useEffect, useState, type RefObject } from "react";
import { FloatingLayer } from "@/components/FloatingLayer";
import ColorWheel from "./ColorWheel";
import { PRESET_COLORS } from "./schedule-utils";

const RECENT_KEY = "probuild:scheduleRecentColors";
const RECENT_MAX = 6;

function normalizeHex(hex: string): string {
    return hex.trim().toLowerCase();
}

function getRecentColors(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(v => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)).slice(0, RECENT_MAX);
    } catch {
        return [];
    }
}

function pushRecentColor(hex: string) {
    if (typeof window === "undefined") return;
    const normalized = normalizeHex(hex);
    if (PRESET_COLORS.map(normalizeHex).includes(normalized)) return;
    const current = getRecentColors().map(normalizeHex);
    const next = [normalized, ...current.filter(c => c !== normalized)].slice(0, RECENT_MAX);
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* quota exceeded — ignore */ }
}

export type ColorPickerProps = {
    selected: string;
    onPick: (hex: string) => void;
    onClose: () => void;
    /** Trigger element the panel is anchored to. Every caller sits inside a scroll container, so the panel is portalled rather than absolutely positioned. */
    anchorRef: RefObject<HTMLElement | null>;
    align?: "left" | "right";
};

export default function ColorPicker({ selected, onPick, onClose, anchorRef, align = "left" }: ColorPickerProps) {
    const [recent, setRecent] = useState<string[]>([]);

    useEffect(() => { setRecent(getRecentColors()); }, []);

    // Escape and outside-pointerdown dismissal live in FloatingLayer.

    const selectedNorm = normalizeHex(selected);

    function handlePick(hex: string) {
        const normalized = normalizeHex(hex);
        onPick(normalized);
        pushRecentColor(normalized);
        setRecent(getRecentColors());
    }

    return (
        <FloatingLayer
            open
            anchorRef={anchorRef}
            onClose={onClose}
            align={align}
            className="min-w-[200px] bg-white border border-hui-border rounded-lg shadow-xl p-2.5 animate-in fade-in"
        >
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Presets</div>
            <div className="grid grid-cols-8 gap-1.5">
                {PRESET_COLORS.map(c => {
                    const isSelected = normalizeHex(c) === selectedNorm;
                    return (
                        <button
                            key={c}
                            type="button"
                            onClick={() => handlePick(c)}
                            className={`w-5 h-5 rounded-full transition hover:scale-110 ${isSelected ? "ring-2 ring-offset-1 ring-slate-700" : `ring-1 ${normalizeHex(c) === "#ffffff" ? "ring-slate-400" : "ring-slate-200"}`}`}
                            style={{ backgroundColor: c }}
                            title={c}
                        />
                    );
                })}
            </div>
            {recent.length > 0 && (
                <>
                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mt-2.5 mb-1.5">Recent</div>
                    <div className="grid grid-cols-8 gap-1.5">
                        {recent.map(c => {
                            const isSelected = normalizeHex(c) === selectedNorm;
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => handlePick(c)}
                                    className={`w-5 h-5 rounded-full transition hover:scale-110 ${isSelected ? "ring-2 ring-offset-1 ring-slate-700" : `ring-1 ${normalizeHex(c) === "#ffffff" ? "ring-slate-400" : "ring-slate-200"}`}`}
                                    style={{ backgroundColor: c }}
                                    title={c}
                                />
                            );
                        })}
                    </div>
                </>
            )}
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mt-2.5 mb-1.5">Custom</div>
            <ColorWheel value={selected.startsWith("#") ? selected : "#4c9a2a"} onCommit={handlePick} />
            <button
                type="button"
                onClick={onClose}
                className="w-full mt-2.5 py-1.5 text-[11px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded transition"
            >
                Done
            </button>
        </FloatingLayer>
    );
}
