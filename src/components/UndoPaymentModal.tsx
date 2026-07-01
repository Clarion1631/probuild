"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/utils";

interface UndoPaymentModalProps {
    milestoneName: string;
    amount: number;
    paymentMethod: string | null;
    referenceNumber: string | null;
    paidAt: string | null;
    paymentDate: string | null;
    hasStripeIntent: boolean;
    hasQbPayment?: boolean;
    entityLabel?: "estimate" | "invoice";
    currentBalance: number;
    estimateTotal: number;
    currentStatus: string;
    otherPaidCount: number;
    statusBeforePayment: string | null;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}

const METHOD_LABELS: Record<string, string> = {
    card: "Card", ach: "ACH", check: "Check", cash: "Cash",
    zelle: "Zelle", venmo: "Venmo", credit_card: "Credit Card",
    wire: "Wire Transfer", quickbooks: "QuickBooks", other: "Other",
};

function formatMethod(method: string | null, ref: string | null): string {
    if (!method) return "Manual";
    const label = METHOD_LABELS[method] ?? method;
    if (method === "check" && ref) return `Check #${ref}`;
    if (ref) return `${label} · ${ref}`;
    return label;
}

export default function UndoPaymentModal({
    milestoneName, amount, paymentMethod, referenceNumber,
    paidAt, paymentDate, hasStripeIntent,
    hasQbPayment = false, entityLabel = "estimate",
    currentBalance, estimateTotal, currentStatus,
    otherPaidCount, statusBeforePayment,
    onClose, onConfirm,
}: UndoPaymentModalProps) {
    const [confirmText, setConfirmText] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const paidDate = paidAt || paymentDate;
    const newBalance = Math.min(estimateTotal, currentBalance + amount);
    const newStatus = otherPaidCount > 0
        ? (newBalance <= 0 ? "Paid" : "Partially Paid")
        : (statusBeforePayment || (entityLabel === "invoice" ? "Issued" : "Approved"));
    const taxImpact = estimateTotal > 0
        ? Math.round((amount / estimateTotal) * 100)
        : 0;

    const canConfirm = confirmText.toUpperCase() === "UNDO";

    async function handleConfirm() {
        if (!canConfirm) return;
        setIsSubmitting(true);
        try {
            await onConfirm();
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-red-50/50 rounded-t-xl">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
                            <svg className="w-4 h-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-semibold text-slate-900">Undo Payment</h3>
                    </div>
                    <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 transition rounded-lg p-1 hover:bg-slate-100">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* Payment being reversed */}
                <div className="mx-6 mt-5 rounded-lg bg-slate-50 border border-slate-200 px-5 py-4">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{milestoneName}</p>
                    <p className="text-2xl font-bold text-slate-900 mt-0.5">{formatCurrency(amount)}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                        <span>{formatMethod(paymentMethod, referenceNumber)}</span>
                        {paidDate && (
                            <>
                                <span className="text-slate-300">|</span>
                                <span>Paid {new Date(paidDate).toLocaleDateString()}</span>
                            </>
                        )}
                    </div>
                </div>

                {/* Stripe warning */}
                {hasStripeIntent && (
                    <div className="mx-6 mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex gap-3">
                        <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <div>
                            <p className="text-sm font-semibold text-amber-800">Stripe payment detected</p>
                            <p className="text-xs text-amber-700 mt-0.5">
                                This payment was processed through Stripe. Undoing it here will not refund the customer — you must issue a refund separately through the Stripe dashboard.
                            </p>
                        </div>
                    </div>
                )}

                {/* QuickBooks warning */}
                {hasQbPayment && (
                    <div className="mx-6 mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex gap-3">
                        <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <div>
                            <p className="text-sm font-semibold text-amber-800">QuickBooks payment detected</p>
                            <p className="text-xs text-amber-700 mt-0.5">
                                Undoing only changes ProBuild — it does <strong>not</strong> void or refund the payment in QuickBooks Online.
                                Void or refund it in QuickBooks as well; if it stays applied there, the hourly QuickBooks sync will mark this milestone paid again.
                            </p>
                        </div>
                    </div>
                )}

                {/* Cascading effects */}
                <div className="mx-6 mt-4 space-y-2">
                    <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">This will:</p>
                    <ul className="space-y-2">
                        <li className="flex items-start gap-2 text-sm text-slate-700">
                            <svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Reverse the {formatCurrency(amount)} payment
                        </li>
                        <li className="flex items-start gap-2 text-sm text-slate-700">
                            <svg className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span>
                                Change balance due from <strong>{formatCurrency(currentBalance)}</strong> to <strong>{formatCurrency(newBalance)}</strong>
                            </span>
                        </li>
                        {currentStatus !== newStatus && (
                            <li className="flex items-start gap-2 text-sm text-slate-700">
                                <svg className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                                </svg>
                                <span>
                                    Change {entityLabel} status from <strong className="capitalize">{currentStatus}</strong> to <strong className="capitalize">{newStatus}</strong>
                                </span>
                            </li>
                        )}
                        {taxImpact > 0 && (
                            <li className="flex items-start gap-2 text-sm text-slate-700">
                                <svg className="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                </svg>
                                Update sales tax &amp; financial reports
                            </li>
                        )}
                        <li className="flex items-start gap-2 text-sm text-slate-700">
                            <svg className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            Update client portal balance
                        </li>
                    </ul>
                </div>

                {/* Type to confirm */}
                <div className="mx-6 mt-5">
                    <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
                        Type <span className="font-mono bg-red-50 text-red-700 px-1.5 py-0.5 rounded">UNDO</span> to confirm
                    </label>
                    <input
                        type="text"
                        className="hui-input w-full font-mono text-center text-lg tracking-widest"
                        value={confirmText}
                        onChange={e => setConfirmText(e.target.value)}
                        placeholder="UNDO"
                        autoFocus
                    />
                </div>

                {/* Footer */}
                <div className="px-6 py-4 mt-4 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50/50 rounded-b-xl">
                    <button type="button" onClick={onClose} disabled={isSubmitting} className="hui-btn hui-btn-secondary">
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!canConfirm || isSubmitting}
                        className="hui-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition"
                    >
                        {isSubmitting ? (
                            "Undoing..."
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                </svg>
                                Undo Payment
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
