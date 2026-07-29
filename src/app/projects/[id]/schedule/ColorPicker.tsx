"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { FloatingPopover } from "@/app/company-dashboard/schedule-board/FloatingPopover";
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

// 8 swatches of w-5 (20px) with gap-1.5 (6px) plus the popover's own p-3:
// 8*20 + 7*6 + 2*12 = 226. Rounded up so a swatch row never wraps.
const PANEL_WIDTH_PX = 232;

export type ColorPickerProps = {
    open: boolean;
    /** The swatch button the panel opens from. */
    anchorRef: RefObject<HTMLElement | null>;
    selected: string;
    onPick: (hex: string) => void;
    onClose: () => void;
};

export default function ColorPicker({ open, anchorRef, selected, onPick, onClose }: ColorPickerProps) {
    const [recent, setRecent] = useState<string[]>([]);
    const colorInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setRecent(getRecentColors()); }, []);

    const selectedNorm = normalizeHex(selected);

    function handlePick(hex: string) {
        const normalized = normalizeHex(hex);
        onPick(normalized);
        pushRecentColor(normalized);
        setRecent(getRecentColors());
    }

    function handleCustomInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        handlePick(e.target.value);
    }

    return (
        <FloatingPopover
            open={open}
            anchorRef={anchorRef}
            onClose={onClose}
            width={PANEL_WIDTH_PX}
            align="left"
            dismissible={false}
        >
            {/* React portals still bubble events through the React tree, so a
                swatch click would reach the task row's onClick (select/link
                mode) without this — the DOM move to document.body does not
                stop it. */}
            <div onClick={e => e.stopPropagation()}>
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
            <button
                type="button"
                onClick={() => colorInputRef.current?.click()}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 rounded border border-dashed border-slate-300 transition"
            >
                <span className="w-5 h-5 rounded-full border border-slate-300 flex items-center justify-center text-slate-400 text-sm leading-none">+</span>
                <span>Pick a color…</span>
            </button>
            <input
                ref={colorInputRef}
                type="color"
                value={selected.startsWith("#") ? selected : "#4c9a2a"}
                onChange={handleCustomInputChange}
                className="sr-only"
                aria-label="Custom color"
                tabIndex={-1}
            />
            <button
                type="button"
                onClick={onClose}
                className="w-full mt-2.5 py-1.5 text-[11px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded transition"
            >
                Done
            </button>
            </div>
        </FloatingPopover>
    );
}
