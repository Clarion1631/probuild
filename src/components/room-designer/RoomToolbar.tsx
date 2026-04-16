// Top toolbar — undo/redo, 2D/3D toggle, manual save, export (Stage 4 stub).
// All wiring runs through the Zustand store so the toolbar stays pure.

import { useRoomStore } from "./hooks/useRoomStore";
import { toast } from "sonner";
import { exportToProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import { useState } from "react";

interface RoomToolbarProps {
    roomName: string;
}

export function RoomToolbar({ roomName }: RoomToolbarProps) {
    const viewMode = useRoomStore((s) => s.viewMode);
    const setViewMode = useRoomStore((s) => s.setViewMode);
    const undo = useRoomStore((s) => s.undo);
    const redo = useRoomStore((s) => s.redo);
    const past = useRoomStore((s) => s.past);
    const future = useRoomStore((s) => s.future);
    const dirty = useRoomStore((s) => s.dirty);
    const lastSavedAt = useRoomStore((s) => s.lastSavedAt);
    const getSnapshot = useRoomStore((s) => s.getSnapshot);
    const markSaved = useRoomStore((s) => s.markSaved);
    const roomId = useRoomStore((s) => s.roomId);

    const [saving, setSaving] = useState(false);

    async function saveNow() {
        if (!roomId) return;
        setSaving(true);
        try {
            const payload = exportToProBuild(getSnapshot());
            const res = await fetch(`/api/rooms/${roomId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error(`Save failed: ${res.status}`);
            markSaved();
            toast.success("Saved");
        } catch (err) {
            toast.error("Save failed");
            // eslint-disable-next-line no-console
            console.error(err);
        } finally {
            setSaving(false);
        }
    }

    const savedLabel = dirty
        ? "Unsaved changes"
        : lastSavedAt
            ? `Saved ${timeAgo(lastSavedAt)}`
            : "Saved";

    return (
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
            <div className="flex items-center gap-3">
                <h1 className="truncate text-sm font-semibold text-slate-900">{roomName}</h1>
                <span className={`text-xs ${dirty ? "text-amber-600" : "text-slate-400"}`}>{savedLabel}</span>
            </div>

            <div className="flex items-center gap-1">
                <button
                    onClick={undo}
                    disabled={past.length === 0}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs disabled:opacity-40"
                    title="Undo (Ctrl+Z)"
                >
                    ↶ Undo
                </button>
                <button
                    onClick={redo}
                    disabled={future.length === 0}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs disabled:opacity-40"
                    title="Redo (Ctrl+Y)"
                >
                    ↷ Redo
                </button>

                <div className="mx-2 h-5 w-px bg-slate-200" />

                <div className="flex overflow-hidden rounded-md border border-slate-200">
                    <button
                        onClick={() => setViewMode("2d")}
                        className={`px-3 py-1 text-xs font-medium transition ${
                            viewMode === "2d" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                    >
                        2D
                    </button>
                    <button
                        onClick={() => setViewMode("3d")}
                        className={`px-3 py-1 text-xs font-medium transition ${
                            viewMode === "3d" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                    >
                        3D
                    </button>
                </div>

                <div className="mx-2 h-5 w-px bg-slate-200" />

                <button
                    onClick={saveNow}
                    disabled={saving || !dirty}
                    className="hui-btn hui-btn-green px-3 py-1 text-xs disabled:opacity-50"
                >
                    {saving ? "Saving…" : "Save"}
                </button>
                <button
                    disabled
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs opacity-50"
                    title="Export coming in Stage 4"
                >
                    Export
                </button>
            </div>
        </div>
    );
}

function timeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}
