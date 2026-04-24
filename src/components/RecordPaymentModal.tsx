"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { formatLocalDateString } from "@/lib/sales-tax-report";

export type RecordPaymentInput = {
    paymentDate: string;
    method: "check" | "cash";
    referenceNumber: string | null;
    notes: string | null;
};

export default function RecordPaymentModal({
    milestoneName,
    amount,
    onClose,
    onSubmit,
}: {
    milestoneName: string;
    amount: number;
    onClose: () => void;
    onSubmit: (input: RecordPaymentInput) => Promise<{ success: boolean; error?: string }>;
}) {
    // Default to today's LOCAL calendar date (not UTC) — otherwise the picker can show "yesterday"
    // for users west of UTC at any time of day, or "tomorrow" in the evening east of UTC.
    const [paymentDate, setPaymentDate] = useState<string>(formatLocalDateString(new Date()));
    const [method, setMethod] = useState<"check" | "cash">("check");
    const [referenceNumber, setReferenceNumber] = useState<string>("");
    const [notes, setNotes] = useState<string>("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (method === "check" && !referenceNumber.trim()) {
            toast.error("Check number is required");
            return;
        }
        setIsSubmitting(true);
        try {
            const result = await onSubmit({
                paymentDate,
                method,
                referenceNumber: referenceNumber.trim() || null,
                notes: notes.trim() || null,
            });
            if (result.success) {
                toast.success("Payment recorded");
                onClose();
            } else {
                toast.error(result.error || "Failed to record payment");
            }
        } catch (e: any) {
            toast.error(e?.message || "Failed to record payment");
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={onClose}
        >
            <form
                onSubmit={handleSubmit}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-lg shadow-xl w-full max-w-md"
            >
                <div className="px-6 py-4 border-b border-hui-border">
                    <h3 className="text-lg font-semibold text-hui-textMain">Record Payment</h3>
                    <p className="text-xs text-hui-textMuted mt-1">
                        {milestoneName} — {formatCurrency(amount)}
                    </p>
                </div>
                <div className="px-6 py-4 space-y-4">
                    <div>
                        <label className="block text-xs font-medium text-hui-textMain mb-1">Payment Date</label>
                        <input
                            type="date"
                            className="hui-input w-full"
                            value={paymentDate}
                            onChange={(e) => setPaymentDate(e.target.value)}
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-hui-textMain mb-1">Method</label>
                        <div className="flex gap-2">
                            <label className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-sm font-medium transition ${method === "check" ? "bg-hui-primary/10 border-hui-primary text-hui-primary" : "bg-white border-hui-border text-hui-textMain hover:bg-slate-50"}`}>
                                <input
                                    type="radio"
                                    name="method"
                                    value="check"
                                    checked={method === "check"}
                                    onChange={() => setMethod("check")}
                                    className="sr-only"
                                />
                                Check
                            </label>
                            <label className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-sm font-medium transition ${method === "cash" ? "bg-hui-primary/10 border-hui-primary text-hui-primary" : "bg-white border-hui-border text-hui-textMain hover:bg-slate-50"}`}>
                                <input
                                    type="radio"
                                    name="method"
                                    value="cash"
                                    checked={method === "cash"}
                                    onChange={() => setMethod("cash")}
                                    className="sr-only"
                                />
                                Cash
                            </label>
                        </div>
                    </div>
                    {method === "check" && (
                        <div>
                            <label className="block text-xs font-medium text-hui-textMain mb-1">
                                Check Number <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="text"
                                className="hui-input w-full"
                                value={referenceNumber}
                                onChange={(e) => setReferenceNumber(e.target.value)}
                                placeholder="e.g. 1234"
                                required
                            />
                        </div>
                    )}
                    <div>
                        <label className="block text-xs font-medium text-hui-textMain mb-1">Notes (optional)</label>
                        <textarea
                            className="hui-input w-full"
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Mailed 2026-04-20, memo line says..."
                        />
                    </div>
                </div>
                <div className="px-6 py-4 border-t border-hui-border flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isSubmitting}
                        className="hui-btn hui-btn-secondary"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="hui-btn hui-btn-primary disabled:opacity-50"
                    >
                        {isSubmitting ? "Recording..." : "Record Payment"}
                    </button>
                </div>
            </form>
        </div>
    );
}
