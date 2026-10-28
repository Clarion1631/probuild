"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { reverseReceiptBooking } from "@/lib/actions";

/**
 * Reverse booking (admin only): removes a receipt-booked expense that should
 * never have been job cost. Built like MoveToJobModal (Radix Dialog, mounted by
 * the parent). The confirm step IS this dialog: it shows the amount, job and
 * reason before anything happens.
 */
export type KeepCandidate = { id: string; label: string };

export default function ReverseBookingModal({
    receiptIntakeId,
    expenseId,
    projectId,
    vendor,
    amountLabel,
    dateLabel,
    jobLabel,
    keepCandidates,
    onClose,
    onReversed,
}: {
    receiptIntakeId: string;
    /** The expense and job this dialog shows; the server refuses if either has changed. */
    expenseId: string;
    projectId: string;
    vendor: string | null;
    amountLabel: string;
    dateLabel: string;
    jobLabel: string;
    /** QuickBooks-import expenses on this job with the same amount. */
    keepCandidates: KeepCandidate[];
    onClose: () => void;
    onReversed: () => Promise<void>;
}) {
    const [reason, setReason] = useState<"customer-payment" | "duplicate-of-qbo">("customer-payment");
    const [keptId, setKeptId] = useState("");
    const [busy, setBusy] = useState(false);

    async function reverse() {
        if (reason === "duplicate-of-qbo" && !keptId) return;
        setBusy(true);
        try {
            const res = await reverseReceiptBooking(receiptIntakeId, expenseId, projectId, reason, reason === "duplicate-of-qbo" ? keptId : null);
            if (!res.ok) {
                toast.error(res.message);
                return;
            }
            toast.success(res.phaseToSet
                ? `Reversed ${amountLabel}. Set the phase ${res.phaseToSet.code ?? ""} ${res.phaseToSet.name ?? ""} on the QuickBooks copy.`.replace(/\s+/g, " ")
                : res.phaseCarried
                    ? `Reversed ${amountLabel}. Its phase moved to the QuickBooks copy.`
                    : `Reversed ${amountLabel}.`);
            await onReversed();
        } catch {
            toast.error("Could not reverse it. Refresh the page and try again.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <Dialog.Content className="hui-card fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-5 bg-white p-6 focus:outline-none" aria-modal="true">
                    <div>
                        <Dialog.Title className="text-lg font-bold text-hui-textMain">Reverse booking</Dialog.Title>
                        <Dialog.Description className="text-sm text-hui-textMuted mt-1">
                            {vendor || "Unknown vendor"} · {amountLabel} · {dateLabel} · {jobLabel}
                        </Dialog.Description>
                    </div>

                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                        This removes the expense from {jobLabel} and lowers its job cost by {amountLabel}. The receipt is
                        kept as reversed, and the same file can&apos;t book again. QuickBooks is not touched.
                    </p>

                    <fieldset className="space-y-2">
                        <legend className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">Reason</legend>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="radio" name="reverse-reason" checked={reason === "customer-payment"} onChange={() => setReason("customer-payment")} />
                            Customer payment (not a cost)
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="radio" name="reverse-reason" checked={reason === "duplicate-of-qbo"} onChange={() => setReason("duplicate-of-qbo")} />
                            Double of a QuickBooks import
                        </label>
                    </fieldset>

                    {reason === "duplicate-of-qbo" && (
                        <label className="block space-y-1">
                            <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">QuickBooks import to keep</span>
                            <select className="hui-input w-full" value={keptId} onChange={event => setKeptId(event.target.value)}>
                                <option value="">Choose the QuickBooks copy…</option>
                                {keepCandidates.map(candidate => (
                                    <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                                ))}
                            </select>
                            {keepCandidates.length === 0 && (
                                <span className="text-xs text-hui-textMuted">No QuickBooks import with this amount on this job.</span>
                            )}
                        </label>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" className="hui-btn hui-btn-secondary text-sm" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="hui-btn hui-btn-primary text-sm"
                            onClick={reverse}
                            disabled={busy || (reason === "duplicate-of-qbo" && !keptId)}
                        >
                            {busy ? "Reversing…" : "Reverse booking"}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
