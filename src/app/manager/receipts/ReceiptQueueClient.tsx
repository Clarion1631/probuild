"use client";

import { resolveExpenseProjectLabel } from "@/lib/expense-attribution";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Expense {
    id: string;
    qbPurchaseId?: string | null;
    qbSyncedAt?: string | null;
    description: string | null;
    amount: number;
    vendor: string | null;
    date: string | null;
    status: string;
    receiptUrl: string | null;
    // BOTH sides: the queue labels a receipt by the job the money is on.
    projectId?: string | null;
    project?: { id: string; name: string } | null;
    estimate: {
        projectId?: string | null;
        project: { id: string; name: string } | null;
    } | null;
    costCode: { code: string; name: string } | null;
    createdAt: string;
}

interface Project { id: string; name: string; }
interface CostCode { id: string; code: string; name: string; }

interface Props {
    expenses: Expense[];
    importedExpenses: Expense[];
    importedExpenseCount: number;
    projects: Project[];
    costCodes: CostCode[];
}

export default function ReceiptQueueClient({
    expenses: initialExpenses,
    importedExpenses: initialImportedExpenses,
    importedExpenseCount,
}: Props) {
    const [expenses, setExpenses] = useState(initialExpenses);
    const [importedExpenses, setImportedExpenses] = useState(initialImportedExpenses);
    const [processing, setProcessing] = useState<string | null>(null);
    const [uploadingId, setUploadingId] = useState<string | null>(null);
    const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

    async function handleApprove(id: string) {
        setProcessing(id);
        try {
            const res = await fetch(`/api/expenses/${id}/approve`, { method: "POST" });
            if (!res.ok) throw new Error("Failed to approve");
            setExpenses(prev => prev.filter(e => e.id !== id));
            toast.success("Expense approved");
        } catch {
            toast.error("Failed to approve expense");
        } finally {
            setProcessing(null);
        }
    }

    async function handleReject(id: string) {
        setProcessing(id);
        try {
            const res = await fetch(`/api/expenses/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Failed to reject");
            setExpenses(prev => prev.filter(e => e.id !== id));
            toast.success("Expense rejected and removed");
        } catch {
            toast.error("Failed to reject expense");
        } finally {
            setProcessing(null);
        }
    }

    async function handleUploadReceipt(id: string, file: File) {
        setUploadingId(id);
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch(`/api/expenses/${id}/receipt`, { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to upload receipt");
            setImportedExpenses(prev => prev.map(e => e.id === id ? { ...e, receiptUrl: data.receiptUrl } : e));
            toast.success("Receipt uploaded");
        } catch (err: any) {
            toast.error(err.message || "Failed to upload receipt");
        } finally {
            setUploadingId(null);
        }
    }

    return (
        <div className="space-y-8">
            <section className="space-y-3" aria-labelledby="pending-receipts-heading">
                <div className="flex items-baseline justify-between gap-4">
                    <div>
                        <h2 id="pending-receipts-heading" className="font-semibold text-hui-textMain">Pending receipt intake</h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">Prepare and approve these records before they enter accounting.</p>
                    </div>
                    <span className="text-sm text-hui-textMuted font-medium">{expenses.length} pending</span>
                </div>

                {expenses.length === 0 ? (
                    <div className="hui-card p-10 text-center">
                        <svg className="w-10 h-10 text-green-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <h3 className="text-hui-textMain font-semibold mb-1">All caught up</h3>
                        <p className="text-sm text-hui-textMuted">No pending expenses in the review queue.</p>
                    </div>
                ) : expenses.map((exp) => (
                    <div key={exp.id} className="hui-card p-5">
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="font-semibold text-hui-textMain">{exp.vendor || "Unknown vendor"}</span>
                                    <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">Pending Review</span>
                                </div>
                                <p className="text-sm text-hui-textMuted mb-2 truncate">{exp.description || "—"}</p>
                                <div className="flex flex-wrap gap-3 text-xs text-hui-textMuted">
                                    <span>
                                        <strong>Amount:</strong>{" "}
                                        <span className="text-hui-textMain font-semibold">
                                            {formatCurrency(Number(exp.amount))}
                                        </span>
                                    </span>
                                    {exp.date && <span><strong>Date:</strong> {new Date(exp.date).toLocaleDateString()}</span>}
                                    {resolveExpenseProjectLabel(exp).projectName && <span><strong>Project:</strong> {resolveExpenseProjectLabel(exp).projectName}</span>}
                                    {exp.costCode && <span><strong>Code:</strong> {exp.costCode.code} — {exp.costCode.name}</span>}
                                    <span className="text-hui-textMuted/60">
                                        Submitted {new Date(exp.createdAt).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {exp.receiptUrl && (
                                    <a
                                        href={exp.receiptUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="hui-btn hui-btn-secondary text-sm text-blue-600 border-blue-200 hover:bg-blue-50"
                                    >
                                        View receipt
                                    </a>
                                )}
                                <button
                                    onClick={() => handleReject(exp.id)}
                                    disabled={processing === exp.id}
                                    className="hui-btn hui-btn-secondary text-sm text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
                                >
                                    Reject
                                </button>
                                <button
                                    onClick={() => handleApprove(exp.id)}
                                    disabled={processing === exp.id}
                                    className="hui-btn text-sm disabled:opacity-50"
                                >
                                    {processing === exp.id ? "…" : "Approve"}
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </section>

            <section className="space-y-3" aria-labelledby="qbo-imports-heading">
                <div className="flex items-baseline justify-between gap-4">
                    <div>
                        <h2 id="qbo-imports-heading" className="font-semibold text-hui-textMain">Finalized QuickBooks expenses</h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">Read-only audit trail. Bank matching and reconciliation stay in QuickBooks.</p>
                    </div>
                    <span className="text-sm text-hui-textMuted font-medium">
                        Showing {importedExpenses.length} of {importedExpenseCount}
                    </span>
                </div>

                {importedExpenses.length === 0 ? (
                    <div className="hui-card p-6 text-sm text-hui-textMuted">
                        No finalized QuickBooks expenses have been imported yet.
                    </div>
                ) : importedExpenses.map((exp) => (
                    <div key={exp.id} className="hui-card p-5 border-l-4 border-l-indigo-400">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2 mb-1">
                                    <span className="font-semibold text-hui-textMain">{exp.vendor || "Unknown vendor"}</span>
                                    <span className="text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">
                                        Finalized in QuickBooks
                                    </span>
                                </div>
                                <p className="text-sm text-hui-textMuted mb-2 truncate">{exp.description || "QuickBooks import"}</p>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-hui-textMuted">
                                    <span className="text-hui-textMain font-semibold">{formatCurrency(Number(exp.amount))}</span>
                                    {exp.date && <span>{new Date(exp.date).toLocaleDateString(undefined, { timeZone: "UTC" })}</span>}
                                    {resolveExpenseProjectLabel(exp).projectName && <span>{resolveExpenseProjectLabel(exp).projectName}</span>}
                                    {exp.qbPurchaseId && <span>QBO transaction {exp.qbPurchaseId}</span>}
                                    {exp.qbSyncedAt && <span>Imported {new Date(exp.qbSyncedAt).toLocaleString()}</span>}
                                </div>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                                {exp.receiptUrl && (
                                    <a
                                        href={exp.receiptUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-blue-600 hover:underline"
                                    >
                                        View receipt
                                    </a>
                                )}
                                <input
                                    type="file"
                                    accept="image/*,application/pdf"
                                    className="hidden"
                                    ref={el => { fileInputRefs.current[exp.id] = el; }}
                                    onChange={e => {
                                        const file = e.target.files?.[0];
                                        if (file) handleUploadReceipt(exp.id, file);
                                        e.target.value = "";
                                    }}
                                />
                                <button
                                    onClick={() => fileInputRefs.current[exp.id]?.click()}
                                    disabled={uploadingId === exp.id}
                                    className="text-slate-400 hover:text-hui-primary transition disabled:opacity-50"
                                    title={exp.receiptUrl ? "Replace receipt" : "Upload receipt"}
                                >
                                    {uploadingId === exp.id ? (
                                        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 1 1-6.219-8.56" />
                                        </svg>
                                    ) : (
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                                        </svg>
                                    )}
                                </button>
                                <div className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
                                    QuickBooks import
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </section>
        </div>
    );
}
