// Autosave for the Room Designer.
//
// Three rules:
//   1. Debounce 30 s after the last mutation (dirty flag).
//   2. Never save while `isDragging` is true — avoids writing mid-drag state.
//   3. On `visibilitychange` (hidden) OR `beforeunload`, flush a final save
//      using `fetch(..., { keepalive: true })`. Without this, closing the tab
//      within the debounce window silently loses work. keepalive allows the
//      browser to finish the request after the document is gone.

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { exportToProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import { useRoomStore } from "./useRoomStore";

const DEBOUNCE_MS = 30_000;

export function useRoomSave(roomId: string) {
    const dirty = useRoomStore((s) => s.dirty);
    const isDragging = useRoomStore((s) => s.isDragging);
    const getSnapshot = useRoomStore((s) => s.getSnapshot);
    const markSaved = useRoomStore((s) => s.markSaved);

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inflightRef = useRef<boolean>(false);

    // Debounced save while the tab is alive.
    useEffect(() => {
        if (!roomId) return;
        if (!dirty) return;
        if (isDragging) return;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(async () => {
            if (inflightRef.current) return;
            inflightRef.current = true;
            try {
                const snap = getSnapshot();
                const payload = exportToProBuild(snap);
                const res = await fetch(`/api/rooms/${roomId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) throw new Error(`PUT /api/rooms/${roomId} returned ${res.status}`);
                markSaved();
            } catch (err) {
                toast.error("Couldn't autosave room — retrying on next edit");
                // Leave `dirty=true` so another save attempt fires on the next mutation.
                // eslint-disable-next-line no-console
                console.error("Room autosave failed:", err);
            } finally {
                inflightRef.current = false;
            }
        }, DEBOUNCE_MS);

        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [roomId, dirty, isDragging, getSnapshot, markSaved]);

    // Tab-close / hide flush. Uses keepalive so the request survives document unload.
    useEffect(() => {
        if (!roomId) return;

        const flush = () => {
            const s = useRoomStore.getState();
            if (!s.dirty) return;
            try {
                const payload = exportToProBuild(s.getSnapshot());
                const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
                // keepalive lets the browser finish this PUT after unload.
                fetch(`/api/rooms/${roomId}`, {
                    method: "PUT",
                    body: blob,
                    keepalive: true,
                    headers: { "Content-Type": "application/json" },
                }).catch(() => {
                    // swallow — page is unloading, nothing to report.
                });
            } catch {
                // nothing we can surface at this point.
            }
        };

        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("beforeunload", flush);
        return () => {
            window.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("beforeunload", flush);
        };
    }, [roomId]);
}
