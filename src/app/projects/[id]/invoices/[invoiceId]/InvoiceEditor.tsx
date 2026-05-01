"use client";

import { useState } from "react";
import { recordPayment, issueInvoice, deleteInvoice, updateInvoiceNotes, addInvoiceMilestone, unrecordPayment, splitInvoiceMilestones, sendPaymentReceipt } from "@/lib/actions";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";
import SendInvoiceModal from "@/components/SendInvoiceModal";
import RecordPaymentModal from "@/components/RecordPaymentModal";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

const METHOD_LABELS: Record<string, string> = {
    card: "Card",
    ach: "ACH",
    check: "Check",
    cash: "Cash",
};

function formatPaymentMethod(method: string | null | undefined, ref: string | null | undefined): string {
    if (!method) return "";
    const label = METHOD_LABELS[method] ?? method.toUpperCase();
    if (method === "check" && ref) return `Check #${ref}`;
    if (ref) return `${label} · ${ref}`;
    return label;
}

export default function InvoiceEditor({ project, initialInvoice }: { project: any, initialInvoice: any }) {
    const router = useRouter();
    const [isIssuing, setIsIssuing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showSendModal, setShowSendModal] = useState(false);
    const [notes, setNotes] = useState(initialInvoice.notes || "");
    const [isSavingNotes, setIsSavingNotes] = useState(false);
    const [showAddMilestone, setShowAddMilestone] = useState(false);
    const [milestoneName, setMilestoneName] = useState("");
    const [milestoneAmount, setMilestoneAmount] = useState("");
    const [milestoneDueDate, setMilestoneDueDate] = useState<string>("");
    const [isAddingMilestone, setIsAddingMilestone] = useState(false);
    const [isUndoing, setIsUndoing] = useState<string | null>(null);
    const [recordingFor, setRecordingFor] = useState<{ id: string; name: string; amount: number } | null>(null);
    const [isSendingReceipt, setIsSendingReceipt] = useState<string | null>(null);

    // Split payments state
    type SplitRow = { id: number; name: string; amount: string };
    let splitNextId = 1;
    const [showSplit, setShowSplit] = useState(false);
    const [splitRows, setSplitRows] = useState<SplitRow[]>([{ id: splitNextId++, name: "", amount: "" }]);
    const [isSplitting, setIsSplitting] = useState(false);

    async function handleSendReceipt(paymentId: string) {
        setIsSendingReceipt(paymentId);
        try {
            const result = await sendPaymentReceipt(paymentId);
            if (result.success) {
                toast.success("Receipt sent");
                router.refresh();
            } else {
                toast.error(result.error || "Failed to send receipt");
            }
        } catch (e: any) {
            toast.error(e?.message || "Failed to send receipt");
        } finally {
            setIsSendingReceipt(null);
        }
    }

    async function handleAddMilestone() {
        const amount = Number(milestoneAmount);
        if (!milestoneName.trim()) {
            toast.error("Milestone name is required");
            return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            toast.error("Amount must be greater than zero");
            return;
        }
        setIsAddingMilestone(true);
        try {
            await addInvoiceMilestone(initialInvoice.id, {
                name: milestoneName.trim(),
                amount,
                dueDate: milestoneDueDate || null,
            });
            toast.success("Milestone added");
            setMilestoneName("");
            setMilestoneAmount("");
            setMilestoneDueDate("");
            setShowAddMilestone(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to add milestone");
        } finally {
            setIsAddingMilestone(false);
        }
    }

    async function handleSplit() {
        const valid = splitRows.filter((r) => r.name.trim() && parseFloat(r.amount) > 0);
        if (!valid.length) return;
        setIsSplitting(true);
        try {
            await splitInvoiceMilestones(
                initialInvoice.id,
                valid.map((r) => ({ name: r.name.trim(), amount: parseFloat(r.amount) })),
            );
            toast.success("Payment schedule updated");
            setShowSplit(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to update payment schedule");
        } finally {
            setIsSplitting(false);
        }
    }

    async function handleUnrecord(paymentId: string) {
        setIsUndoing(paymentId);
        try {
            await unrecordPayment(paymentId, initialInvoice.id);
            toast("Payment unrecorded");
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to unrecord payment");
        } finally {
            setIsUndoing(null);
        }
    }

    async function handleIssueInvoice() {
        setIsIssuing(true);
        try {
            await issueInvoice(initialInvoice.id);
            toast.success("Invoice issued");
            router.refresh();
        } catch (e) {
            console.error(e);
        } finally {
            setIsIssuing(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Are you sure you want to delete this invoice? This cannot be undone.")) return;
        setIsDeleting(true);
        try {
            const res = await deleteInvoice(initialInvoice.id);
            toast.success("Invoice deleted");
            router.push(`/projects/${res.projectId}/invoices`);
        } catch (e: any) {
            toast.error(e.message || "Cannot delete this invoice");
        } finally {
            setIsDeleting(false);
        }
    }

    async function handleSaveNotes() {
        setIsSavingNotes(true);
        try {
            await updateInvoiceNotes(initialInvoice.id, notes);
            toast.success("Notes saved");
        } catch (e: any) {
            toast.error("Failed to save notes");
        } finally {
            setIsSavingNotes(false);
        }
    }

    const clientName = initialInvoice.client?.name || project.client?.name || "Client";
    const clientEmail = initialInvoice.client?.email || project.client?.email || "";
    const projectLocation = project.location || "";
    const issueDate = initialInvoice.issueDate
        ? new Date(initialInvoice.issueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const createdDate = new Date(initialInvoice.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const sentDate = initialInvoice.sentAt
        ? new Date(initialInvoice.sentAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const viewedDate = initialInvoice.viewedAt
        ? new Date(initialInvoice.viewedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;

    const paidCount = (initialInvoice.payments || []).filter((p: any) => p.status === "Paid").length;
    const totalCount = (initialInvoice.payments || []).length;
    const canDelete = initialInvoice.status === "Draft" || (initialInvoice.status === "Issued" && paidCount === 0);

    return (
        <div className="flex flex-col h-full bg-hui-background">
            {/* Top Navigation */}
            <div className="bg-white border-b border-hui-border px-6 py-4 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <button onClick={() => router.push(`/projects/${project.id}/invoices`)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                        Back to Invoices
                    </button>
                    <div className="h-4 w-px bg-hui-border"></div>
                    <span className="text-sm font-medium text-hui-textMain">{initialInvoice.code}</span>
                    <StatusBadge status={initialInvoice.status} />
                    {paidCount > 0 && totalCount > 0 && (
                        <span className="text-xs text-hui-textMuted bg-slate-100 px-2 py-0.5 rounded-full">
                            {paidCount}/{totalCount} payments received
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {/* Portal Preview */}
                    <button
                        onClick={() => window.open(`/portal/invoices/${initialInvoice.id}`, '_blank')}
                        className="hui-btn hui-btn-secondary flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        Preview
                    </button>


                    {/* Delete - only if Draft/Issued with no payments */}
                    {canDelete && (
                        <button
                            onClick={handleDelete}
                            disabled={isDeleting}
                            className="hui-btn hui-btn-secondary text-red-600 border-red-200 hover:bg-red-50 flex items-center gap-2 disabled:opacity-50"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            {isDeleting ? "Deleting..." : "Delete"}
                        </button>
                    )}

                    {/* Issue button (draft only) */}
                    {initialInvoice.status === "Draft" && (
                        <button
                            onClick={handleIssueInvoice}
                            disabled={isIssuing}
                            className="hui-btn hui-btn-primary flex items-center gap-2 disabled:opacity-50"
                        >
                            {isIssuing ? "Issuing..." : "Issue Invoice"}
                        </button>
                    )}

                    {/* Send button */}
                    <button
                        onClick={() => setShowSendModal(true)}
                        className="hui-btn hui-btn-green flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        Send
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-8 flex justify-center">
                <div className="w-full max-w-5xl space-y-6">

                    {/* Document Header */}
                    <div className="hui-card overflow-hidden">
                        <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"></div>
                        <div className="p-8 space-y-6">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h1 className="text-3xl font-bold text-hui-textMain">Invoice</h1>
                                    <p className="text-sm text-hui-textMuted mt-1">{project.name}</p>
                                </div>
                                <div className="text-right">
                                    <StatusBadge status={initialInvoice.status} />
                                </div>
                            </div>

                            <div className="flex gap-12 text-sm">
                                <div>
                                    <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Bill To</p>
                                    <p className="font-semibold text-base text-hui-textMain">{clientName}</p>
                                    <p className="text-hui-textMuted">{clientEmail || "No email provided"}</p>
                                    {projectLocation && <p className="text-hui-textMuted mt-1">{projectLocation}</p>}
                                </div>
                                <div>
                                    <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Invoice Details</p>
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                                        <span className="text-hui-textMuted">Invoice #</span>
                                        <span className="text-right font-medium text-hui-textMain">{initialInvoice.code}</span>
                                        <span className="text-hui-textMuted">Created</span>
                                        <span className="text-right text-hui-textMain">{createdDate}</span>
                                        {issueDate && (
                                            <>
                                                <span className="text-hui-textMuted">Issued</span>
                                                <span className="text-right text-hui-textMain font-medium">{issueDate}</span>
                                            </>
                                        )}
                                        {sentDate && (
                                            <>
                                                <span className="text-hui-textMuted">Sent</span>
                                                <span className="text-right text-hui-textMain">{sentDate}</span>
                                            </>
                                        )}
                                        {viewedDate && (
                                            <>
                                                <span className="text-hui-textMuted">Viewed</span>
                                                <span className="text-right text-emerald-600 font-medium flex items-center justify-end gap-1">
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                                    {viewedDate}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="h-px w-full bg-hui-border my-4"></div>

                            <div className="flex justify-between items-center bg-slate-50 p-5 rounded-lg border border-hui-border">
                                <div>
                                    <p className="text-hui-textMuted text-sm mb-1">Total Amount</p>
                                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(initialInvoice.totalAmount)}</p>
                                </div>
                                <div className="text-center">
                                    <p className="text-hui-textMuted text-sm mb-1">Paid</p>
                                    <p className="text-2xl font-bold text-hui-primary">{formatCurrency(Number(initialInvoice.totalAmount || 0) - Number(initialInvoice.balanceDue || 0))}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-hui-textMuted text-sm mb-1">Balance Due</p>
                                    <p className={`text-2xl font-bold ${Number(initialInvoice.balanceDue) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatCurrency(initialInvoice.balanceDue)}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Notes */}
                    <div className="hui-card p-6">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="font-semibold text-hui-textMain flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                Notes
                            </h2>
                            <button
                                onClick={handleSaveNotes}
                                disabled={isSavingNotes}
                                className="hui-btn hui-btn-secondary text-xs py-1 px-3 disabled:opacity-50"
                            >
                                {isSavingNotes ? "Saving..." : "Save Notes"}
                            </button>
                        </div>
                        <textarea
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder="Add internal notes or payment instructions that will be visible to the client..."
                            className="hui-input w-full h-24 resize-none text-sm"
                        />
                    </div>

                    {/* Payments Schedule */}
                    <div className="hui-card overflow-hidden">
                        <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex justify-between items-center">
                            <h2 className="font-semibold text-hui-textMain flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                                Payment Schedule
                            </h2>
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-hui-textMuted">
                                    {paidCount} of {totalCount} paid
                                </span>
                                <button
                                    onClick={() => { setShowSplit(v => !v); setShowAddMilestone(false); }}
                                    className="hui-btn hui-btn-secondary text-xs py-1 px-3 flex items-center gap-1"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                                    {showSplit ? "Cancel" : "Split payments"}
                                </button>
                                <button
                                    onClick={() => { setShowAddMilestone(v => !v); setShowSplit(false); }}
                                    className="hui-btn hui-btn-secondary text-xs py-1 px-3 flex items-center gap-1"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                                    {showAddMilestone ? "Cancel" : "Add extra charge"}
                                </button>
                            </div>
                        </div>
                        {showSplit && (
                            <div className="px-6 py-4 border-b border-hui-border bg-blue-50/40">
                                <p className="text-xs text-hui-textMuted mb-3">
                                    Define how the balance is split into payment installments. Replaces existing pending milestones and recalculates the invoice total.
                                </p>
                                <div className="space-y-2 mb-3">
                                    <div className="grid grid-cols-[1fr_140px_32px] gap-2 px-1">
                                        <span className="text-[11px] uppercase tracking-wide text-hui-textMuted">Description</span>
                                        <span className="text-[11px] uppercase tracking-wide text-hui-textMuted">Amount</span>
                                        <span />
                                    </div>
                                    {splitRows.map((row) => (
                                        <div key={row.id} className="grid grid-cols-[1fr_140px_32px] gap-2 items-center">
                                            <input
                                                type="text"
                                                placeholder="e.g. Deposit, Final Payment"
                                                value={row.name}
                                                onChange={(e) => setSplitRows(prev => prev.map(r => r.id === row.id ? { ...r, name: e.target.value } : r))}
                                                className="hui-input text-sm"
                                            />
                                            <div className="relative">
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hui-textMuted text-sm">$</span>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    placeholder="0.00"
                                                    value={row.amount}
                                                    onChange={(e) => setSplitRows(prev => prev.map(r => r.id === row.id ? { ...r, amount: e.target.value } : r))}
                                                    className="hui-input text-sm pl-6 w-full"
                                                />
                                            </div>
                                            <button
                                                onClick={() => setSplitRows(prev => prev.filter(r => r.id !== row.id))}
                                                disabled={splitRows.length === 1}
                                                className="p-1 rounded text-hui-textMuted hover:text-red-500 hover:bg-red-50 disabled:opacity-30 transition"
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex items-center justify-between">
                                    <button
                                        onClick={() => setSplitRows(prev => [...prev, { id: Date.now(), name: "", amount: "" }])}
                                        className="text-xs text-hui-primary hover:underline flex items-center gap-1"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
                                        Add row
                                    </button>
                                    <button
                                        onClick={handleSplit}
                                        disabled={isSplitting || !splitRows.some(r => r.name.trim() && parseFloat(r.amount) > 0)}
                                        className="hui-btn hui-btn-primary text-sm disabled:opacity-50"
                                    >
                                        {isSplitting ? "Saving..." : "Apply schedule"}
                                    </button>
                                </div>
                            </div>
                        )}
                        {showAddMilestone && (
                            <div className="px-6 py-4 border-b border-hui-border bg-amber-50/40">
                                <div className="grid grid-cols-12 gap-3 items-end">
                                    <div className="col-span-5">
                                        <label className="block text-[11px] uppercase tracking-wide text-hui-textMuted mb-1">Description</label>
                                        <input
                                            type="text"
                                            value={milestoneName}
                                            onChange={e => setMilestoneName(e.target.value)}
                                            placeholder="e.g. Final Payment"
                                            className="hui-input w-full text-sm"
                                        />
                                    </div>
                                    <div className="col-span-3">
                                        <label className="block text-[11px] uppercase tracking-wide text-hui-textMuted mb-1">Amount ($)</label>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={milestoneAmount}
                                            onChange={e => setMilestoneAmount(e.target.value)}
                                            placeholder="0.00"
                                            className="hui-input w-full text-sm"
                                        />
                                    </div>
                                    <div className="col-span-3">
                                        <label className="block text-[11px] uppercase tracking-wide text-hui-textMuted mb-1">Due Date (optional)</label>
                                        <input
                                            type="date"
                                            value={milestoneDueDate}
                                            onChange={e => setMilestoneDueDate(e.target.value)}
                                            className="hui-input w-full text-sm"
                                        />
                                    </div>
                                    <div className="col-span-1">
                                        <button
                                            onClick={handleAddMilestone}
                                            disabled={isAddingMilestone}
                                            className="hui-btn hui-btn-primary text-sm w-full disabled:opacity-50"
                                        >
                                            {isAddingMilestone ? "..." : "Add"}
                                        </button>
                                    </div>
                                </div>
                                <p className="text-[11px] text-hui-textMuted mt-2">
                                    Adds a new payment milestone and increases the invoice total by this amount.
                                </p>
                            </div>
                        )}
                        <table className="w-full text-sm text-left">
                            <thead className="bg-white text-hui-textMuted border-b border-hui-border">
                                <tr>
                                    <th className="px-6 py-3 font-medium">Description</th>
                                    <th className="px-6 py-3 font-medium">Due Date</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Amount</th>
                                    <th className="px-6 py-3 font-medium text-right">Payment Date</th>
                                    <th className="px-6 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {(!initialInvoice.payments || initialInvoice.payments.length === 0) && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-12 text-center text-hui-textMuted">
                                            <div className="flex flex-col items-center">
                                                <svg className="w-10 h-10 mb-2 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                <p className="font-medium text-hui-textMain">No payment schedule</p>
                                                <p className="text-sm">This invoice has no payment milestones.</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {initialInvoice.payments?.map((payment: any) => {
                                    const isPastDue = payment.dueDate && new Date(payment.dueDate) < new Date() && payment.status !== "Paid";
                                    const methodLabel = formatPaymentMethod(payment.paymentMethod, payment.referenceNumber);
                                    const receiptSentLabel = payment.receiptSentAt
                                        ? `Last sent ${new Date(payment.receiptSentAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                                        : undefined;
                                    return (
                                        <tr key={payment.id} className={`hover:bg-slate-50 transition ${isPastDue ? 'bg-red-50/30' : ''}`}>
                                            <td className="px-6 py-4 font-medium text-hui-textMain">
                                                <div>{payment.name}</div>
                                                {payment.status === 'Paid' && methodLabel && (
                                                    <div className="text-[11px] text-hui-textMuted font-normal mt-0.5">{methodLabel}</div>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted">
                                                {payment.dueDate ? (
                                                    <span className={isPastDue ? 'text-red-600 font-medium' : ''}>
                                                        {new Date(payment.dueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                                        {isPastDue && <span className="ml-1 text-[10px] uppercase font-bold">overdue</span>}
                                                    </span>
                                                ) : 'Upon receipt'}
                                            </td>
                                            <td className="px-6 py-4">
                                                <StatusBadge status={payment.status} />
                                            </td>
                                            <td className="px-6 py-4 text-right font-medium text-hui-textMain">
                                                {formatCurrency(payment.amount)}
                                            </td>
                                            <td className="px-6 py-4 text-right text-hui-textMuted">
                                                {payment.paymentDate
                                                    ? new Date(payment.paymentDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                                                    : '—'}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <div className="flex items-center justify-end gap-2 flex-wrap">
                                                    {payment.status !== 'Paid' && (
                                                        <button
                                                            onClick={() => setRecordingFor({ id: payment.id, name: payment.name, amount: Number(payment.amount) })}
                                                            className="hui-btn hui-btn-primary py-1 px-3 text-xs w-auto h-8 flex items-center justify-center whitespace-nowrap"
                                                        >
                                                            Record Payment
                                                        </button>
                                                    )}
                                                    {payment.status === 'Paid' && (
                                                        <>
                                                            <button
                                                                onClick={() => handleSendReceipt(payment.id)}
                                                                disabled={isSendingReceipt === payment.id}
                                                                title={receiptSentLabel}
                                                                className="hui-btn hui-btn-secondary py-1 px-3 text-xs w-auto h-8 disabled:opacity-50 flex items-center justify-center whitespace-nowrap"
                                                            >
                                                                {isSendingReceipt === payment.id
                                                                    ? "Sending..."
                                                                    : payment.receiptSentAt ? "Resend Receipt" : "Send Receipt"}
                                                            </button>
                                                            <button
                                                                onClick={() => handleUnrecord(payment.id)}
                                                                disabled={isUndoing === payment.id}
                                                                className="text-xs text-hui-textMuted hover:text-red-600 underline underline-offset-2 disabled:opacity-50"
                                                                title="Mark as unpaid"
                                                            >
                                                                {isUndoing === payment.id ? "Undoing..." : "Undo"}
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                </div>
            </div>

            {/* Send Invoice Modal */}
            {showSendModal && (
                <SendInvoiceModal
                    invoiceId={initialInvoice.id}
                    clientEmail={clientEmail}
                    onClose={() => { setShowSendModal(false); router.refresh(); }}
                />
            )}

            {/* Record Payment Modal */}
            {recordingFor && (
                <RecordPaymentModal
                    milestoneName={recordingFor.name}
                    amount={recordingFor.amount}
                    onClose={() => setRecordingFor(null)}
                    onSubmit={async (input) => {
                        const result = await recordPayment(recordingFor.id, initialInvoice.id, { ...input, method: input.method as string });
                        if (result.success) router.refresh();
                        return { success: result.success, error: (result as any).error };
                    }}
                />
            )}
        </div>
    );
}
