"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { formatLocalDateString } from "@/lib/sales-tax-report";

const PAYMENT_METHODS = [
    { key: "check", label: "Check", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { key: "cash", label: "Cash", icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" },
    { key: "zelle", label: "Zelle", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
    { key: "venmo", label: "Venmo", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
    { key: "credit_card", label: "Card", icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
    { key: "wire", label: "Wire", icon: "M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" },
    { key: "ach", label: "ACH", icon: "M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" },
    { key: "other", label: "Other", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
] as const;

const REFERENCE_LABELS: Record<string, string> = {
    check: "Check Number",
    cash: "Receipt Number",
    zelle: "Confirmation #",
    venmo: "Transaction ID",
    credit_card: "Last 4 Digits",
    wire: "Wire Ref #",
    ach: "Confirmation #",
    other: "Reference #",
};

export type RecordPaymentInput = {
    paymentDate: string;
    method: string;
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
    const [paymentDate, setPaymentDate] = useState<string>(formatLocalDateString(new Date()));
    const [method, setMethod] = useState<string>("check");
    const [referenceNumber, setReferenceNumber] = useState<string>("");
    const [notes, setNotes] = useState<string>("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const refLabel = REFERENCE_LABELS[method] || "Reference #";
    const refRequired = method === "check";

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (refRequired && !referenceNumber.trim()) {
            toast.error(`${refLabel} is required`);
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
                className="bg-white rounded-xl shadow-2xl w-full max-w-lg"
            >
                {/* Header with close button */}
                <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-hui-textMain">Record Payment</h3>
                    <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 transition rounded-lg p-1 hover:bg-slate-100">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* Amount banner */}
                <div className="mx-6 mt-5 rounded-lg bg-gradient-to-r from-indigo-50 to-slate-50 border border-indigo-100 px-5 py-4">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{milestoneName}</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-0.5">{formatCurrency(amount)}</p>
                </div>

                <div className="px-6 py-5 space-y-5">
                    {/* Payment Date */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">Payment Date</label>
                        <input
                            type="date"
                            className="hui-input w-full"
                            value={paymentDate}
                            onChange={(e) => setPaymentDate(e.target.value)}
                            required
                        />
                    </div>

                    {/* Payment Method Grid */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Payment Method</label>
                        <div className="grid grid-cols-4 gap-2">
                            {PAYMENT_METHODS.map((m) => (
                                <button
                                    key={m.key}
                                    type="button"
                                    onClick={() => { setMethod(m.key); setReferenceNumber(""); }}
                                    className={`flex flex-col items-center gap-1.5 px-2 py-2.5 rounded-lg border text-xs font-medium transition-all ${
                                        method === m.key
                                            ? "bg-indigo-50 border-indigo-300 text-indigo-700 ring-1 ring-indigo-200"
                                            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300"
                                    }`}
                                >
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d={m.icon} />
                                    </svg>
                                    {m.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Reference Number */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
                            {refLabel} {refRequired && <span className="text-red-500">*</span>}
                        </label>
                        <input
                            type="text"
                            className="hui-input w-full"
                            value={referenceNumber}
                            onChange={(e) => setReferenceNumber(e.target.value)}
                            placeholder={method === "check" ? "e.g. 1234" : method === "credit_card" ? "e.g. 4242" : "Optional"}
                            required={refRequired}
                        />
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">Notes <span className="text-slate-400 font-normal normal-case">(optional)</span></label>
                        <textarea
                            className="hui-input w-full"
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Any additional details..."
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-hui-border flex items-center justify-end gap-2 bg-slate-50/50 rounded-b-xl">
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
                        className="hui-btn hui-btn-primary disabled:opacity-50 flex items-center gap-2"
                    >
                        {isSubmitting ? (
                            "Recording..."
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                                Record Payment
                            </>
                        )}
                    </button>
                </div>
            </form>
        </div>
    );
}
