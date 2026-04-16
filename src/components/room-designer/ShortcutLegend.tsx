"use client";

// `?` modal — 2-column keyboard shortcut reference. Reads from the single
// source-of-truth list in `src/lib/room-designer/shortcuts.ts`.
//
// Dismiss paths: Esc, backdrop click, X button. Matches the "centered fixed
// modal" pattern from RoomList's new-room form.

import { useEffect } from "react";
import { useRoomStore } from "./hooks/useRoomStore";
import { SHORTCUTS } from "@/lib/room-designer/shortcuts";

export function ShortcutLegend() {
    const open = useRoomStore((s) => s.shortcutLegendOpen);
    const close = useRoomStore((s) => s.closeShortcutLegend);

    // Escape to dismiss.
    useEffect(() => {
        if (!open) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") {
                e.stopPropagation();
                close();
            }
        }
        // Capture phase so we beat useAssetSelection's Escape handler — the
        // user's mental model is "Esc closes the topmost thing" and the
        // legend is always topmost when open.
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, [open, close]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={close}
        >
            <div
                className="hui-card w-full max-w-xl p-6"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label="Keyboard shortcuts"
            >
                <div className="mb-4 flex items-start justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-900">Keyboard Shortcuts</h2>
                        <p className="text-xs text-slate-500">Press Esc to close</p>
                    </div>
                    <button
                        type="button"
                        onClick={close}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                    {SHORTCUTS.map((s, i) => (
                        <div key={`${s.key}-${i}`} className="contents">
                            {s.group && (
                                <div className="col-span-2 mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                                    {s.group}
                                </div>
                            )}
                            <div className="flex items-center gap-2">
                                <kbd className="inline-flex min-w-[2rem] items-center justify-center rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 shadow-sm">
                                    {s.key}
                                </kbd>
                            </div>
                            <div className="text-sm text-slate-700">{s.desc}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
