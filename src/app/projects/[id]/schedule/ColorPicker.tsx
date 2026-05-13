"use client";

import { useEffect, useRef, useState } from "react";
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
    className?: string;
};

export default function ColorPicker({ selected, onPick, onClose, className }: ColorPickerProps) {
    const [recent, setRecent] = useState<string[]>([]);
    const colorInputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => { setRecent(getRecentColors()); }, []);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
        }
        function handleEsc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEsc);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEsc);
        };
    }, [onClose]);

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
        <div
            ref={containerRef}
            className={`bg-white border border-hui-border rounded-lg shadow-xl p-2.5 animate-in fade-in ${className ?? ""}`}
            onClick={e => e.stopPropagation()}
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
        </div>
    );
}
