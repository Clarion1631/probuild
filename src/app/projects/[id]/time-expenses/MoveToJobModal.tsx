"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { moveReceiptExpenseToJob } from "@/lib/time-expense-actions";
import { RECEIPT_EXPENSE_DOUBLE_NOTE } from "@/lib/receipt-intake/booked-expense-rules";

/**
 * Move to job — the only way to change the job on a receipt-booked Expense
 * (design spec §6.6). It moves the same Expense, with its receipt, to another
 * job in one transaction. There is no delete for these rows: a double gets
 * `RECEIPT_EXPENSE_DOUBLE_NOTE` instead.
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
}: {
    expenseId: string;
    vendor: string | null;
    amountLabel: string;
    dateLabel: string;
    changeOrderLabel: string | null;
    projectId: string;
    jobOptions: Array<{ id: string; name: string }>;
    onClose: () => void;
    onMoved: () => void;
}) {
    const [jobId, setJobId] = useState("");
    const [moving, setMoving] = useState(false);
    const options = jobOptions.filter(job => job.id !== projectId);
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const movingRef = useRef(moving);
    movingRef.current = moving;

    // Focus moves into the dialog on open, and back to whatever triggered it
    // (the row's "Move to job" button) once this unmounts.
    useEffect(() => {
        const trigger = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        return () => trigger?.focus?.();
    }, []);

    // Escape cancels, same as the Cancel button — including staying open
    // while a move is in flight, which that button also respects.
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape" && !movingRef.current) onClose();
        }
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

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
            onMoved();
        } catch {
            toast.error("Could not move it. Refresh the page and try again.");
        } finally {
            setMoving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="hui-card w-full max-w-lg p-6 space-y-5 bg-white"
            >
                <div>
                    <h2 id={titleId} className="text-lg font-bold text-hui-textMain">Move to another job</h2>
                    <p className="text-sm text-hui-textMuted mt-1">
                        {vendor || "Unknown vendor"} · {amountLabel} · {dateLabel}
                    </p>
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
            </div>
        </div>
    );
}
