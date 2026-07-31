"use client";

// Review-before-apply modal for the "Link to schedule" button
// (docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// Mirrors AiSortReviewModal.tsx exactly: nothing moves until Apply is
// clicked per row; Radix Dialog (house pattern); each row applies via
// linkDecisionToSchedule independently (sequential, not Promise.all) so a
// skipped/failed row never blocks the rest.

import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { linkDecisionToSchedule } from "@/lib/actions";
import { Calendar } from "lucide-react";

export type LinkScheduleSuggestionRow = {
    decisionId: string;
    decisionName: string;
    scheduleTaskId: string | null;
    leadTimeDays: number;
    // The decision's ALREADY-CONFIGURED lead time (template default or a
    // prior manual link), if any — takes priority over the AI's guess when
    // seeding the lead-time input (Codex review round 1, issue 5: a
    // deliberately configured value must never be silently clobbered by an
    // AI suggestion).
    existingLeadTimeDays: number | null;
    confidence: "high" | "medium" | "low";
    reason: string;
};

type RowOutcome = { status: "applied" | "skipped" | "failed"; message?: string };

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
    applied: "Linked",
    skipped: "Skipped",
    failed: "Failed",
};

const LEAVE_UNLINKED = "";

function previewDate(task: { id: string; name: string; startDate: string } | undefined, leadTimeDays: string): string | null {
    if (!task) return null;
    const days = Number(leadTimeDays);
    if (!Number.isFinite(days)) return null;
    const start = new Date(task.startDate);
    const preview = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) - days * 86400000);
    return preview.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function LinkScheduleReviewModal({
    open,
    rows,
    tasks,
    failedCount,
    trigger,
    onTriggerClick,
    onClose,
    onApplied,
}: {
    open: boolean;
    rows: LinkScheduleSuggestionRow[];
    tasks: { id: string; name: string; startDate: string }[];
    failedCount: number;
    // Codex review round 1, issue 10: the header button is rendered AS the
    // Dialog.Trigger (asChild) rather than a separate plain <button> next to
    // an independently-opened Dialog.Root — this gives the trigger the ARIA
    // wiring (aria-haspopup/aria-controls/aria-expanded) and focus
    // restoration on close for free. `open` stays fully parent-controlled
    // (the fetch that populates `rows` must complete before the modal makes
    // sense to show) — onTriggerClick is invoked on click instead of Radix
    // auto-opening, so the parent can fetch first and decide.
    trigger: ReactNode;
    onTriggerClick: () => void;
    onClose: () => void;
    onApplied: () => void;
}) {
    const [taskSelections, setTaskSelections] = useState<Record<string, string>>({});
    const [leadTimeDrafts, setLeadTimeDrafts] = useState<Record<string, string>>({});
    const [applying, setApplying] = useState(false);
    const [rowOutcomes, setRowOutcomes] = useState<Record<string, RowOutcome>>({});
    const [seededRows, setSeededRows] = useState(rows);
    if (rows !== seededRows) {
        setSeededRows(rows);
        setTaskSelections(Object.fromEntries(rows.map((r) => [r.decisionId, r.scheduleTaskId ?? LEAVE_UNLINKED])));
        // Configured default wins over the AI's guess (Codex review round 1,
        // issue 5).
        setLeadTimeDrafts(Object.fromEntries(rows.map((r) => [r.decisionId, String(r.existingLeadTimeDays ?? r.leadTimeDays)])));
        setRowOutcomes({});
    }

    const tasksById = new Map(tasks.map((t) => [t.id, t]));
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

        for (const row of rows) {
            const taskId = taskSelections[row.decisionId] || null;
            if (!taskId) continue; // left unlinked — no write attempted; annotated below if the modal stays open
            const leadTimeDays = Number(leadTimeDrafts[row.decisionId]);
            try {
                await linkDecisionToSchedule(row.decisionId, taskId, Number.isFinite(leadTimeDays) ? leadTimeDays : 0);
                outcomes[row.decisionId] = { status: "applied" };
                appliedCount += 1;
            } catch (e: any) {
                outcomes[row.decisionId] = { status: "failed", message: e?.message || "Couldn't link" };
            }
        }

        const attempted = Object.keys(outcomes).length;
        if (attempted === 0) {
            setApplying(false);
            toast.info("Nothing selected — nothing linked.");
            onApplied();
            onClose();
            return;
        }

        const attemptedHasIssues = Object.values(outcomes).some((o) => o.status !== "applied");
        if (attemptedHasIssues) {
            // Modal stays open — every row left unlinked also gets an
            // explicit "skipped" annotation so nothing on screen looks
            // unaddressed (Codex review round 1, issue 9).
            for (const row of rows) {
                if (!(row.decisionId in outcomes) && !taskSelections[row.decisionId]) {
                    outcomes[row.decisionId] = { status: "skipped", message: "Left unlinked" };
                }
            }
        }

        setApplying(false);
        setRowOutcomes(outcomes);
        onApplied();
        if (!attemptedHasIssues) {
            toast.success(`${appliedCount} linked`);
            onClose();
            return;
        }
        toast.info(`${appliedCount} linked, ${attempted - appliedCount} need another look`);
    }

    return (
        <Dialog.Root open={open} onOpenChange={handleOpenChange}>
            <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
                <Dialog.Content
                    data-testid="link-schedule-modal"
                    className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl max-w-2xl w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col focus:outline-none"
                    onEscapeKeyDown={(e) => { if (applying) e.preventDefault(); }}
                    onPointerDownOutside={(e) => { if (applying) e.preventDefault(); }}
                >
                    <div className="px-6 py-4 border-b border-hui-border flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-hui-primary" />
                        <div>
                            <Dialog.Title className="text-lg font-bold text-hui-textMain">Review schedule links</Dialog.Title>
                            <Dialog.Description className="text-xs text-hui-textMuted mt-0.5">
                                Nothing links until you click Apply — adjust the task, lead time, or leave any row unlinked first.
                            </Dialog.Description>
                        </div>
                    </div>

                    {failedCount > 0 && (
                        <div data-testid="link-schedule-failed-banner" className="mx-6 mt-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                            {failedCount} decision{failedCount === 1 ? "" : "s"} couldn&apos;t be matched this run — try Link to schedule again for {failedCount === 1 ? "it" : "them"}.
                        </div>
                    )}

                    <div className="overflow-y-auto p-6 space-y-3">
                        {rows.length === 0 ? (
                            <p className="text-sm text-hui-textMuted text-center py-8">No undecided decisions to link.</p>
                        ) : (
                            rows.map((row) => {
                                const outcome = rowOutcomes[row.decisionId];
                                const selectedTaskId = taskSelections[row.decisionId] ?? LEAVE_UNLINKED;
                                const leadTimeDraft = leadTimeDrafts[row.decisionId] ?? "0";
                                const preview = previewDate(tasksById.get(selectedTaskId), leadTimeDraft);
                                return (
                                    <div key={row.decisionId} data-testid={`link-schedule-row-${row.decisionId}`} className="rounded-lg border border-slate-200 p-3">
                                        <p className="text-sm font-semibold text-hui-textMain">{row.decisionName}</p>
                                        {outcome ? (
                                            <div className="mt-1.5">
                                                <span data-testid={`link-schedule-row-outcome-${row.decisionId}`} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${OUTCOME_STYLES[outcome.status]}`}>
                                                    {OUTCOME_LABELS[outcome.status]}
                                                </span>
                                                {outcome.message && <p className="text-xs text-hui-textMuted mt-1">{outcome.message}</p>}
                                            </div>
                                        ) : (
                                            <>
                                                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                                    <label className="sr-only" htmlFor={`link-schedule-select-${row.decisionId}`}>Schedule task for {row.decisionName}</label>
                                                    <select
                                                        id={`link-schedule-select-${row.decisionId}`}
                                                        data-testid={`link-schedule-row-select-${row.decisionId}`}
                                                        className="hui-input text-sm py-1 w-auto"
                                                        value={selectedTaskId}
                                                        onChange={(e) => setTaskSelections((prev) => ({ ...prev, [row.decisionId]: e.target.value }))}
                                                        disabled={applying}
                                                    >
                                                        <option value={LEAVE_UNLINKED}>Leave unlinked</option>
                                                        {tasks.map((t) => (
                                                            <option key={t.id} value={t.id}>{t.name}</option>
                                                        ))}
                                                    </select>
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        max={365}
                                                        data-testid={`link-schedule-row-lead-time-${row.decisionId}`}
                                                        className="hui-input text-sm py-1 w-20"
                                                        value={leadTimeDraft}
                                                        onChange={(e) => setLeadTimeDrafts((prev) => ({ ...prev, [row.decisionId]: e.target.value }))}
                                                        disabled={applying || !selectedTaskId}
                                                        aria-label="Lead time in days"
                                                    />
                                                    <span className="text-xs text-hui-textMuted">days before</span>
                                                    <span data-testid={`link-schedule-row-confidence-${row.decisionId}`} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CONFIDENCE_STYLES[row.confidence] || CONFIDENCE_STYLES.low}`}>
                                                        {row.confidence}
                                                    </span>
                                                </div>
                                                {preview && (
                                                    <p data-testid={`link-schedule-row-preview-${row.decisionId}`} className="text-xs text-hui-textMain font-medium mt-1">
                                                        Decide by {preview}
                                                    </p>
                                                )}
                                                {row.reason && <p className="text-xs text-hui-textMuted mt-1">{row.reason}</p>}
                                            </>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                        {hasOutcomes && hasIssues ? (
                            <button data-testid="link-schedule-close" onClick={handleClose} className="hui-btn hui-btn-primary">Close</button>
                        ) : (
                            <>
                                <button data-testid="link-schedule-cancel" onClick={handleClose} disabled={applying} className="hui-btn hui-btn-secondary">Cancel</button>
                                <button
                                    data-testid="link-schedule-apply"
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
