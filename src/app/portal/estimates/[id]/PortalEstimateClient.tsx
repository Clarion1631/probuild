"use client";

import React, { useState, useEffect } from "react";
import { approveEstimate, markEstimateViewed } from "@/lib/actions";

export default function PortalEstimateClient({ initialEstimate, companySettings }: { initialEstimate: any, companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        markEstimateViewed(initialEstimate.id).catch(console.error);
    }, [initialEstimate.id]);

    const handleApprove = async () => {
        if (!signature.trim()) {
            setError("Please clearly type your full name to sign.");
            return;
        }

        setIsSubmitting(true);
        setError("");
        try {
            // In a real app we'd fetch the IP address here or from the server headers
            const userAgent = window.navigator.userAgent;
            await approveEstimate(initialEstimate.id, signature.trim(), "Client IP", userAgent);
            // The server action revalidates the path, which will automatically refetch the data
        } catch (e) {
            setError("Something went wrong processing your approval.");
        } finally {
            setIsSubmitting(false);
            setIsApproving(false);
        }
    };

    // Calculate totals based on hierarchical structure
    const calculateTotal = (item: any) => {
        if (item.subItems && item.subItems.length > 0) {
            return item.subItems.reduce((sum: number, subItem: any) => sum + (subItem.total || 0), 0);
        }
        return item.total || 0;
    };

    const topLevelItems = initialEstimate.items.filter((i: any) => !i.parentId);
    // Nest sub-items
    const items = topLevelItems.map((parent: any) => {
        parent.subItems = initialEstimate.items.filter((i: any) => i.parentId === parent.id);
        return parent;
    });

    const subtotal = items.reduce((sum: number, item: any) => sum + calculateTotal(item), 0);
    const tax = subtotal * 0.087; // 8.7% fake tax rate
    const total = subtotal + tax;

    const isApproved = initialEstimate.status === "Approved";

    return (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
            {/* Header section */}
            <div className="p-8 border-b border-slate-200">
                <div className="flex justify-between items-start">
                    <div>
                        {companySettings?.logoUrl && (
                            <img src={companySettings.logoUrl} alt="Company Logo" className="h-12 w-auto mb-4 object-contain print:h-10 print:mb-2" />
                        )}
                        <h1 className="text-3xl font-bold text-slate-900 mb-2">Estimate: {initialEstimate.title}</h1>
                        <p className="text-slate-500">From: {companySettings?.companyName || initialEstimate.projectName || initialEstimate.leadName}</p>
                        <p className="text-slate-500 mb-4">For: {initialEstimate.clientName}</p>
                        <a
                            href={`/api/pdf/${initialEstimate.id}`}
                            target="_blank"
                            className="print:hidden inline-flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded transition"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Download PDF
                        </a>
                    </div>
                    <div className="text-right">
                        <div className="text-sm text-slate-500 mb-1">Estimate #</div>
                        <div className="font-semibold text-slate-800">{initialEstimate.code}</div>
                        <div className="mt-2">
                            {isApproved ? (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                                    Approved
                                </span>
                            ) : (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                                    {initialEstimate.status}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {isApproved && initialEstimate.approvedBy && (
                    <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-md flex items-start gap-3">
                        <svg className="h-5 w-5 text-green-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div>
                            <h3 className="text-sm font-medium text-green-800">Electronically Signed and Approved</h3>
                            <div className="mt-1 text-sm text-green-700">
                                <p>Signed by: <strong>{initialEstimate.approvedBy}</strong></p>
                                <p>Date: {new Date(initialEstimate.approvedAt).toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Main Content */}
            <div className="p-8 space-y-8">
                {/* Items Table */}
                <div>
                    <h2 className="text-lg font-semibold text-slate-800 mb-4">Line Items</h2>
                    <div className="border border-slate-200 rounded-md overflow-hidden">
                        <table className="min-w-full divide-y divide-slate-200">
                            <thead className="bg-slate-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Item</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Qty</th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Cost</th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Total</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-slate-100">
                                {items.map((item: any) => {
                                    const hasSubItems = item.subItems && item.subItems.length > 0;
                                    const itemTotal = calculateTotal(item);

                                    return (
                                        <React.Fragment key={item.id}>
                                            <tr className={hasSubItems ? "bg-slate-50/50" : ""}>
                                                <td className="px-6 py-4">
                                                    <div className="font-medium text-slate-900">{item.name}</div>
                                                    {item.description && <div className="text-sm text-slate-500 mt-1">{item.description}</div>}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                                                    {!hasSubItems ? item.quantity : ""}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 text-right">
                                                    {!hasSubItems ? `$${item.unitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900 text-right">
                                                    ${itemTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </td>
                                            </tr>
                                            {/* Sub Items */}
                                            {hasSubItems && item.subItems.map((sub: any) => (
                                                <tr key={sub.id} className="bg-white">
                                                    <td className="px-6 py-3 pl-12 text-sm">
                                                        <div className="text-slate-700 flex items-center">
                                                            <svg className="w-4 h-4 text-slate-400 mr-2 -ml-6" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                                                            {sub.name}
                                                        </div>
                                                        {sub.description && <div className="text-slate-500 text-xs mt-1">{sub.description}</div>}
                                                    </td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-slate-500">{sub.quantity}</td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-slate-500 text-right">${sub.unitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-slate-600 text-right">${sub.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                </tr>
                                            ))}
                                        </React.Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Progress Payments */}
                {initialEstimate.paymentSchedules && initialEstimate.paymentSchedules.length > 0 && (
                    <div>
                        <h2 className="text-lg font-semibold text-slate-800 mb-4">Payment Schedule</h2>
                        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
                            <ul className="divide-y divide-slate-100">
                                {initialEstimate.paymentSchedules.map((payment: any) => (
                                    <li key={payment.id} className="px-6 py-4 flex justify-between items-center text-sm">
                                        <div>
                                            <span className="font-medium text-slate-900">{payment.name}</span>
                                            {payment.percentage && <span className="ml-2 text-slate-500">({payment.percentage}%)</span>}
                                        </div>
                                        <div className="flex gap-8 items-center text-slate-600 text-right">
                                            <span>{payment.dueDate ? new Date(payment.dueDate).toLocaleDateString() : 'TBD'}</span>
                                            <span className="font-semibold text-slate-900 w-24">${payment.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                {/* Totals Box */}
                <div className="flex justify-end pt-4">
                    <div className="w-80 space-y-3 bg-slate-50 p-6 rounded-lg border border-slate-200">
                        <div className="flex justify-between text-slate-600 text-sm">
                            <span>Subtotal</span>
                            <span>${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-slate-600 text-sm">
                            <span>Estimated Tax (8.7%)</span>
                            <span>${tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="h-px w-full bg-slate-200 my-2"></div>
                        <div className="flex justify-between text-lg font-bold text-slate-900">
                            <span>Estimate Total</span>
                            <span>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                    </div>
                </div>

                {/* Approval Area */}
                {!isApproved && (
                    <div className="mt-12 pt-8 border-t border-slate-200 flex flex-col items-center print:hidden">
                        <p className="text-slate-600 mb-6 text-center max-w-lg">Please review the details above. By approving this estimate, you agree to the terms and authorize work to proceed.</p>

                        {!isApproving ? (
                            <button
                                onClick={() => setIsApproving(true)}
                                className="px-8 py-3 bg-blue-600 text-white font-medium rounded-md shadow-sm hover:bg-blue-700 transition"
                            >
                                Approve & Sign Estimate
                            </button>
                        ) : (
                            <div className="w-full max-w-md bg-slate-50 p-6 rounded-lg border border-slate-200 shadow-sm">
                                <h3 className="text-lg font-semibold text-slate-900 mb-4">Finalize Approval</h3>

                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Electronic Signature (Type Full Name)</label>
                                        <input
                                            type="text"
                                            value={signature}
                                            onChange={(e) => setSignature(e.target.value)}
                                            className="w-full border border-slate-300 rounded px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 font-serif italic text-lg"
                                            placeholder="John Doe"
                                            autoFocus
                                        />
                                        {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
                                    </div>

                                    <p className="text-xs text-slate-500">I agree that my typed name above acts as my legal electronic signature and binds me to the terms of this estimate.</p>

                                    <div className="flex gap-3 justify-end pt-2">
                                        <button
                                            onClick={() => setIsApproving(false)}
                                            className="px-4 py-2 text-slate-600 hover:text-slate-900 font-medium text-sm transition"
                                            disabled={isSubmitting}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={handleApprove}
                                            disabled={isSubmitting}
                                            className="px-6 py-2 bg-green-600 text-white font-medium text-sm rounded transition hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                                        >
                                            {isSubmitting ? "Processing..." : "Sign & Agree"}
                                            {!isSubmitting && (
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                                                </svg>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
