"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { portalCreateMoodBoard } from "@/lib/actions";

export default function PortalStartMoodBoardButton({ projectId }: { projectId: string }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);

    const handleCreate = async () => {
        const trimmed = title.trim();
        if (!trimmed) {
            toast.error("Give your board a title first");
            return;
        }
        setCreating(true);
        try {
            const board = await portalCreateMoodBoard(projectId, trimmed);
            toast.success("Board created!");
            router.push(`/portal/projects/${projectId}/mood-boards/${board.id}`);
        } catch (e: any) {
            toast.error(e.message || "Failed to create board");
        } finally {
            setCreating(false);
        }
    };

    if (!open) {
        return (
            <button onClick={() => setOpen(true)} className="hui-btn hui-btn-primary flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Start a board
            </button>
        );
    }

    return (
        <div className="hui-card p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <input
                autoFocus
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setOpen(false); }}
                placeholder="Board title (e.g. Kitchen Ideas)"
                maxLength={120}
                className="hui-input"
            />
            <div className="flex items-center gap-2 shrink-0">
                <button onClick={handleCreate} disabled={creating} className="hui-btn hui-btn-primary text-sm">
                    {creating ? "Creating..." : "Create"}
                </button>
                <button onClick={() => { setOpen(false); setTitle(""); }} className="hui-btn hui-btn-secondary text-sm">
                    Cancel
                </button>
            </div>
        </div>
    );
}
