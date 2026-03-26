"use client";

import { useState } from "react";
import { recordPayment, issueInvoice } from "@/lib/actions";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";

export default function InvoiceEditor({ project, initialInvoice }: { project: any, initialInvoice: any }) {
    const router = useRouter();
    const [isRecording, setIsRecording] = useState<string | null>(null);
    const [isIssuing, setIsIssuing] = useState(false);
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
            router.refresh();
        } catch (e) {
            console.error(e);
        } finally {
            setIsIssuing(false);
        }
    }

    const clientName = initialInvoice.client?.name || project.client?.name || "Client";
    const clientEmail = initialInvoice.client?.email || project.client?.email || "";
    const projectLocation = project.location || "";
    const issueDate = initialInvoice.issueDate
        ? new Date(initialInvoice.issueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const createdDate = new Date(initialInvoice.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const paidCount = (initialInvoice.payments || []).filter((p: any) => p.status === "Paid").length;
    const totalCount = (initialInvoice.payments || []).length;

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
                    {initialInvoice.status === "Draft" && (
                        <button
                            onClick={handleIssueInvoice}
                            disabled={isIssuing}
                            className="hui-btn hui-btn-green flex items-center gap-2 disabled:opacity-50"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                            {isIssuing ? "Issuing..." : "Issue Invoice"}
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-auto p-8 flex justify-center">
                <div className="w-full max-w-5xl space-y-6">

                    {/* Document Header */}
                    <div className="hui-card overflow-hidden">
                        {/* Accent bar */}
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
                                    </div>
                                </div>
                            </div>

                            <div className="h-px w-full bg-hui-border my-4"></div>

                            <div className="flex justify-between items-center bg-slate-50 p-5 rounded-lg border border-hui-border">
                                <div>
                                    <p className="text-hui-textMuted text-sm mb-1">Total Amount</p>
                                    <p className="text-2xl font-bold text-hui-textMain">${(initialInvoice.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                </div>
                                <div className="text-center">
                                    <p className="text-hui-textMuted text-sm mb-1">Paid</p>
                                    <p className="text-2xl font-bold text-hui-primary">${((initialInvoice.totalAmount || 0) - (initialInvoice.balanceDue || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-hui-textMuted text-sm mb-1">Balance Due</p>
                                    <p className={`text-2xl font-bold ${initialInvoice.balanceDue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>${(initialInvoice.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                </div>
                            </div>
                        </div>
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
                                                <p className="text-sm">This invoice has no line items yet.</p>
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
                                                ${(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
        </div>
    );
}
