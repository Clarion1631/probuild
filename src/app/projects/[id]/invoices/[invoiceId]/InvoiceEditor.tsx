"use client";

import { useState } from "react";
import { recordPayment, issueInvoice, deleteInvoice, updateInvoiceNotes } from "@/lib/actions";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";
import SendInvoiceModal from "@/components/SendInvoiceModal";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

export default function InvoiceEditor({ project, initialInvoice }: { project: any, initialInvoice: any }) {
    const router = useRouter();
    const [isRecording, setIsRecording] = useState<string | null>(null);
    const [isIssuing, setIsIssuing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showSendModal, setShowSendModal] = useState(false);
    const [notes, setNotes] = useState(initialInvoice.notes || "");
    const [isSavingNotes, setIsSavingNotes] = useState(false);
    const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);

    async function handleRecordPayment(paymentId: string) {
        setIsRecording(paymentId);
        await recordPayment(paymentId, initialInvoice.id, new Date(selectedDate).getTime());
        setIsRecording(null);
        router.refresh();
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

                    {/* PDF buttons */}
                    <a
                        href={`/api/pdf/invoices/${initialInvoice.id}?inline=true`}
                        target="_blank"
                        rel="noreferrer"
                        className="hui-btn hui-btn-secondary flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                        Preview PDF
                    </a>
                    <a
                        href={`/api/pdf/invoices/${initialInvoice.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hui-btn hui-btn-secondary flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Download PDF
                    </a>

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
                            <span className="text-xs text-hui-textMuted">
                                {paidCount} of {totalCount} paid
                            </span>
                        </div>
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
                                    return (
                                        <tr key={payment.id} className={`hover:bg-slate-50 transition ${isPastDue ? 'bg-red-50/30' : ''}`}>
                                            <td className="px-6 py-4 font-medium text-hui-textMain">{payment.name}</td>
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
                                            <td className="px-6 py-4 text-right flex items-center justify-end gap-2">
                                                {payment.status !== 'Paid' && (
                                                    <>
                                                        <input
                                                            type="date"
                                                            className="hui-input py-1 px-2 text-xs w-auto h-8"
                                                            value={selectedDate}
                                                            onChange={(e) => setSelectedDate(e.target.value)}
                                                        />
                                                        <button
                                                            onClick={() => handleRecordPayment(payment.id)}
                                                            disabled={isRecording === payment.id}
                                                            className="hui-btn hui-btn-primary py-1 px-3 text-xs w-auto h-8 disabled:opacity-50 flex items-center justify-center whitespace-nowrap"
                                                        >
                                                            {isRecording === payment.id ? "Recording..." : "Record Payment"}
                                                        </button>
                                                    </>
                                                )}
                                                {payment.status === 'Paid' && (
                                                    <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                                                        Paid
                                                    </span>
                                                )}
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
        </div>
    );
}
