"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createExpense } from "@/lib/time-expense-actions";

interface Props {
    projectId: string;
    estimates: { id: string; title: string; items: { id: string; name: string }[] }[];
    costCodes: { id: string; name: string; code: string }[];
    costTypes: { id: string; name: string }[];
    onClose: () => void;
}

export default function NewExpenseEntryModal({ projectId, estimates, costCodes, costTypes, onClose }: Props) {
    const [saving, setSaving] = useState(false);
    const [estimateId, setEstimateId] = useState(estimates[0]?.id || "");
    const [itemId, setItemId] = useState("");
    const [costCodeId, setCostCodeId] = useState("");
    const [costTypeId, setCostTypeId] = useState("");
    const [amount, setAmount] = useState("");
    const [vendor, setVendor] = useState("");
    const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
    const [description, setDescription] = useState("");
    const [receiptFile, setReceiptFile] = useState<File | null>(null);
    const [ocrLoading, setOcrLoading] = useState(false);

    const selectedEstimate = estimates.find(e => e.id === estimateId);
    const lineItems = selectedEstimate?.items || [];

    async function handleReceiptOCR(file: File) {
        setReceiptFile(file);
        setOcrLoading(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("projectId", projectId);

            const res = await fetch("/api/ai/receipt-ocr", { method: "POST", body: formData });
            if (res.ok) {
                const result = await res.json();
                if (result.vendor) setVendor(result.vendor);
                if (result.amount) setAmount(String(result.amount));
                if (result.date) setDate(result.date);
                if (result.description) setDescription(result.description);
                toast.success("Receipt scanned successfully");
            }
        } catch {
            // OCR is optional — user can fill manually
        } finally {
            setOcrLoading(false);
        }
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!estimateId) {
            toast.error("Select an estimate");
            return;
        }
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Enter a valid amount");
            return;
        }
        setSaving(true);
        try {
            await createExpense({
                estimateId,
                itemId: itemId || undefined,
                costCodeId: costCodeId || undefined,
                costTypeId: costTypeId || undefined,
                amount: parseFloat(amount),
                vendor: vendor || undefined,
                date: date || undefined,
                description: description || undefined,
                projectId,
            });
            toast.success("Expense added");
            onClose();
        } catch (err: any) {
            toast.error(err.message || "Failed to add expense");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-5">
                    <h3 className="text-lg font-bold text-hui-textMain">New Expense</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                </div>

                {/* Receipt OCR Upload */}
                <div className="mb-5 border-2 border-dashed border-slate-300 rounded-lg p-4 text-center hover:border-hui-primary transition cursor-pointer"
                    onClick={() => document.getElementById("receipt-upload")?.click()}
                >
                    <input
                        id="receipt-upload"
                        type="file"
                        accept="image/*,application/pdf"
                        className="hidden"
                        onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) handleReceiptOCR(f);
                        }}
                    />
                    {ocrLoading ? (
                        <div className="text-sm text-hui-primary font-medium">Scanning receipt with AI...</div>
                    ) : receiptFile ? (
                        <div className="text-sm text-slate-600">
                            <span className="font-medium">{receiptFile.name}</span> — scanned
                        </div>
                    ) : (
                        <>
                            <svg className="w-8 h-8 mx-auto text-slate-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            <p className="text-sm text-slate-500">Drop receipt image or click to scan with AI</p>
                            <p className="text-xs text-slate-400 mt-1">Auto-fills vendor, amount, and date</p>
                        </>
                    )}
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Estimate</label>
                            <select value={estimateId} onChange={e => { setEstimateId(e.target.value); setItemId(""); }} className="hui-input w-full text-sm">
                                {estimates.length === 0 && <option value="">No estimates</option>}
                                {estimates.map(est => (
                                    <option key={est.id} value={est.id}>{est.title}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Line Item</label>
                            <select value={itemId} onChange={e => setItemId(e.target.value)} className="hui-input w-full text-sm">
                                <option value="">None</option>
                                {lineItems.map(item => (
                                    <option key={item.id} value={item.id}>{item.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Amount ($)</label>
                            <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="hui-input w-full text-sm" placeholder="0.00" />
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Date</label>
                            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Vendor</label>
                        <input type="text" value={vendor} onChange={e => setVendor(e.target.value)} className="hui-input w-full text-sm" placeholder="e.g. Home Depot" />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Cost Code</label>
                            <select value={costCodeId} onChange={e => setCostCodeId(e.target.value)} className="hui-input w-full text-sm">
                                <option value="">None</option>
                                {costCodes.map(cc => (
                                    <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Cost Type</label>
                            <select value={costTypeId} onChange={e => setCostTypeId(e.target.value)} className="hui-input w-full text-sm">
                                <option value="">None</option>
                                {costTypes.map(ct => (
                                    <option key={ct.id} value={ct.id}>{ct.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1 block">Description</label>
                        <textarea value={description} onChange={e => setDescription(e.target.value)} className="hui-input w-full text-sm" rows={2} placeholder="What was purchased..." />
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" onClick={onClose} className="hui-btn hui-btn-secondary text-sm px-4 py-2">Cancel</button>
                        <button type="submit" disabled={saving} className="hui-btn hui-btn-green text-sm px-4 py-2">
                            {saving ? "Saving..." : "Add Expense"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
