"use client";

import React, { useState, useEffect } from "react";
import { markInvoiceViewed } from "@/lib/actions";

export default function PortalInvoiceClient({ initialInvoice, companySettings }: { initialInvoice: any, companySettings?: any }) {
    const [isPayingId, setIsPayingId] = useState<string | null>(null);

    useEffect(() => {
        markInvoiceViewed(initialInvoice.id).catch(console.error);
    }, [initialInvoice.id]);

    async function handlePay(paymentScheduleId: string) {
        setIsPayingId(paymentScheduleId);
        try {
            const res = await fetch("/api/payments/create-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    invoiceId: initialInvoice.id,
                    paymentScheduleId,
                }),
            });
            if (!res.ok) {
                const errText = await res.text();
                console.error("Payment session error:", errText);
                alert(`Unable to start payment:\n\n${errText}`);
                return;
            }
            const data = await res.json();
            if (data.url) {
                window.location.href = data.url;
            }
        } catch (err) {
            console.error("Payment error:", err);
            alert("Something went wrong. Please try again.");
        } finally {
            setIsPayingId(null);
        }
    }

    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";
    const isPaid = initialInvoice.status === "Paid";
    const totalPaid = (initialInvoice.totalAmount || 0) - (initialInvoice.balanceDue || 0);

    return (
        <div className="min-h-screen bg-slate-100 font-sans">
            {/* Top Bar */}
            <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between print:hidden">
                <div className="flex items-center gap-3">
                    {companySettings?.logoUrl ? (
                        <img src={companySettings.logoUrl} alt={companyName} className="h-8 w-auto object-contain" />
                    ) : (
                        <img src="/logo.png" alt={companyName} className="h-8 w-auto object-contain" />
                    )}
                    <span className="text-sm text-slate-500">Invoice Portal</span>
                </div>
                {isPaid && (
                    <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Paid in Full</span>
                )}
            </header>

            {/* Document Container */}
            <div className="max-w-4xl mx-auto py-8 px-4 print:py-0 print:px-0">
                <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden print:shadow-none print:border-none print:rounded-none">

                    {/* Document Header */}
                    <div className="px-10 pt-10 pb-8 border-b border-slate-200">
                        <div className="flex justify-between items-start">
                            <div>
                                {companySettings?.logoUrl ? (
                                    <img src={companySettings.logoUrl} alt={companyName} className="h-14 w-auto object-contain mb-3" />
                                ) : (
                                    <img src="/logo.png" alt={companyName} className="h-14 w-auto object-contain mb-3" />
                                )}
                                <h2 className="text-lg font-bold text-slate-800">{companyName}</h2>
                                {companyAddress && <p className="text-sm text-slate-500">{companyAddress}</p>}
                                {companyPhone && <p className="text-sm text-slate-500">{companyPhone}</p>}
                                {companyEmail && <p className="text-sm text-slate-500">{companyEmail}</p>}
                            </div>
                            <div className="text-right">
                                <h1 className="text-2xl font-bold text-slate-800 tracking-tight">INVOICE</h1>
                                <div className="mt-2 space-y-1 text-sm">
                                    <p className="text-slate-500">Invoice # <span className="font-semibold text-slate-700">{initialInvoice.code}</span></p>
                                    <p className="text-slate-500">Date: <span className="text-slate-700">
                                        {initialInvoice.issueDate
                                            ? new Date(initialInvoice.issueDate).toLocaleDateString()
                                            : new Date(initialInvoice.createdAt).toLocaleDateString()}
                                    </span></p>
                                </div>
                                <div className="mt-3">
                                    {isPaid ? (
                                        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-xs font-bold bg-green-50 text-green-700 border border-green-200 uppercase tracking-wider">
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                            Paid
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
                                            Payment Due
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Bill To */}
                        <div className="mt-8 pt-6 border-t border-slate-100">
                            <div className="grid grid-cols-2 gap-8">
                                <div>
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Bill To</p>
                                    <p className="text-sm font-semibold text-slate-800">{initialInvoice.clientName}</p>
                                    {initialInvoice.clientEmail && <p className="text-sm text-slate-500">{initialInvoice.clientEmail}</p>}
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Project</p>
                                    <p className="text-sm font-semibold text-slate-800">{initialInvoice.projectName || "Project"}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Amount Summary */}
                    <div className="px-10 py-8 bg-slate-50 border-b border-slate-200">
                        <div className="flex justify-between items-center">
                            <div>
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Total Amount</p>
                                <p className="text-2xl font-bold text-slate-800">${(initialInvoice.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div className="text-center">
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Paid</p>
                                <p className="text-2xl font-bold text-green-600">${totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Balance Due</p>
                                <p className={`text-2xl font-bold ${initialInvoice.balanceDue > 0 ? 'text-red-600' : 'text-green-600'}`}>
                                    ${(initialInvoice.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Notes */}
                    {initialInvoice.notes && (
                        <div className="px-10 py-6 border-b border-slate-200">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Notes</p>
                            <p className="text-sm text-slate-600 whitespace-pre-wrap">{initialInvoice.notes}</p>
                        </div>
                    )}

                    {/* Payment Schedule */}
                    {initialInvoice.payments && initialInvoice.payments.length > 0 && (
                        <div className="px-10 py-8">
                            <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-4">Payment Schedule</h2>
                            <div className="space-y-3">
                                {initialInvoice.payments.map((payment: any) => {
                                    const isPaidItem = payment.status === "Paid";
                                    const isPastDue = payment.dueDate && new Date(payment.dueDate) < new Date() && !isPaidItem;

                                    return (
                                        <div
                                            key={payment.id}
                                            className={`flex items-center justify-between px-5 py-4 rounded-lg border ${
                                                isPaidItem
                                                    ? 'bg-green-50 border-green-200'
                                                    : isPastDue
                                                    ? 'bg-red-50 border-red-200'
                                                    : 'bg-white border-slate-200'
                                            }`}
                                        >
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-slate-800">{payment.name}</span>
                                                    {isPaidItem && (
                                                        <span className="text-[10px] font-bold uppercase text-green-700 bg-green-100 px-1.5 py-0.5 rounded">Paid</span>
                                                    )}
                                                    {isPastDue && (
                                                        <span className="text-[10px] font-bold uppercase text-red-700 bg-red-100 px-1.5 py-0.5 rounded">Overdue</span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-slate-500 mt-0.5">
                                                    {payment.dueDate
                                                        ? `Due: ${new Date(payment.dueDate).toLocaleDateString()}`
                                                        : 'Due upon receipt'}
                                                    {isPaidItem && payment.paymentDate && (
                                                        <span className="ml-2">• Paid {new Date(payment.paymentDate).toLocaleDateString()}</span>
                                                    )}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-4">
                                                <span className="font-semibold text-slate-800 text-lg">
                                                    ${(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                </span>
                                                {!isPaidItem && (
                                                    <button
                                                        onClick={() => handlePay(payment.id)}
                                                        disabled={isPayingId !== null}
                                                        className="px-5 py-2.5 bg-slate-800 text-white rounded-lg font-semibold text-sm hover:bg-slate-900 transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                                                    >
                                                        {isPayingId === payment.id ? "Redirecting..." : "Pay Now"}
                                                    </button>
                                                )}
                                                {isPaidItem && (
                                                    <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                                                        <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Footer */}
                    <div className="bg-slate-50 border-t border-slate-200 px-10 py-4 text-center">
                        <p className="text-xs text-slate-400">
                            This invoice was prepared by {companyName}. {companyPhone && `Contact: ${companyPhone}.`} {companyEmail && `Email: ${companyEmail}.`}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
