"use client";

// Review-before-apply modal for the "Sort with AI" button
// (docs/superpowers/plans/2026-07-30-selection-ai-sort.md). Nothing moves
// until Apply is clicked — Cancel just closes; the suggestions the route
// already persisted remain as chips on the Unsorted cards, which is the
// intended behavior.

import { useState } from "react";
import { toast } from "sonner";
import { applySuggestedDecision } from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { ImageOff, Sparkles } from "lucide-react";

export type AiSortSuggestionRow = {
    itemId: string;
    name: string;
    imageUrl: string | null;
    decisionId: string | null;
    decisionName: string | null;
    confidence: "high" | "medium" | "low";
    reason: string;
};

const CONFIDENCE_STYLES: Record<string, string> = {
    high: "bg-green-100 text-green-700",
    medium: "bg-amber-100 text-amber-700",
    low: "bg-slate-100 text-slate-600",
};

const LEAVE_UNSORTED = "";

export default function AiSortReviewModal({
    open,
    rows,
    decisions,
    onClose,
    onApplied,
}: {
    open: boolean;
    rows: AiSortSuggestionRow[];
    decisions: { id: string; name: string }[];
    onClose: () => void;
    onApplied: () => void;
}) {
    const [selections, setSelections] = useState<Record<string, string>>({});
    const [applying, setApplying] = useState(false);
    // Tracks which `rows` array the current `selections` were seeded from —
    // React's documented pattern for "adjusting state when a prop changes"
    // (https://react.dev/learn/you-might-not-need-an-effect), which avoids
    // the extra render + cascading-update a useEffect-based reset would
    // cause. Re-seeds to each row's suggested decision (or "Leave unsorted"
    // when the suggestion was null) whenever a fresh set of rows arrives.
    const [seededRows, setSeededRows] = useState(rows);
    if (rows !== seededRows) {
        setSeededRows(rows);
        setSelections(Object.fromEntries(rows.map((r) => [r.itemId, r.decisionId ?? LEAVE_UNSORTED])));
    }

    if (!open) return null;

    function handleClose() {
        if (applying) return;
        onClose();
    }

    async function handleApply() {
        setApplying(true);
        let applied = 0;
        let skipped = 0;
        let failed = 0;

        // Sequential, not Promise.all — each row is its own CAS write and the
        // plan calls for skipped/failed rows to toast and continue, not abort
        // the batch.
        for (const row of rows) {
            const decisionId = selections[row.itemId];
            if (!decisionId) continue; // deselected to "Leave unsorted"
            try {
                const result = await applySuggestedDecision(row.itemId, decisionId);
                if (result.applied) applied += 1;
                else skipped += 1;
            } catch {
                failed += 1;
            }
        }

        setApplying(false);

        if (applied === 0 && skipped === 0 && failed === 0) {
            toast.info("Nothing selected — nothing applied.");
        } else {
            const parts = [`${applied} sorted`];
            if (skipped > 0) parts.push(`${skipped} skipped`);
            if (failed > 0) parts.push(`${failed} failed`);
            if (failed > 0) toast.error(parts.join(", "));
            else toast.success(parts.join(", "));
        }

        onApplied();
        onClose();
    }

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={handleClose}>
            <div
                data-testid="ai-sort-modal"
                className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-6 py-4 border-b border-hui-border flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-hui-primary" />
                    <div>
                        <h3 className="text-lg font-bold text-hui-textMain">Review AI sort suggestions</h3>
                        <p className="text-xs text-hui-textMuted mt-0.5">Nothing moves until you click Apply — adjust or clear any row first.</p>
                    </div>
                </div>

                <div className="overflow-y-auto p-6 space-y-3">
                    {rows.length === 0 ? (
                        <p className="text-sm text-hui-textMuted text-center py-8">No unsorted items to suggest.</p>
                    ) : (
                        rows.map((row) => (
                            <div
                                key={row.itemId}
                                data-testid={`ai-sort-row-${row.itemId}`}
                                className="flex items-start gap-3 rounded-lg border border-slate-200 p-3"
                            >
                                <div className="w-12 h-12 shrink-0 rounded-md bg-slate-100 flex items-center justify-center overflow-hidden">
                                    {isHttpUrl(row.imageUrl) ? (
                                        <img src={row.imageUrl!} alt={row.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <ImageOff className="w-4 h-4 text-slate-300" />
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-hui-textMain truncate">{row.name}</p>
                                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                        <label className="sr-only" htmlFor={`ai-sort-select-${row.itemId}`}>
                                            Decision for {row.name}
                                        </label>
                                        <select
                                            id={`ai-sort-select-${row.itemId}`}
                                            data-testid={`ai-sort-row-select-${row.itemId}`}
                                            className="hui-input text-sm py-1 w-auto"
                                            value={selections[row.itemId] ?? LEAVE_UNSORTED}
                                            onChange={(e) => setSelections((prev) => ({ ...prev, [row.itemId]: e.target.value }))}
                                            disabled={applying}
                                        >
                                            <option value={LEAVE_UNSORTED}>Leave unsorted</option>
                                            {decisions.map((d) => (
                                                <option key={d.id} value={d.id}>{d.name}</option>
                                            ))}
                                        </select>
                                        <span
                                            data-testid={`ai-sort-row-confidence-${row.itemId}`}
                                            className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CONFIDENCE_STYLES[row.confidence] || CONFIDENCE_STYLES.low}`}
                                        >
                                            {row.confidence}
                                        </span>
                                    </div>
                                    {row.reason && <p className="text-xs text-hui-textMuted mt-1">{row.reason}</p>}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                    <button data-testid="ai-sort-cancel" onClick={handleClose} disabled={applying} className="hui-btn hui-btn-secondary">
                        Cancel
                    </button>
                    <button
                        data-testid="ai-sort-apply"
                        onClick={handleApply}
                        disabled={applying || rows.length === 0}
                        className="hui-btn hui-btn-green disabled:opacity-50"
                    >
                        {applying ? "Applying…" : "Apply"}
                    </button>
                </div>
            </div>
        </div>
    );
}
