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
    const companyName = companySettings?.companyName || "Your Contractor";

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
        <div className="min-h-screen bg-slate-50 font-sans">
            {/* Header */}
            <header className="bg-white border-b border-hui-border px-8 py-5 flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">{companyName}</h1>
                    <p className="text-sm text-hui-textMuted">Contract</p>
                </div>
                {isSigned && (
                    <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-semibold">✓ Signed</span>
                )}
            </header>

            {/* Contract Body */}
            <div className="max-w-3xl mx-auto py-10 px-6">
                <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                    <div className="h-1.5 w-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>
                    <div className="p-10">
                        <h2 className="text-2xl font-bold text-hui-textMain mb-2">{initialContract.title}</h2>
                        <p className="text-sm text-hui-textMuted mb-8">
                            {initialContract.sentAt ? `Sent on ${new Date(initialContract.sentAt).toLocaleDateString()}` : `Created ${new Date(initialContract.createdAt).toLocaleDateString()}`}
                        </p>

                        {/* Contract Content */}
                        <div
                            className="prose prose-sm max-w-none text-hui-textMain prose-headings:text-hui-textMain prose-headings:font-semibold prose-p:leading-relaxed"
                            dangerouslySetInnerHTML={{ __html: initialContract.body }}
                        />

                        {/* Signed Badge */}
                        {isSigned && initialContract.approvedBy && (
                            <div className="mt-10 p-6 bg-green-50 border border-green-200 rounded-lg">
                                <div className="flex items-start gap-3">
                                    <svg className="h-5 w-5 text-green-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    <div>
                                        <h3 className="text-sm font-medium text-green-800">Electronically Signed</h3>
                                        <div className="mt-1 text-sm text-green-700">
                                            <p>Signed by: <strong>{initialContract.approvedBy}</strong></p>
                                            <p>Date: {new Date(initialContract.approvedAt).toLocaleString()}</p>
                                        </div>
                                    </div>
                                </div>
                                {initialContract.signatureUrl && (
                                    <div className="mt-4 border-t border-green-200 pt-4">
                                        <p className="text-xs text-green-700 mb-2">Signature:</p>
                                        <img src={initialContract.signatureUrl} alt="Client Signature" className="h-16 object-contain" />
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Signing Area */}
                        {!isSigned && (
                            <div className="mt-12 pt-8 border-t border-hui-border flex flex-col items-center">
                                <p className="text-hui-textMuted mb-6 text-center max-w-lg">
                                    Please review the contract above carefully. By signing below, you agree to all terms in this agreement.
                                </p>

                                {!isApproving ? (
                                    <button
                                        onClick={() => setIsApproving(true)}
                                        className="hui-btn hui-btn-primary px-8 py-3"
                                    >
                                        Sign Contract
                                    </button>
                                ) : (
                                    <div className="w-full max-w-lg bg-hui-background p-6 rounded-lg border border-hui-border shadow-sm">
                                        <h3 className="text-lg font-semibold text-hui-textMain mb-1">Sign & Agree</h3>
                                        <p className="text-sm text-hui-textMuted mb-5">Draw your signature and type your full legal name.</p>

                                        <div className="space-y-5">
                                            <div>
                                                <label className="block text-sm font-medium text-hui-textMain mb-2">Your Signature</label>
                                                <SignaturePad onSignatureChange={setSignatureDataUrl} />
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-hui-textMain mb-1">Full Legal Name</label>
                                                <input
                                                    type="text"
                                                    value={signature}
                                                    onChange={(e) => setSignature(e.target.value)}
                                                    className="hui-input w-full"
                                                    placeholder="e.g. John A. Doe"
                                                    autoFocus
                                                />
                                            </div>

                                            {error && <p className="text-red-500 text-sm">{error}</p>}

                                            <div className="bg-white border border-hui-border rounded-md p-3">
                                                <p className="text-xs text-hui-textMuted leading-relaxed">
                                                    <strong className="text-hui-textMain">Electronic Signature Disclosure:</strong> By signing above and clicking &ldquo;Sign & Agree,&rdquo; I confirm that (1) my drawn signature and typed name constitute my legal electronic signature under the U.S. ESIGN Act and UETA, (2) I have reviewed and agree to all terms in this contract, and (3) this agreement is legally binding.
                                                </p>
                                            </div>

                                            <div className="flex gap-3 justify-end pt-1">
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
            </div>
        </div>
    );
}
