"use client";

// Review-before-apply modal for the "Sort with AI" button
// (docs/superpowers/plans/2026-07-30-selection-ai-sort.md). Nothing moves
// until Apply is clicked — Cancel just closes; the suggestions the route
// already persisted remain as chips on the Unsorted cards, which is the
// intended behavior.
//
// Built on Radix Dialog — the house pattern for this (see
// src/components/nav/MobileNavDrawer.tsx and
// src/app/company-dashboard/schedule-board/DispatchReviewDialog.tsx): gives
// focus-trap, initial focus, Escape-to-close, aria-modal/role="dialog", and
// aria-labelledby/aria-describedby (via Dialog.Title/Dialog.Description) for
// free, instead of hand-rolling any of it on a plain div.

import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { applySuggestedDecision, createDecisionForSuggestion } from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { ImageOff, Sparkles } from "lucide-react";
import { normalizeForDedupe } from "@/lib/decision-template-core";
import {
    newCategoryOptionValue,
    resolveNewCategoryPlan,
    buildRowApplyPlans,
    type NewCategoryResolution,
} from "@/lib/selection-ai-sort-review-plan";

export type AiSortSuggestionRow = {
    itemId: string;
    name: string;
    imageUrl: string | null;
    decisionId: string | null;
    decisionName: string | null;
    // Advisory proposed category name — only ever non-null when decisionId
    // is null (see selection-ai-sort-core.ts's mutual-exclusivity comment).
    newCategoryName: string | null;
    confidence: "high" | "medium" | "low";
    reason: string;
};

type RowOutcome = {
    status: "applied" | "skipped" | "failed";
    message?: string;
};

const CONFIDENCE_STYLES: Record<string, string> = {
    high: "bg-green-100 text-green-700",
    medium: "bg-amber-100 text-amber-700",
    low: "bg-slate-100 text-slate-600",
};

const OUTCOME_STYLES: Record<RowOutcome["status"], string> = {
    applied: "bg-green-100 text-green-700",
    skipped: "bg-amber-100 text-amber-700",
    failed: "bg-red-100 text-red-700",
};

const OUTCOME_LABELS: Record<RowOutcome["status"], string> = {
    applied: "Sorted",
    skipped: "Skipped",
    failed: "Failed",
};

const LEAVE_UNSORTED = "";
// The select's "Create <name>" option value is sentinel-encoded and the
// resolve-then-apply planning is pure — both live in
// selection-ai-sort-review-plan.ts so they're unit-testable without a DOM
// (Codex review, new-categories follow-up, issue 4b) and so the grouping
// Map can never collide with Object.prototype the way a plain object keyed
// by an untrusted string could (issue 3).

