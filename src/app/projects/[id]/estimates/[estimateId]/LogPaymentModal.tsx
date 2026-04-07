"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface LogPaymentModalProps {
    estimateId: string;
    balanceDue: number;
    onClose: () => void;
    onSaved: () => void;
}

export default function LogPaymentModal({ estimateId, balanceDue, onClose, onSaved }: LogPaymentModalProps) {
    const [amount, setAmount] = useState(balanceDue > 0 ? balanceDue.toFixed(2) : "");
    const [paymentMethod, setPaymentMethod] = useState("Check");
    const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
    const [referenceNumber, setReferenceNumber] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Enter a valid amount");
            return;
        }
        setIsSaving(true);
        try {
            const { logEstimatePayment } = await import("@/lib/actions");
            await logEstimatePayment(estimateId, {
                amount: parseFloat(amount),
                paymentMethod,
                date: new Date(date).toISOString(),
                referenceNumber: referenceNumber || undefined,
            });
            toast.success("Payment logged");
            onSaved();
            onClose();
        } catch (err: any) {
            toast.error(err.message || "Failed to log payment");
        } finally {
            setIsSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-800">Log Payment</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">Amount</label>
                        <div className="relative">
                            <span className="absolute left-3 top-2.5 text-slate-400">$</span>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                className="hui-input pl-7 w-full"
                                placeholder="0.00"
                                autoFocus
                            />
                        </div>
                        {balanceDue > 0 && (
                            <p className="text-xs text-slate-400 mt-1">Balance due: {formatCurrency(balanceDue)}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">Payment Method</label>
                        <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="hui-input w-full">
                            <option>Check</option>
                            <option>Credit Card</option>
                            <option>ACH / Bank Transfer</option>
                            <option>Cash</option>
                            <option>Zelle</option>
                            <option>Venmo</option>
                            <option>Other</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">Date</label>
                        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="hui-input w-full" />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">Reference Number</label>
                        <input
                            type="text"
                            value={referenceNumber}
                            onChange={e => setReferenceNumber(e.target.value)}
                            className="hui-input w-full"
                            placeholder="Auto-generated if blank"
                        />
                    </div>

                    <div className="flex gap-3 pt-2">
                        <button type="button" onClick={onClose} className="hui-btn flex-1">Cancel</button>
                        <button type="submit" disabled={isSaving} className="hui-btn hui-btn-primary flex-1 disabled:opacity-50">
                            {isSaving ? "Saving..." : "Log Payment"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
