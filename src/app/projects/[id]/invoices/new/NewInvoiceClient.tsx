"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createInvoiceFromEstimate, createOneOffInvoice } from "@/lib/actions";
import StatusBadge from "@/components/StatusBadge";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

type LineItem = { id: number; name: string; amount: string };

let nextId = 1;
function blankItem(): LineItem {
    return { id: nextId++, name: "", amount: "" };
}

export default function NewInvoiceClient({ project, estimates }: { project: any; estimates: any[] }) {
    const router = useRouter();
    const [tab, setTab] = useState<"estimate" | "custom">("estimate");
    const [isGenerating, setIsGenerating] = useState<string | null>(null);

    // Custom invoice state
    const [items, setItems] = useState<LineItem[]>([blankItem()]);
    const [isCreating, setIsCreating] = useState(false);

    // Sort: approved first, then by totalAmount desc
    const sortedEstimates = [...estimates].sort((a, b) => {
        if (a.status === "Approved" && b.status !== "Approved") return -1;
        if (b.status === "Approved" && a.status !== "Approved") return 1;
        return Number(b.totalAmount || 0) - Number(a.totalAmount || 0);
    });

    async function handleGenerate(estimateId: string) {
        setIsGenerating(estimateId);
        try {
            const res = await createInvoiceFromEstimate(estimateId);
            router.push(`/projects/${project.id}/invoices/${res.id}`);
        } catch (e) {
            console.error(e);
            setIsGenerating(null);
        }
    }

    function updateItem(id: number, field: keyof LineItem, value: string) {
        setItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
    }

    function removeItem(id: number) {
        setItems((prev) => prev.filter((item) => item.id !== id));
    }

    const validItems = items.filter((i) => i.name.trim() && parseFloat(i.amount) > 0);
    const total = validItems.reduce((sum, item) => sum + parseFloat(item.amount), 0);

    async function handleCreateCustom() {
        if (!validItems.length) return;
        setIsCreating(true);
        try {
            const res = await createOneOffInvoice(
                project.id,
                validItems.map((i) => ({ name: i.name.trim(), amount: parseFloat(i.amount) })),
            );
            router.push(`/projects/${project.id}/invoices/${res.id}`);
        } catch (e: any) {
            toast.error(e?.message || "Failed to create invoice. Please try again.");
            setIsCreating(false);
        }
    }

    const canSubmit = validItems.length > 0;

    return (
        <div>
            {/* Tab toggle */}
            <div className="flex gap-1 mb-6 border border-hui-border rounded-lg p-1 w-fit bg-slate-50">
                <button
                    onClick={() => setTab("estimate")}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
                        tab === "estimate"
                            ? "bg-white shadow-sm text-hui-textMain"
                            : "text-hui-textMuted hover:text-hui-textMain"
                    }`}
                >
                    From Estimate
                </button>
                <button
                    onClick={() => setTab("custom")}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
                        tab === "custom"
                            ? "bg-white shadow-sm text-hui-textMain"
                            : "text-hui-textMuted hover:text-hui-textMain"
                    }`}
                >
                    Custom Invoice
                </button>
            </div>

            {/* From Estimate tab */}
            {tab === "estimate" && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {sortedEstimates.length === 0 && (
                        <div className="col-span-full hui-card p-12 text-center text-hui-textMuted">
                            <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p className="text-base font-medium text-hui-textMain mb-1">No estimates found</p>
                            <p className="text-sm">Create an estimate first, or use the Custom Invoice tab to bill directly.</p>
                        </div>
                    )}
                    {sortedEstimates.map((est: any) => {
                        const scheduleCount = est.paymentSchedules?.length || 0;
                        const isApproved = est.status === "Approved";
                        return (
                            <div key={est.id} className={`hui-card p-6 flex flex-col h-full transition ${isApproved ? "hover:shadow-md ring-1 ring-emerald-200" : "hover:shadow-md opacity-80"}`}>
                                <div className="mb-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-lg text-hui-textMain line-clamp-1" title={est.title}>{est.title}</h3>
                                        <StatusBadge status={est.status} />
                                    </div>
                                    <p className="text-sm text-hui-textMuted mb-1">{est.code}</p>
                                    <p className="font-medium text-hui-textMain">{formatCurrency(est.totalAmount)}</p>
                                    {scheduleCount > 0 && (
                                        <p className="text-xs text-hui-textMuted mt-2 flex items-center gap-1">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                                            {scheduleCount} payment milestone{scheduleCount !== 1 ? "s" : ""}
                                        </p>
                                    )}
                                    {isApproved && (
                                        <p className="text-xs text-emerald-600 mt-2 font-medium flex items-center gap-1">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                                            Recommended — client approved
                                        </p>
                                    )}
                                </div>
                                <div className="mt-auto pt-4 border-t border-hui-border">
                                    <button
                                        onClick={() => handleGenerate(est.id)}
                                        disabled={isGenerating !== null}
                                        className={`w-full justify-center disabled:opacity-50 ${isApproved ? "hui-btn hui-btn-green" : "hui-btn hui-btn-primary"}`}
                                    >
                                        {isGenerating === est.id ? "Generating..." : "Generate Invoice"}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Custom Invoice tab */}
            {tab === "custom" && (
                <div className="hui-card p-6 max-w-2xl">
                    <p className="text-sm text-hui-textMuted mb-5">
                        Add line items manually. Each item will appear as a payment milestone on the invoice.
                    </p>

                    <div className="space-y-2 mb-4">
                        {/* Header row */}
                        <div className="grid grid-cols-[1fr_140px_32px] gap-2 px-1">
                            <span className="text-xs font-medium text-hui-textMuted">Description</span>
                            <span className="text-xs font-medium text-hui-textMuted">Amount</span>
                            <span />
                        </div>

                        {items.map((item) => (
                            <div key={item.id} className="grid grid-cols-[1fr_140px_32px] gap-2 items-center">
                                <input
                                    type="text"
                                    placeholder="e.g. Labor, Materials"
                                    value={item.name}
                                    onChange={(e) => updateItem(item.id, "name", e.target.value)}
                                    className="hui-input text-sm"
                                />
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hui-textMuted text-sm">$</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="0.00"
                                        value={item.amount}
                                        onChange={(e) => updateItem(item.id, "amount", e.target.value)}
                                        className="hui-input text-sm pl-6 w-full"
                                    />
                                </div>
                                <button
                                    onClick={() => removeItem(item.id)}
                                    disabled={items.length === 1}
                                    className="p-1 rounded text-hui-textMuted hover:text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed transition"
                                    title="Remove"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M18 6 6 18M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        ))}
                    </div>

                    <button
                        onClick={() => setItems((prev) => [...prev, blankItem()])}
                        className="hui-btn hui-btn-ghost text-sm mb-6 flex items-center gap-1.5"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                        Add item
                    </button>

                    <div className="flex items-center justify-between border-t border-hui-border pt-4">
                        <div className="text-sm">
                            <span className="text-hui-textMuted">Total: </span>
                            <span className="font-semibold text-hui-textMain text-base">{formatCurrency(total)}</span>
                        </div>
                        <button
                            onClick={handleCreateCustom}
                            disabled={!canSubmit || isCreating}
                            className="hui-btn hui-btn-primary disabled:opacity-50"
                        >
                            {isCreating ? "Creating..." : "Create Invoice"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
