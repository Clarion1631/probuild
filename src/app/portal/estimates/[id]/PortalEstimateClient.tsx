"use client";

import React, { useState, useEffect, useRef } from "react";
import { approveEstimate, markEstimateViewed } from "@/lib/actions";
import SignaturePad from "@/components/SignaturePad";
import { formatCurrency } from "@/lib/utils";

export default function PortalEstimateClient({ initialEstimate, companySettings }: { initialEstimate: any, companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const viewedRef = useRef(false);

    useEffect(() => {
        if (viewedRef.current) return;
        viewedRef.current = true;
        markEstimateViewed(initialEstimate.id).catch(console.error);
    }, [initialEstimate.id]);

    const handleApprove = async () => {
        if (!signature.trim()) {
            setError("Please type your full legal name.");
            return;
        }
        if (!signatureDataUrl) {
            setError("Please draw your signature above.");
            return;
        }

        setIsSubmitting(true);
        setError("");
        try {
            const userAgent = window.navigator.userAgent;
            await approveEstimate(initialEstimate.id, signature.trim(), "Client IP", userAgent, signatureDataUrl);
            window.location.reload();
        } catch (e) {
            setError("Something went wrong processing your approval.");
        } finally {
            setIsSubmitting(false);
            setIsApproving(false);
        }
    };

    const calculateTotal = (item: any) => {
        if (item.subItems && item.subItems.length > 0) {
            return item.subItems.reduce((sum: number, subItem: any) => sum + Number(subItem.total || 0), 0);
        }
        return Number(item.total || 0);
    };

    const topLevelItems = initialEstimate.items.filter((i: any) => !i.parentId);
    const items = topLevelItems.map((parent: any) => {
        parent.subItems = initialEstimate.items.filter((i: any) => i.parentId === parent.id);
        return parent;
    });

    const subtotal = items.reduce((sum: number, item: any) => sum + calculateTotal(item), 0);
    const tax = subtotal * 0.087;
    const total = subtotal + tax;
    const isApproved = initialEstimate.status === "Approved";
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";

    return (
        <div className="min-h-screen bg-slate-100 font-sans">
            {/* Minimal Top Bar */}
            <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between print:hidden">
                <div className="flex items-center gap-3">
                    {companySettings?.logoUrl ? (
                        <img src={companySettings.logoUrl} alt={companyName} className="h-8 w-auto object-contain" />
                    ) : (
                        <img src="/logo.png" alt={companyName} className="h-8 w-auto object-contain" />
                    )}
                    <span className="text-sm text-slate-500">Estimate Portal</span>
                </div>
                {isApproved && (
                    <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Approved & Signed</span>
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
                                <h1 className="text-2xl font-bold text-slate-800 tracking-tight">ESTIMATE</h1>
                                <div className="mt-2 space-y-1 text-sm">
                                    <p className="text-slate-500">Estimate # <span className="font-semibold text-slate-700">{initialEstimate.code}</span></p>
                                    <p className="text-slate-500">Date: <span className="text-slate-700">{new Date(initialEstimate.createdAt).toLocaleDateString()}</span></p>
                                </div>
                                <div className="mt-3">
                                    {isApproved ? (
                                        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-xs font-bold bg-green-50 text-green-700 border border-green-200 uppercase tracking-wider">
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                            Approved
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
                                            Pending Approval
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Bill To */}
                        <div className="mt-8 pt-6 border-t border-slate-100">
                            <div className="grid grid-cols-2 gap-8">
                                <div>
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Prepared For</p>
                                    <p className="text-sm font-semibold text-slate-800">{initialEstimate.clientName || "Client"}</p>
                                    <p className="text-sm text-slate-500">{initialEstimate.title}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Project</p>
                                    <p className="text-sm font-semibold text-slate-800">{initialEstimate.title || "Project"}</p>
                                    <p className="text-sm text-slate-500">{initialEstimate.projectName || initialEstimate.leadName || ""}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Signed Badge */}
                    {isApproved && initialEstimate.approvedBy && (
                        <div className="mx-10 mt-6 p-5 bg-green-50 border border-green-200 rounded-lg">
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                                    <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-green-800">Electronically Signed and Approved</h3>
                                    <p className="text-sm text-green-700 mt-0.5">Signed by: <strong>{initialEstimate.approvedBy}</strong></p>
                                    <p className="text-xs text-green-600 mt-0.5">{new Date(initialEstimate.approvedAt).toLocaleString()}</p>
                                    <p className="text-xs text-green-700 mt-1 flex items-center gap-1.5"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg> A copy of the signed PDF has been sent to your email.</p>
                                </div>
                            </div>
                            {initialEstimate.signatureUrl && (
                                <div className="mt-4 pt-4 border-t border-green-200 flex flex-col items-start">
                                    <span className="text-[10px] text-green-600 uppercase font-semibold mb-2">Electronic Signature</span>
                                    <img src={initialEstimate.signatureUrl} alt="Signature" className="h-16 object-contain mix-blend-multiply" />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Line Items Table */}
                    <div className="px-10 py-8">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b-2 border-slate-200">
                                    <th className="text-left py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">Description</th>
                                    <th className="text-center py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider w-20">Qty</th>
                                    <th className="text-right py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider w-28">Unit Price</th>
                                    <th className="text-right py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider w-28">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {items.map((item: any) => {
                                    const hasSubItems = item.subItems && item.subItems.length > 0;
                                    const itemTotal = calculateTotal(item);
                                    return (
                                        <React.Fragment key={item.id}>
                                            <tr className={hasSubItems ? "bg-slate-50/50" : ""}>
                                                <td className="py-3">
                                                    <div className="font-medium text-slate-800">{item.name}</div>
                                                    {item.description && <div className="text-xs text-slate-500 mt-0.5">{item.description}</div>}
                                                </td>
                                                <td className="py-3 text-center text-slate-600">{!hasSubItems ? item.quantity : ""}</td>
                                                <td className="py-3 text-right text-slate-600">{!hasSubItems ? formatCurrency(item.unitCost) : ""}</td>
                                                <td className="py-3 text-right font-medium text-slate-800">{formatCurrency(itemTotal)}</td>
                                            </tr>
                                            {hasSubItems && item.subItems.map((sub: any) => (
                                                <tr key={sub.id}>
                                                    <td className="py-2.5 pl-6">
                                                        <div className="text-slate-600 flex items-center gap-1">
                                                            <span className="text-slate-300">└</span> {sub.name}
                                                        </div>
                                                        {sub.description && <div className="text-xs text-slate-400 ml-5 mt-0.5">{sub.description}</div>}
                                                    </td>
                                                    <td className="py-2.5 text-center text-slate-500">{sub.quantity}</td>
                                                    <td className="py-2.5 text-right text-slate-500">{formatCurrency(sub.unitCost)}</td>
                                                    <td className="py-2.5 text-right text-slate-700">{formatCurrency(sub.total)}</td>
                                                </tr>
                                            ))}
                                        </React.Fragment>
                                    );
                                })}
                            </tbody>
                        </table>

                        {/* Totals */}
                        <div className="flex justify-end mt-6">
                            <div className="w-72">
                                <div className="flex justify-between py-2 text-sm text-slate-600">
                                    <span>Subtotal</span>
                                    <span>{formatCurrency(subtotal)}</span>
                                </div>
                                <div className="flex justify-between py-2 text-sm text-slate-600">
                                    <span>Tax (8.7%)</span>
                                    <span>{formatCurrency(tax)}</span>
                                </div>
                                <div className="border-t-2 border-slate-800 mt-1 pt-2 flex justify-between text-lg font-bold text-slate-800">
                                    <span>Total</span>
                                    <span>{formatCurrency(total)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Payment Schedule */}
                    {initialEstimate.paymentSchedules && initialEstimate.paymentSchedules.length > 0 && (
                        <div className="px-10 pb-8">
                            <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3">Payment Schedule</h2>
                            <div className="border border-slate-200 rounded-md overflow-hidden">
                                {initialEstimate.paymentSchedules.map((p: any) => (
                                    <div key={p.id} className="flex justify-between items-center px-5 py-3 text-sm border-b last:border-b-0 border-slate-100">
                                        <div>
                                            <span className="font-medium text-slate-700">{p.name}</span>
                                            {p.percentage && <span className="text-slate-400 ml-1">({p.percentage}%)</span>}
                                        </div>
                                        <div className="flex gap-6 items-center">
                                            <span className="text-slate-500 text-xs">{p.dueDate ? new Date(p.dueDate).toLocaleDateString() : "TBD"}</span>
                                            <span className="font-semibold text-slate-800 w-24 text-right">{formatCurrency(p.amount)}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Terms & Conditions */}
                    {initialEstimate.termsAndConditions && (
                        <div className="px-10 pb-8 border-t border-slate-200 pt-8">
                            <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3">Terms & Conditions</h2>
                            <div className="bg-slate-50 rounded-md p-6 border border-slate-100">
                                <div
                                    className="prose prose-sm max-w-none text-slate-600 prose-headings:text-slate-800 prose-headings:font-semibold prose-headings:text-sm prose-strong:text-slate-700 prose-p:leading-relaxed prose-p:text-sm"
                                    dangerouslySetInnerHTML={{ __html: initialEstimate.termsAndConditions }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Signature / Approval Area */}
                    {!isApproved && (
                        <div className="px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8">
                                <div className="text-center max-w-lg mx-auto">
                                    <h3 className="text-lg font-bold text-slate-800 mb-2">Ready to Approve?</h3>
                                    <p className="text-sm text-slate-500 mb-6">
                                        By signing below, you accept this estimate{initialEstimate.termsAndConditions ? " and the attached Terms & Conditions" : ""}, and authorize work to proceed.
                                    </p>

                                    {!isApproving ? (
                                        <button
                                            onClick={() => setIsApproving(true)}
                                            className="px-8 py-3 bg-slate-800 text-white rounded-lg font-semibold text-sm hover:bg-slate-900 transition shadow-sm"
                                        >
                                            Sign & Approve Estimate
                                        </button>
                                    ) : (
                                        <div className="bg-slate-50 p-6 rounded-lg border border-slate-200 text-left">
                                            <h4 className="text-sm font-bold text-slate-800 mb-4">Electronic Signature</h4>

                                            <div className="space-y-4">
                                                <div>
                                                    <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">Draw Your Signature</label>
                                                    <SignaturePad onSignatureChange={setSignatureDataUrl} />
                                                </div>

                                                <div>
                                                    <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Full Legal Name</label>
                                                    <input
                                                        type="text"
                                                        value={signature}
                                                        onChange={(e) => setSignature(e.target.value)}
                                                        className="w-full px-4 py-2.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none transition"
                                                        placeholder="e.g. John A. Doe"
                                                        autoFocus
                                                    />
                                                </div>

                                                {error && <p className="text-red-600 text-xs font-medium">{error}</p>}

                                                <div className="bg-white border border-slate-200 rounded-md p-3">
                                                    <p className="text-[11px] text-slate-500 leading-relaxed">
                                                        <strong className="text-slate-700">ESIGN Act Disclosure:</strong> By signing above and clicking "Sign & Approve," I confirm that (1) my drawn signature and typed name constitute my legal electronic signature under the U.S. ESIGN Act (15 U.S.C. § 7001) and UETA, (2) I have reviewed and agree to the estimate{initialEstimate.termsAndConditions ? " and Terms & Conditions" : ""}, and (3) I authorize the described work.
                                                    </p>
                                                </div>

                                                <div className="flex gap-3 justify-end pt-1">
                                                    <button onClick={() => setIsApproving(false)} disabled={isSubmitting} className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition">
                                                        Cancel
                                                    </button>
                                                    <button
                                                        onClick={handleApprove}
                                                        disabled={isSubmitting}
                                                        className="px-6 py-2.5 bg-green-600 text-white rounded-lg font-semibold text-sm hover:bg-green-700 transition shadow-sm flex items-center gap-2"
                                                    >
                                                        {isSubmitting ? "Processing..." : "Sign & Approve"}
                                                        {!isSubmitting && (
                                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                                                        )}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Footer */}
                    <div className="bg-slate-50 border-t border-slate-200 px-10 py-4 text-center">
                        <p className="text-xs text-slate-400">
                            This estimate was prepared by {companyName}. {companyPhone && `Contact: ${companyPhone}.`} {companyEmail && `Email: ${companyEmail}.`}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
