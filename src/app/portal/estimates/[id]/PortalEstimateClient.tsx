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
        <div className="hui-card overflow-hidden">
            {/* Header section */}
            <div className="p-8 border-b border-hui-border">
                <div className="flex justify-between items-start">
                    <div>
                        {companySettings?.logoUrl && (
                            <img src={companySettings.logoUrl} alt="Company Logo" className="h-12 w-auto mb-4 object-contain print:h-10 print:mb-2" />
                        )}
                        <h1 className="text-3xl font-bold text-hui-textMain mb-2">Estimate: {initialEstimate.title}</h1>
                        <p className="text-hui-textMuted">From: {companySettings?.companyName || initialEstimate.projectName || initialEstimate.leadName}</p>
                        <p className="text-hui-textMuted mb-4">For: {initialEstimate.clientName}</p>
                        <a
                            href={`/api/pdf/${initialEstimate.id}`}
                            target="_blank"
                            className="print:hidden inline-flex items-center gap-2 hui-btn hui-btn-secondary"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Download PDF
                        </a>
                    </div>
                    <div className="text-right">
                        <div className="text-sm text-hui-textMuted mb-1">Estimate #</div>
                        <div className="font-semibold text-hui-textMain">{initialEstimate.code}</div>
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
                    <h2 className="text-lg font-semibold text-hui-textMain mb-4">Line Items</h2>
                    <div className="border border-hui-border rounded-md overflow-hidden">
                        <table className="min-w-full divide-y divide-hui-border">
                            <thead className="bg-hui-background">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-hui-textMuted uppercase tracking-wider">Item</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-hui-textMuted uppercase tracking-wider">Qty</th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-hui-textMuted uppercase tracking-wider">Cost</th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-hui-textMuted uppercase tracking-wider">Total</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-hui-border">
                                {items.map((item: any) => {
                                    const hasSubItems = item.subItems && item.subItems.length > 0;
                                    const itemTotal = calculateTotal(item);

                                    return (
                                        <React.Fragment key={item.id}>
                                            <tr className={hasSubItems ? "bg-slate-50/50" : ""}>
                                                <td className="px-6 py-4">
                                                    <div className="font-medium text-hui-textMain">{item.name}</div>
                                                    {item.description && <div className="text-sm text-hui-textMuted mt-1">{item.description}</div>}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-hui-textMuted">
                                                    {!hasSubItems ? item.quantity : ""}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-hui-textMuted text-right">
                                                    {!hasSubItems ? `$${item.unitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-hui-textMain text-right">
                                                    ${itemTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </td>
                                            </tr>
                                            {/* Sub Items */}
                                            {hasSubItems && item.subItems.map((sub: any) => (
                                                <tr key={sub.id} className="bg-white">
                                                    <td className="px-6 py-3 pl-12 text-sm">
                                                        <div className="text-hui-textMain flex items-center">
                                                            <svg className="w-4 h-4 text-hui-textMuted mr-2 -ml-6" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                                                            {sub.name}
                                                        </div>
                                                        {sub.description && <div className="text-hui-textMuted text-xs mt-1">{sub.description}</div>}
                                                    </td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-hui-textMuted">{sub.quantity}</td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-hui-textMuted text-right">${sub.unitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-hui-textMain text-right">${sub.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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
                        <h2 className="text-lg font-semibold text-hui-textMain mb-4">Payment Schedule</h2>
                        <div className="border border-hui-border rounded-md overflow-hidden bg-white">
                            <ul className="divide-y divide-hui-border">
                                {initialEstimate.paymentSchedules.map((payment: any) => (
                                    <li key={payment.id} className="px-6 py-4 flex justify-between items-center text-sm">
                                        <div>
                                            <span className="font-medium text-hui-textMain">{payment.name}</span>
                                            {payment.percentage && <span className="ml-2 text-hui-textMuted">({payment.percentage}%)</span>}
                                        </div>
                                        <div className="flex gap-8 items-center text-hui-textMuted text-right">
                                            <span>{payment.dueDate ? new Date(payment.dueDate).toLocaleDateString() : 'TBD'}</span>
                                            <span className="font-semibold text-hui-textMain w-24">${payment.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                {/* Totals Box */}
                <div className="flex justify-end pt-4">
                    <div className="w-80 space-y-3 bg-hui-background p-6 rounded-lg border border-hui-border">
                        <div className="flex justify-between text-hui-textMuted text-sm">
                            <span>Subtotal</span>
                            <span>${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-hui-textMuted text-sm">
                            <span>Estimated Tax (8.7%)</span>
                            <span>${tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="h-px w-full bg-hui-border my-2"></div>
                        <div className="flex justify-between text-lg font-bold text-hui-textMain">
                            <span>Estimate Total</span>
                            <span>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                    </div>
                </div>

                {/* Approval Area */}
                {!isApproved && (
                    <div className="mt-12 pt-8 border-t border-hui-border flex flex-col items-center print:hidden">
                        <p className="text-hui-textMuted mb-6 text-center max-w-lg">Please review the details above. By approving this estimate, you agree to the terms and authorize work to proceed.</p>

                        {!isApproving ? (
                            <button
                                onClick={() => setIsApproving(true)}
                                className="hui-btn hui-btn-primary px-8 py-3"
                            >
                                Approve & Sign Estimate
                            </button>
                        ) : (
                            <div className="w-full max-w-md bg-hui-background p-6 rounded-lg border border-hui-border shadow-sm">
                                <h3 className="text-lg font-semibold text-hui-textMain mb-4">Finalize Approval</h3>

                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-hui-textMuted mb-1">Electronic Signature (Type Full Name)</label>
                                        <input
                                            type="text"
                                            value={signature}
                                            onChange={(e) => setSignature(e.target.value)}
                                            className="hui-input w-full font-serif italic text-lg"
                                            placeholder="John Doe"
                                            autoFocus
                                        />
                                        {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
                                    </div>

                                    <p className="text-xs text-hui-textMuted">I agree that my typed name above acts as my legal electronic signature and binds me to the terms of this estimate.</p>

                                    <div className="flex gap-3 justify-end pt-2">
                                        <button
                                            onClick={() => setIsApproving(false)}
                                            className="hui-btn hui-btn-secondary px-4 py-2"
                                            disabled={isSubmitting}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={handleApprove}
                                            disabled={isSubmitting}
                                            className="hui-btn hui-btn-green px-6 py-2 flex items-center gap-2"
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
