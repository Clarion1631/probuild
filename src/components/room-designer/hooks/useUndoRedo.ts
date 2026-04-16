// Keyboard wiring for undo/redo. The undo/redo state machine itself lives on
// the Zustand store (useRoomStore) — this hook just binds Ctrl+Z / Ctrl+Y /
// Ctrl+Shift+Z to it.

import { useEffect } from "react";
import { useRoomStore } from "./useRoomStore";

export function useUndoRedoKeyboard(enabled: boolean = true) {
    const undo = useRoomStore((s) => s.undo);
    const redo = useRoomStore((s) => s.redo);

    useEffect(() => {
        if (!enabled) return;
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
            if (!(e.ctrlKey || e.metaKey)) return;

            const k = e.key.toLowerCase();
            if (k === "z" && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if ((k === "z" && e.shiftKey) || k === "y") {
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [enabled, undo, redo]);
}
