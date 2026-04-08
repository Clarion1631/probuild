"use client";

import React, { useState } from "react";
import { approveChangeOrder } from "@/lib/actions";
import SignaturePad from "@/components/SignaturePad";
import Link from "next/link";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

export default function PortalChangeOrderClient({ initialData, companySettings }: { initialData: any, companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");

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
            await approveChangeOrder(initialData.id, signature.trim(), userAgent, signatureDataUrl);
            toast.success("Change Order Approved!");
            window.location.reload();
        } catch (e: any) {
            setError(e.message || "Something went wrong processing your approval.");
        } finally {
            setIsSubmitting(false);
            setIsApproving(false);
        }
    };

    const isApproved = initialData.status === "Approved";
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";

    const items = initialData.items || [];
    const subtotal = items.reduce((acc: number, item: any) => acc + (Number(item.quantity || 0) * Number(item.unitCost || 0)), 0);
    const tax = subtotal * 0.088;
    const total = subtotal + tax;

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
                    <span className="text-sm text-slate-500">Change Order Portal</span>
                </div>
                <div className="flex items-center gap-4">
                    <Link href={`/portal/projects/${initialData.projectId}`} className="text-sm text-blue-600 hover:underline">
                        Back to Portal
                    </Link>
                    {isApproved && (
                        <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Approved & Signed</span>
                    )}
                </div>
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
                                <h1 className="text-2xl font-bold text-slate-800 tracking-tight uppercase text-amber-600">CHANGE ORDER</h1>
                                <div className="mt-2 text-sm text-slate-600 space-y-1">
                                    <p>CO # <span className="font-semibold text-slate-800">{initialData.code}</span></p>
                                    <p>Date: <span className="font-medium text-slate-800">{new Date(initialData.createdAt).toLocaleDateString()}</span></p>
                                    {initialData.estimate && (
                                        <p>Original Est: <span className="font-medium text-slate-800">{initialData.estimate.code}</span></p>
                                    )}
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
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Change Order For</p>
                                    <p className="text-sm font-semibold text-slate-800">{initialData.project?.client?.name || "Client"}</p>
                                    <p className="text-sm font-medium text-slate-600">{initialData.title}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Project</p>
                                    <p className="text-sm font-semibold text-slate-800">{initialData.project?.name || "Project"}</p>
                                    <p className="text-sm text-slate-500">{initialData.project?.location || ""}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Memo / Description */}
                    {initialData.description && (
                        <div className="px-10 py-8 border-b border-slate-100">
                            <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3">Reason for Change</h2>
                            <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{initialData.description}</p>
                        </div>
                    )}

                    {/* Signed Badge */}
                    {isApproved && initialData.approvedBy && (
                        <div className="mx-10 mt-6 p-5 bg-green-50 border border-green-200 rounded-lg">
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                                    <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-green-800">Electronically Signed and Approved</h3>
                                    <p className="text-sm text-green-700 mt-0.5">Signed by: <strong>{initialData.approvedBy}</strong></p>
                                    <p className="text-xs text-green-600 mt-0.5">{new Date(initialData.approvedAt).toLocaleString()}</p>
                                </div>
                            </div>
                            {initialData.clientSignatureUrl && (
                                <div className="mt-4 pt-4 border-t border-green-200 flex flex-col items-start">
                                    <span className="text-[10px] text-green-600 uppercase font-semibold mb-2">Electronic Signature</span>
                                    <img src={initialData.clientSignatureUrl} alt="Signature" className="h-16 object-contain mix-blend-multiply" />
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
                                    const itemTotal = Number(item.quantity || 0) * Number(item.unitCost || 0);
                                    return (
                                        <tr key={item.id}>
                                            <td className="py-3">
                                                <div className="font-medium text-slate-800">{item.name}</div>
                                            </td>
                                            <td className="py-3 text-center text-slate-600">{item.quantity}</td>
                                            <td className="py-3 text-right text-slate-600">{formatCurrency(item.unitCost)}</td>
                                            <td className="py-3 text-right font-medium text-slate-800">{formatCurrency(itemTotal)}</td>
                                        </tr>
                                    );
                                })}
                                {items.length === 0 && (
                                    <tr><td colSpan={4} className="py-6 text-center text-slate-400">No items specified for this Change Order.</td></tr>
                                )}
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
                                    <span>Tax (8.8%)</span>
                                    <span>{formatCurrency(tax)}</span>
                                </div>
                                <div className="border-t-2 border-slate-800 mt-1 pt-2 flex justify-between text-lg font-bold text-amber-600">
                                    <span>Revised Amount</span>
                                    <span>{formatCurrency(total)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Signature / Approval Area */}
                    {!isApproved && (
                        <div className="px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8">
                                <div className="text-center max-w-lg mx-auto">
                                    <h3 className="text-lg font-bold text-slate-800 mb-2">Ready to Approve?</h3>
                                    <p className="text-sm text-slate-500 mb-6">
                                        By signing below, you authorize the project modifications and budget adjustments outlined in this Change Order.
                                    </p>

                                    {!isApproving ? (
                                        <button
                                            onClick={() => setIsApproving(true)}
                                            className="px-8 py-3 bg-amber-600 text-white rounded-lg font-semibold text-sm hover:bg-amber-700 transition shadow-sm"
                                        >
                                            Sign & Approve Change Order
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
                                                        <strong className="text-slate-700">ESIGN Act Disclosure:</strong> By signing above and clicking "Sign & Approve," I confirm that (1) my drawn signature and typed name constitute my legal electronic signature under the U.S. ESIGN Act (15 U.S.C. § 7001) and UETA, (2) I have reviewed and agree to the modifications, and (3) I authorize the described work and payment adjustments.
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
                </div>
            </div>
        </div>
    );
}