export default function AiSortReviewModal({
    open,
    projectId,
    rows,
    decisions,
    failedCount,
    trigger,
    onTriggerClick,
    onClose,
    onApplied,
}: {
    open: boolean;
    projectId: string;
    rows: AiSortSuggestionRow[];
    decisions: { id: string; name: string }[];
    // Items whose AI batch failed this run (excluded from `rows` entirely —
    // never a silent "no match") — surfaced as a banner so staff know some
    // items still need a rerun, not that nothing was wrong.
    failedCount: number;
    // Codex review round 1 (on the sibling schedule-templates feature) also
    // flagged this modal's trigger for the same gap: the "Sort with AI"
    // button was a plain <button> next to an independently-opened
    // Dialog.Root, missing the Trigger's ARIA wiring and close-focus
    // restoration. Rendered as Dialog.Trigger (asChild) here instead — `open`
    // stays fully parent-controlled (the fetch that populates `rows` must
    // finish before the modal makes sense to show), so onTriggerClick runs
    // the existing fetch-then-decide logic instead of Radix auto-opening.
    trigger: ReactNode;
    onTriggerClick: () => void;
    onClose: () => void;
    onApplied: () => void;
}) {
    const [selections, setSelections] = useState<Record<string, string>>({});
    const [applying, setApplying] = useState(false);
    const [rowOutcomes, setRowOutcomes] = useState<Record<string, RowOutcome>>({});
    // Tracks which `rows` array the current `selections` were seeded from —
    // React's documented pattern for "adjusting state when a prop changes"
    // (https://react.dev/learn/you-might-not-need-an-effect), which avoids
    // the extra render + cascading-update a useEffect-based reset would
    // cause. Re-seeds to each row's suggested decision (or "Leave unsorted"
    // when the suggestion was null) whenever a fresh set of rows arrives.
    const [seededRows, setSeededRows] = useState(rows);
    if (rows !== seededRows) {
        setSeededRows(rows);
        setSelections(
            Object.fromEntries(
                rows.map((r) => [
                    r.itemId,
                    r.decisionId ?? (r.newCategoryName ? newCategoryOptionValue(r.newCategoryName) : LEAVE_UNSORTED),
                ]),
            ),
        );
        setRowOutcomes({});
    }

    const hasOutcomes = Object.keys(rowOutcomes).length > 0;
    const hasIssues = Object.values(rowOutcomes).some((o) => o.status !== "applied");

    function handleClose() {
        if (applying) return;
        onClose();
    }

    function handleOpenChange(next: boolean) {
        if (next) {
            onTriggerClick();
            return;
        }
        handleClose();
    }

    async function handleApply() {
        setApplying(true);
        const outcomes: Record<string, RowOutcome> = {};
        let appliedCount = 0;
        let createdCount = 0; // only names resolved with { existed: false } count

        // Pure planning step (selection-ai-sort-review-plan.ts): decide each
        // row's target (leave / real decisionId / unresolved "Create <name>")
        // and de-duplicate the new-category names that actually need
        // resolving — grouped by normalizeForDedupe, the SAME comparison the
        // server uses, so "Backsplash" and " backsplash " group together
        // client-side exactly the way createDecisionForSuggestion's own
        // dedupe would treat them.
        const plan = resolveNewCategoryPlan(rows, selections, normalizeForDedupe);

        // Resolve each unique chosen name ONCE, before any row is applied —
        // multiple rows may share the same proposed name (e.g. two items
        // both suggested "Backsplash"), and only one Decision must ever be
        // created for it.
        const resolutions = new Map<string, NewCategoryResolution>();
        for (const [key, rawName] of plan.uniqueNewCategoryNames) {
            try {
                const result = await createDecisionForSuggestion(projectId, rawName);
                resolutions.set(key, { decisionId: result.decisionId });
                if (!result.existed) createdCount += 1;
            } catch (e: any) {
                resolutions.set(key, { error: e?.message || "Couldn't create category" });
            }
        }

        const rowApplyPlans = buildRowApplyPlans(rows, plan, normalizeForDedupe, resolutions);

        // Sequential, not Promise.all — each row is its own CAS write and
        // the plan calls for skipped/failed rows to continue, not abort the
        // rest of the batch.
        for (const row of rows) {
            const rowApplyPlan = rowApplyPlans.get(row.itemId);
            if (!rowApplyPlan || rowApplyPlan.kind === "leave") continue; // no attempt, no outcome
            if (rowApplyPlan.kind === "failed") {
                // Its category's create call failed — marked immediately,
                // no applySuggestedDecision attempt for it. Independent rows
                // (a different, successfully-resolved name, or a real
                // decisionId) are untouched and still proceed below.
                outcomes[row.itemId] = { status: "failed", message: rowApplyPlan.message };
                continue;
            }
            try {
                const result = await applySuggestedDecision(row.itemId, rowApplyPlan.decisionId);
                if (result.applied) {
                    outcomes[row.itemId] = { status: "applied" };
                    appliedCount += 1;
                } else {
                    outcomes[row.itemId] = {
                        status: "skipped",
                        message: "Changed since the suggestion was made",
                    };
                }
            } catch (e: any) {
                outcomes[row.itemId] = { status: "failed", message: e?.message || "Couldn't apply" };
            }
        }

        setApplying(false);
        setRowOutcomes(outcomes);

        const attempted = Object.keys(outcomes).length;
        if (attempted === 0) {
            toast.info("Nothing selected — nothing applied.");
            onApplied();
            onClose();
            return;
        }

        const attemptedHasIssues = Object.values(outcomes).some((o) => o.status !== "applied");
        const createdSuffix = createdCount > 0 ? `, created ${createdCount} new categories` : "";
        // Refresh regardless — whatever DID apply is real and should show
        // up under its decision immediately.
        onApplied();
        if (!attemptedHasIssues) {
            toast.success(`${appliedCount} sorted${createdSuffix}`);
            onClose();
            return;
        }

        // Some rows were skipped or failed — do NOT auto-close. They're
        // annotated in place below; staff closes explicitly once they've
        // seen which ones need another look.
        toast.info(`${appliedCount} sorted, ${attempted - appliedCount} need another look${createdSuffix}`);
    }

    return (
        <Dialog.Root open={open} onOpenChange={handleOpenChange}>
            <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
                <Dialog.Content
                    data-testid="ai-sort-modal"
                    className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl max-w-2xl w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col focus:outline-none"
                    onEscapeKeyDown={(e) => { if (applying) e.preventDefault(); }}
                    onPointerDownOutside={(e) => { if (applying) e.preventDefault(); }}
                >
                    <div className="px-6 py-4 border-b border-hui-border flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-hui-primary" />
                        <div>
                            <Dialog.Title className="text-lg font-bold text-hui-textMain">Review AI sort suggestions</Dialog.Title>
                            <Dialog.Description className="text-xs text-hui-textMuted mt-0.5">
                                Nothing moves until you click Apply — adjust or clear any row first.
                            </Dialog.Description>
                        </div>
                    </div>

                    {failedCount > 0 && (
                        <div
                            data-testid="ai-sort-failed-banner"
                            className="mx-6 mt-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800"
                        >
                            {failedCount} item{failedCount === 1 ? "" : "s"} couldn&apos;t be classified this run — try Sort with AI again for {failedCount === 1 ? "it" : "them"}.
                        </div>
                    )}

                    <div className="overflow-y-auto p-6 space-y-3">
                        {rows.length === 0 ? (
                            <p className="text-sm text-hui-textMuted text-center py-8">No unsorted items to suggest.</p>
                        ) : (
                            rows.map((row) => {
                                const outcome = rowOutcomes[row.itemId];
                                return (
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
                                            {outcome ? (
                                                <div className="mt-1.5">
                                                    <span
                                                        data-testid={`ai-sort-row-outcome-${row.itemId}`}
                                                        className={`text-xs font-semibold px-2 py-0.5 rounded-full ${OUTCOME_STYLES[outcome.status]}`}
                                                    >
                                                        {OUTCOME_LABELS[outcome.status]}
                                                    </span>
                                                    {outcome.message && (
                                                        <p className="text-xs text-hui-textMuted mt-1">{outcome.message}</p>
                                                    )}
                                                </div>
                                            ) : (
                                                <>
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
                                                            {row.newCategoryName && (
                                                                <option value={newCategoryOptionValue(row.newCategoryName)}>
                                                                    {`Create "${row.newCategoryName}"`}
                                                                </option>
                                                            )}
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
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                        {hasOutcomes && hasIssues ? (
                            <button data-testid="ai-sort-close" onClick={handleClose} className="hui-btn hui-btn-primary">
                                Close
                            </button>
                        ) : (
                            <>
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
                            </>
                        )}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
