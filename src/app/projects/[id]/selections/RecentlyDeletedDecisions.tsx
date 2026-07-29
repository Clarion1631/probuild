"use client";

// Team-only 30-day restore tray for soft-deleted decisions.
// docs/specs/client-selections-playground.md Phase 1 — clients have full
// control of their own space and can delete ANY decision (Justin: "it's
// their playground"); nothing is destroyed, so the team gets a quiet
// restore window. Deletion is invisible on the client side — this tray
// exists ONLY here, never on the portal.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { restoreDecision } from "@/lib/actions";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";

interface DeletedDecision {
    id: string;
    name: string;
    area: string | null;
    deletedAt: string;
    candidates: { id: string }[];
}

function timeAgo(dateStr: string): string {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
    if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function RecentlyDeletedDecisions({
    initialDeleted,
}: {
    projectId: string;
    initialDeleted: DeletedDecision[];
}) {
    const router = useRouter();
    const [deleted, setDeleted] = useState<DeletedDecision[]>(initialDeleted);
    const [open, setOpen] = useState(false);
    const [restoringId, setRestoringId] = useState<string | null>(null);

    // initialDeleted is only the INITIAL value for useState — resync when the
    // server component re-fetches after router.refresh() (same fix
    // ClientSuggestions needed elsewhere in this feature).
    useEffect(() => {
        setDeleted(initialDeleted);
    }, [initialDeleted]);

    if (deleted.length === 0) return null;

    async function handleRestore(id: string, name: string) {
        setRestoringId(id);
        try {
            await restoreDecision(id);
            toast.success(`"${name}" restored`);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Couldn't restore that decision.");
        } finally {
            setRestoringId(null);
        }
    }

    return (
        <div className="hui-card mt-5 p-4">
            <button
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center justify-between text-left"
            >
                <div>
                    <span className="text-sm font-semibold text-hui-textMain flex items-center gap-1.5">
                        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        Recently deleted
                        <span className="text-xs font-normal text-hui-textMuted">({deleted.length})</span>
                    </span>
                    <p className="text-xs text-hui-textMuted mt-0.5 ml-5">Deleted decisions are kept for 30 days.</p>
                </div>
            </button>

            {open && (
                <div className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
                    {deleted.map((d) => (
                        <div key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-hui-textMain truncate">
                                    {d.name}
                                    {d.area && <span className="text-hui-textMuted font-normal"> · {d.area}</span>}
                                </p>
                                <p className="text-xs text-hui-textMuted mt-0.5">
                                    {d.candidates.length} candidate{d.candidates.length === 1 ? "" : "s"} · deleted {timeAgo(d.deletedAt)}
                                </p>
                            </div>
                            <button
                                onClick={() => handleRestore(d.id, d.name)}
                                disabled={restoringId === d.id}
                                className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                {restoringId === d.id ? "Restoring…" : "Restore"}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
