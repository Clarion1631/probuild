"use client";

import { useState } from "react";
import { recordPayment } from "@/lib/actions";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";

export default function InvoiceEditor({ project, initialInvoice }: { project: any, initialInvoice: any }) {
    const router = useRouter();
    const [isRecording, setIsRecording] = useState<string | null>(null);
    const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);

    async function handleRecordPayment(paymentId: string) {
        setIsRecording(paymentId);
        await recordPayment(paymentId, initialInvoice.id, new Date(selectedDate).getTime());
        setIsRecording(null);
        router.refresh();
    }

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
                </div>
            </div>

            <div className="flex-1 overflow-auto p-8 flex justify-center">
                <div className="w-full max-w-5xl space-y-6">

                    {/* Document Header */}
                    <div className="hui-card p-8 space-y-6">
                        <h1 className="text-3xl font-bold text-hui-textMain">Invoice from {project.client?.name}</h1>

                        <div className="flex gap-12 text-sm">
                            <div>
                                <p className="text-hui-textMuted mb-1">Bill To</p>
                                <p className="font-medium text-hui-textMain">{project.client?.name}</p>
                                <p className="text-hui-textMuted">{project.client?.email || "No email provided"}</p>
                                <p className="text-hui-textMuted">{project.location}</p>
                            </div>
                            <div>
                                <p className="text-hui-textMuted mb-1">Invoice Details</p>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                    <label className="text-hui-textMuted">Invoice #</label>
                                    <span className="text-right font-medium text-hui-textMain">{initialInvoice.code}</span>
                                    <label className="text-hui-textMuted">Issue Date</label>
                                    <span className="text-right text-hui-textMain">{new Date(initialInvoice.createdAt).toLocaleDateString()}</span>
                                </div>
                            </div>
                        </div>

                        <div className="h-px w-full bg-hui-border my-4"></div>

                        <div className="flex justify-between items-center bg-slate-50 p-4 rounded border border-hui-border">
                            <div>
                                <p className="text-hui-textMuted text-sm mb-1">Total Amount</p>
                                <p className="text-2xl font-bold text-hui-textMain">${(initialInvoice.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-hui-textMuted text-sm mb-1">Balance Due</p>
                                <p className="text-2xl font-bold text-red-600">${(initialInvoice.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                            </div>
                        </div>
                    </div>

                    {/* Payments Schedule */}
                    <div className="hui-card overflow-hidden">
                        <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex justify-between items-center">
                            <h2 className="font-semibold text-hui-textMain flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                                Line Items / Payment Schedule
                            </h2>
                        </div>
                        <table className="w-full text-sm text-left">
                            <thead className="bg-white text-hui-textMuted border-b border-hui-border">
                                <tr>
                                    <th className="px-6 py-3 font-medium">Description</th>
                                    <th className="px-6 py-3 font-medium">Due Date</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Amount</th>
                                    <th className="px-6 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {initialInvoice.payments?.map((payment: any) => (
                                    <tr key={payment.id} className="hover:bg-slate-50 transition">
                                        <td className="px-6 py-4 font-medium text-hui-textMain">{payment.name}</td>
                                        <td className="px-6 py-4 text-hui-textMuted">{payment.dueDate ? new Date(payment.dueDate).toLocaleDateString() : 'Upon receipt'}</td>
                                        <td className="px-6 py-4">
                                            <StatusBadge status={payment.status} />
                                        </td>
                                        <td className="px-6 py-4 text-right font-medium text-hui-textMain">
                                            ${(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                </div>
            </div>
        </div>
    );
}
