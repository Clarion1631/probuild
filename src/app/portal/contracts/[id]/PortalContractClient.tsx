"use client";

import React, { useState, useEffect } from "react";
import { approveContract, markContractViewed } from "@/lib/actions";
import SignaturePad from "@/components/SignaturePad";

export default function PortalContractClient({ initialContract, companySettings }: { initialContract: any; companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");

    const isSigned = initialContract.status === "Signed";
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";

    useEffect(() => {
        markContractViewed(initialContract.id).catch(console.error);
    }, [initialContract.id]);

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
            await approveContract(initialContract.id, signature.trim(), "Client IP", userAgent, signatureDataUrl);
            window.location.reload();
        } catch (e) {
            setError("Something went wrong processing your approval.");
        } finally {
            setIsSubmitting(false);
            setIsApproving(false);
        }
    };

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
                    <span className="text-sm text-slate-500">Contract Portal</span>
                </div>
                {isSigned && (
                    <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Signed</span>
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
                                <h1 className="text-2xl font-bold text-slate-800 tracking-tight">CONTRACT</h1>
                                <div className="mt-2 space-y-1 text-sm">
                                    <p className="text-slate-500">Date: <span className="text-slate-700">{initialContract.sentAt ? new Date(initialContract.sentAt).toLocaleDateString() : new Date(initialContract.createdAt).toLocaleDateString()}</span></p>
                                </div>
                                <div className="mt-3">
                                    {isSigned ? (
                                        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-xs font-bold bg-green-50 text-green-700 border border-green-200 uppercase tracking-wider">
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                            Executed
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
                                            Pending Signature
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Signed Badge */}
                    {isSigned && initialContract.approvedBy && (
                        <div className="mx-10 mt-6 p-5 bg-green-50 border border-green-200 rounded-lg">
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                                    <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-green-800">Contract Executed — Electronically Signed</h3>
                                    <p className="text-sm text-green-700 mt-0.5">Signed by: <strong>{initialContract.approvedBy}</strong></p>
                                    <p className="text-xs text-green-600 mt-0.5">{new Date(initialContract.approvedAt).toLocaleString()}</p>
                                </div>
                            </div>
                            {initialContract.signatureUrl && (
                                <div className="mt-3 pt-3 border-t border-green-200">
                                    <img src={initialContract.signatureUrl} alt="Signature" className="h-12 object-contain" />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Contract Title */}
                    <div className="px-10 pt-8 pb-2">
                        <h2 className="text-xl font-bold text-slate-800 text-center">{initialContract.title}</h2>
                        <div className="w-16 h-0.5 bg-slate-300 mx-auto mt-3"></div>
                    </div>

                    {/* Contract Body */}
                    <div className="px-10 py-8">
                        <div
                            className="prose prose-sm max-w-none text-slate-700 prose-headings:text-slate-800 prose-headings:font-semibold prose-h2:text-lg prose-h3:text-base prose-p:leading-relaxed prose-p:text-sm prose-strong:text-slate-800 prose-li:text-sm"
                            dangerouslySetInnerHTML={{ __html: initialContract.body }}
                        />
                    </div>

                    {/* Signature / Approval Area */}
                    {!isSigned && (
                        <div className="px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8">
                                <div className="text-center max-w-lg mx-auto">
                                    <h3 className="text-lg font-bold text-slate-800 mb-2">Sign This Contract</h3>
                                    <p className="text-sm text-slate-500 mb-6">
                                        Please review the contract above carefully. By signing below, you agree to all terms outlined in this agreement.
                                    </p>

                                    {!isApproving ? (
                                        <button
                                            onClick={() => setIsApproving(true)}
                                            className="px-8 py-3 bg-slate-800 text-white rounded-lg font-semibold text-sm hover:bg-slate-900 transition shadow-sm"
                                        >
                                            Sign Contract
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
                                                        <strong className="text-slate-700">ESIGN Act Disclosure:</strong> By signing above and clicking "Sign & Agree," I confirm that (1) my drawn signature and typed name constitute my legal electronic signature under the U.S. ESIGN Act (15 U.S.C. § 7001) and UETA, (2) I have reviewed and agree to all terms in this contract, and (3) this agreement is legally binding.
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
                                                        {isSubmitting ? "Processing..." : "Sign & Agree"}
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
                            This contract was prepared by {companyName}. {companyPhone && `Contact: ${companyPhone}.`} {companyEmail && `Email: ${companyEmail}.`}
                        </p>
                        <p className="text-[10px] text-slate-300 mt-1">
                            Electronic signatures on this document comply with the U.S. ESIGN Act and UETA.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
