"use client";

import { useState } from "react";
import { recordPayment } from "@/lib/actions";
import { useRouter } from "next/navigation";

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
        <div className="flex flex-col h-full bg-slate-50">
            {/* Top Navigation */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <button onClick={() => router.push(`/projects/${project.id}/invoices`)} className="text-slate-500 hover:text-slate-800 transition text-sm flex items-center gap-1">
                        ← Back to Invoices
                    </button>
                    <div className="h-4 w-px bg-slate-200"></div>
                    <span className="text-sm font-medium text-slate-800">{initialInvoice.code}</span>
                    <span className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-600 border border-slate-200">{initialInvoice.status}</span>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-8 flex justify-center">
                <div className="w-full max-w-5xl space-y-6">

                    {/* Document Header */}
                    <div className="bg-white p-8 rounded-lg shadow-sm border border-slate-200 space-y-6">
                        <h1 className="text-3xl font-bold text-slate-900">Invoice from {project.client?.name}</h1>

                        <div className="flex gap-12 text-sm">
                            <div>
                                <p className="text-slate-500 mb-1">Bill To</p>
                                <p className="font-medium text-slate-800">{project.client?.name}</p>
                                <p className="text-slate-600">{project.client?.email || "No email provided"}</p>
                                <p className="text-slate-600">{project.location}</p>
                            </div>
                            <div>
                                <p className="text-slate-500 mb-1">Invoice Details</p>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                    <label className="text-slate-600">Invoice #</label>
                                    <span className="text-right font-medium">{initialInvoice.code}</span>
                                    <label className="text-slate-600">Issue Date</label>
                                    <span className="text-right">{new Date(initialInvoice.createdAt).toLocaleDateString()}</span>
                                </div>
                            </div>
                        </div>

                        <div className="h-px w-full bg-slate-100 my-4"></div>

                        <div className="flex justify-between items-center bg-slate-50 p-4 rounded border border-slate-200">
                            <div>
                                <p className="text-slate-500 text-sm">Total Amount</p>
                                <p className="text-2xl font-bold text-slate-900">${(initialInvoice.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-slate-500 text-sm">Balance Due</p>
                                <p className="text-2xl font-bold text-blue-600">${(initialInvoice.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                            </div>
                        </div>
                    </div>

                    {/* Payments Schedule */}
                    <div className="bg-white shadow-sm border border-slate-200 rounded-lg overflow-hidden">
                        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                                Payments
                            </h2>
                        </div>
                        <table className="w-full text-sm text-left">
                            <thead className="bg-white text-slate-500 border-b border-slate-200">
                                <tr>
                                    <th className="px-6 py-3 font-medium">Payment Name</th>
                                    <th className="px-6 py-3 font-medium">Due Date</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Amount</th>
                                    <th className="px-6 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {initialInvoice.payments?.map((payment: any) => (
                                    <tr key={payment.id} className="hover:bg-slate-50 transition">
                                        <td className="px-6 py-4 font-medium text-slate-800">{payment.name}</td>
                                        <td className="px-6 py-4 text-slate-600">{payment.dueDate ? new Date(payment.dueDate).toLocaleDateString() : 'Upon receipt'}</td>
                                        <td className="px-6 py-4">
                                            <span className={`px-2 py-0.5 rounded text-xs border ${payment.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' :
                                                'bg-yellow-50 text-yellow-700 border-yellow-200'
                                                }`}>
                                                {payment.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right font-medium text-slate-800">
                                            ${(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </td>
                                        <td className="px-6 py-4 text-right flex items-center justify-end gap-2">
                                            {payment.status !== 'Paid' && (
                                                <>
                                                    <input
                                                        type="date"
                                                        className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-600 focus:outline-none focus:border-blue-500"
                                                        value={selectedDate}
                                                        onChange={(e) => setSelectedDate(e.target.value)}
                                                    />
                                                    <button
                                                        onClick={() => handleRecordPayment(payment.id)}
                                                        disabled={isRecording === payment.id}
                                                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition disabled:opacity-50 whitespace-nowrap"
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
