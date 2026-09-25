"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { moveReceiptExpenseToJob } from "@/lib/time-expense-actions";
import { RECEIPT_EXPENSE_DOUBLE_NOTE } from "@/lib/receipt-intake/booked-expense-rules";

/**
 * Move to job — the only way to change the job on a receipt-booked Expense
 * (design spec §6.6). It moves the same Expense, with its receipt, to another
 * job in one transaction. There is no delete for these rows: a double gets
 * `RECEIPT_EXPENSE_DOUBLE_NOTE` instead.
 *
 * Built on Radix Dialog — the house pattern for this (see
 * src/components/nav/MobileNavDrawer.tsx and
 * src/app/projects/[id]/selections/AiSortReviewModal.tsx): gives focus-trap,
 * initial focus, Escape-to-close, an inert background, and focus-return on
 * close for free, instead of hand-rolling any of it on a plain div. Open is
 * controlled entirely by the parent mounting/unmounting this component (the
 * trigger button lives in ExpensesTab.tsx), so there is no Dialog.Trigger
 * here.
 */
export default function MoveToJobModal({
    expenseId,
    vendor,
    amountLabel,
    dateLabel,
    changeOrderLabel,
    projectId,
    jobOptions,
    onClose,
    onMoved,
    fallbackFocusId,
}: {
    expenseId: string;
    vendor: string | null;
    amountLabel: string;
    dateLabel: string;
    changeOrderLabel: string | null;
    projectId: string;
    jobOptions: Array<{ id: string; name: string }>;
    onClose: () => void;
    onMoved: () => Promise<void>;
    /**
     * Element id to focus on close when the trigger is gone (PR #546 review).
     * A successful move removes the row -- and its "Move to job" button --
     * from the list this modal opened from, so `triggerElement` below is a
     * detached node by the time Radix would restore focus to it, and
     * focusing a detached node is a silent no-op: focus landed nowhere.
     */
    fallbackFocusId?: string;
}) {
    const [jobId, setJobId] = useState("");
    const [moving, setMoving] = useState(false);
    const options = jobOptions.filter(job => job.id !== projectId);
    // Radix restores focus to Dialog.Trigger on close, but the trigger here
    // (the row's "Move to job" button) lives in the PARENT's render tree, not
    // this component's -- there is no Dialog.Trigger for it to know about.
    // Captured once, lazily, on this component's first render: the parent
    // mounts this modal fresh each time it opens, so "first render" IS "the
    // moment it opened," same as the plain useEffect this used to be.
    const [triggerElement] = useState<HTMLElement | null>(() =>
        typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
    );

    async function move() {
        if (!jobId) return;
        setMoving(true);
        try {
            const res = await moveReceiptExpenseToJob(expenseId, projectId, jobId);
            if (!res.ok) {
                toast.error(res.message);
                return;
            }
            toast.success(res.phaseCleared
                ? `Moved to ${res.toProjectName}. Set its phase there with Tax & phase.`
                : `Moved to ${res.toProjectName}.`);
            // Awaited so the modal cannot report a stale-list refresh as a
            // move failure -- the try/catch below is only for the move call
            // above; onMoved handles its own aftermath and does not throw
            // for a refresh that came back empty.
            await onMoved();
        } catch {
            toast.error("Could not move it. Refresh the page and try again.");
        } finally {
            setMoving(false);
        }
    }

    return (
        <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <Dialog.Content
                    className="hui-card fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-5 bg-white p-6 focus:outline-none"
                    aria-modal="true"
                    onEscapeKeyDown={event => { if (moving) event.preventDefault(); }}
                    onPointerDownOutside={event => { if (moving) event.preventDefault(); }}
                    onCloseAutoFocus={event => {
                        event.preventDefault();
                        // Still there (Cancel, Escape, or a move that failed and left
                        // the row in place): return focus to it, same as before.
                        if (triggerElement && triggerElement.isConnected) {
                            triggerElement.focus();
                            return;
                        }
                        // Gone (the move succeeded and the row was dropped): land on
                        // a connected element instead of leaving focus nowhere.
                        if (fallbackFocusId) document.getElementById(fallbackFocusId)?.focus();
                    }}
                >
                    <div>
                        <Dialog.Title className="text-lg font-bold text-hui-textMain">Move to another job</Dialog.Title>
                        <Dialog.Description className="text-sm text-hui-textMuted mt-1">
                            {vendor || "Unknown vendor"} · {amountLabel} · {dateLabel}
                        </Dialog.Description>
                    </div>

                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                        {RECEIPT_EXPENSE_DOUBLE_NOTE}
                    </p>

                    {changeOrderLabel && (
                        <p className="text-sm text-hui-textMuted">
                            It will also come off change order {changeOrderLabel}.
                        </p>
                    )}

                    <label className="block space-y-1">
                        <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">
                            Move to
                        </span>
                        <select
                            className="hui-input w-full"
                            value={jobId}
                            onChange={event => setJobId(event.target.value)}
                        >
                            <option value="">Choose a job…</option>
                            {options.map(job => (
                                <option key={job.id} value={job.id}>{job.name}</option>
                            ))}
                        </select>
                        <span className="text-xs text-hui-textMuted">
                            Pick Shop if it isn&apos;t a job cost.
                        </span>
                    </label>

                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" className="hui-btn hui-btn-secondary text-sm" onClick={onClose} disabled={moving}>
                            Cancel
                        </button>
                        <button type="button" className="hui-btn hui-btn-primary text-sm" onClick={move} disabled={moving || !jobId}>
                            {moving ? "Moving…" : "Move"}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
