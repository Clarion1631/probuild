"use client";

import { useState } from "react";
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
    estimate: {
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
    importedExpenses,
    importedExpenseCount,
}: Props) {
    const [expenses, setExpenses] = useState(initialExpenses);
    const [processing, setProcessing] = useState<string | null>(null);

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
                                    {exp.estimate?.project && <span><strong>Project:</strong> {exp.estimate.project.name}</span>}
                                    {exp.costCode && <span><strong>Code:</strong> {exp.costCode.code} — {exp.costCode.name}</span>}
                                    <span className="text-hui-textMuted/60">
                                        Submitted {new Date(exp.createdAt).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
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
                                    {exp.estimate?.project && <span>{exp.estimate.project.name}</span>}
                                    {exp.qbPurchaseId && <span>QBO transaction {exp.qbPurchaseId}</span>}
                                    {exp.qbSyncedAt && <span>Imported {new Date(exp.qbSyncedAt).toLocaleString()}</span>}
                                </div>
                            </div>
                            <div className="shrink-0 text-xs font-semibold uppercase tracking-wide text-indigo-600">
                                QuickBooks import
                            </div>
                        </div>
                    </div>
                ))}
            </section>
        </div>
    );
}
