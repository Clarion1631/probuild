"use client";

import React, { useState, useEffect, useRef } from "react";
import { approveContract, markContractViewed } from "@/lib/actions";
import DocumentSignModal from "@/components/DocumentSignModal";
import { toJpeg } from "html-to-image";
import { jsPDF } from "jspdf";

export default function PortalContractClient({ initialContract, companySettings }: { initialContract: any; companySettings?: any }) {
    const isSigned = initialContract.status === "Signed" || initialContract.status === "Approved";
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";

    const contractBodyRef = useRef<HTMLDivElement>(null);

    // Signing Modal State
    const [modalOpen, setModalOpen] = useState(false);
    const [modalMode, setModalMode] = useState<"signature" | "initials">("signature");
    const [activeBlockId, setActiveBlockId] = useState<string | null>(null);

    // Captured Data Maps
    const [signatures, setSignatures] = useState<Record<string, { image: string, name: string }>>({});
    const [initials, setInitials] = useState<Record<string, { image: string, name: string }>>({});

    // Blocks Tracking
    const [totalRequiredBlocks, setTotalRequiredBlocks] = useState(0);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [isSuccess, setIsSuccess] = useState(false);

    // Detect View
    useEffect(() => {
        markContractViewed(initialContract.id).catch(console.error);
    }, [initialContract.id]);

    // Parse and Inject HTML Buttons
    const parsedBody = React.useMemo(() => {
        let html = initialContract.body || "";
        
        let sigCount = 0;
        let initCount = 0;

        // Replace Signature Blocks
        html = html.replace(/\{\{SIGNATURE_BLOCK\}\}/g, () => {
            const id = `sig-${sigCount++}`;
            return `<button type="button" class="doc-block-btn sig-block" data-id="${id}">[ Click to Sign ]</button>`;
        });

        // Replace Initial Blocks
        html = html.replace(/\{\{INITIAL_BLOCK\}\}/g, () => {
            const id = `init-${initCount++}`;
            return `<button type="button" class="doc-block-btn init-block" data-id="${id}">[ Click to Initial ]</button>`;
        });

        // Replace Date Blocks with current date (if not signed) or approved date
        const dateStr = isSigned && initialContract.approvedAt 
            ? new Date(initialContract.approvedAt).toLocaleDateString()
            : new Date().toLocaleDateString();
            
        html = html.replace(/\{\{DATE_BLOCK\}\}/g, `<strong>${dateStr}</strong>`);

        setTotalRequiredBlocks(sigCount + initCount);
        return html;
    }, [initialContract.body, isSigned, initialContract.approvedAt]);

    // Attach Delegated Listeners
    useEffect(() => {
        const container = contractBodyRef.current;
        if (!container || isSigned) return;

        const handleDelegatedClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const btn = target.closest('.doc-block-btn') as HTMLElement;
            if (!btn) return;

            const id = btn.dataset.id;
            if (btn.classList.contains('sig-block')) {
                setActiveBlockId(id || null);
                setModalMode("signature");
                setModalOpen(true);
            } else if (btn.classList.contains('init-block')) {
                setActiveBlockId(id || null);
                setModalMode("initials");
                setModalOpen(true);
            }
        };

        container.addEventListener('click', handleDelegatedClick);
        return () => {
            container.removeEventListener('click', handleDelegatedClick);
        };
    }, [parsedBody, isSigned]);

    // Sync DOM with State for visual highlighting and re-rendering images
    useEffect(() => {
        if (!contractBodyRef.current || isSigned) return;

        const sigBtns = contractBodyRef.current.querySelectorAll('.sig-block');
        const initBtns = contractBodyRef.current.querySelectorAll('.init-block');

        // Helper to sync
        const syncBtn = (btn: Element, stateMap: Record<string, any>, defaultText: string) => {
            const id = (btn as HTMLElement).dataset.id;
            if (!id) return;
            
            if (stateMap[id]) {
                // It is signed
                btn.innerHTML = `<img src="${stateMap[id].image}" class="h-10 object-contain mix-blend-multiply" alt="Signed" />`;
                btn.classList.add('bg-transparent', 'border-none', 'p-0', 'ring-0', 'shadow-none');
                btn.classList.remove('bg-blue-50', 'border-blue-300', 'text-blue-700', 'animate-pulse', 'ring-2', 'ring-red-400');
            } else {
                // It is missing
                btn.innerHTML = defaultText;
                btn.classList.remove('bg-transparent', 'border-none', 'p-0', 'ring-0', 'shadow-none');
                btn.classList.add('bg-blue-50', 'border-blue-300', 'text-blue-700');
                
                // If they tried to submit and failed, or just naturally highlight
                if (error) {
                    btn.classList.add('ring-2', 'ring-red-400', 'animate-pulse');
                } else {
                    btn.classList.add('ring-2', 'ring-blue-400', 'animate-bounce-subtle');
                }
            }
        };

        sigBtns.forEach(btn => syncBtn(btn, signatures, "[ Click to Sign ]"));
        initBtns.forEach(btn => syncBtn(btn, initials, "[ Click to Initial ]"));
    }, [signatures, initials, error, isSigned]);

    // Handle Modal Finish
    const handleSignBlock = (dataUrl: string, typedName: string) => {
        if (!activeBlockId) return;

        if (modalMode === "signature") {
            setSignatures(prev => ({ ...prev, [activeBlockId]: { image: dataUrl, name: typedName } }));
        } else {
            setInitials(prev => ({ ...prev, [activeBlockId]: { image: dataUrl, name: typedName } }));
        }

        setModalOpen(false);
        setActiveBlockId(null);
    };

    const isAllBlocksSigned = Object.keys(signatures).length + Object.keys(initials).length === totalRequiredBlocks;
    const canSubmit = isAllBlocksSigned || totalRequiredBlocks === 0;

    const handleFinalSubmit = async () => {
        if (!canSubmit) {
            setError("Please fill out all required signature and initial blocks within the document.");
            return;
        }

        setIsSubmitting(true);
        setError("");

        try {
            // Stage 1: Mathematical Approval in DB
            const primarySigData = Object.values(signatures)[0];
            const primarySigUrl = primarySigData?.image || null;
            const primarySigName = primarySigData?.name || "Accepted Digitally";
            const userAgent = window.navigator.userAgent;
            
            await approveContract(initialContract.id, primarySigName, "Client IP", userAgent, primarySigUrl || undefined);
            
            // Stage 2: Capture crisp DOM Snapshot
            const element = document.getElementById("contract-document-wrapper");
            if (element) {
                // Remove box shadows or borders that mess up standard A4 sizing
                element.style.boxShadow = "none";
                element.style.border = "none";
                
                // Capture crisp DOM Snapshot natively
                // Using JPEG with quality 0.85 instead of uncompressed PNG drops file size from ~8MB to ~300KB
                // This prevents Vercel's 4.5MB FUNCTION_PAYLOAD_TOO_LARGE fatal error natively.
                const imgData = await toJpeg(element, { quality: 0.85, pixelRatio: 1.5 });
                
                // Scale perfectly onto standard A4 PDF to prevent 96dpi vs 72dpi zooming
                const pdf = new jsPDF("p", "mm", "a4");
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = (element.offsetHeight * pdfWidth) / element.offsetWidth;

                pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
                
                // Stage 3: Send blob to finalize server action
                const blob = pdf.output('blob');
                const formData = new FormData();
                formData.append("pdf", blob);

                const response = await fetch(`/api/portal/contracts/${initialContract.id}/finalize`, {
                    method: 'POST',
                    body: formData
                });
                
                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Failed to upload PDF: ${errText}`);
                }
            }

            // Stop loading indicator
            setIsSubmitting(false);

            // Show the success screen instead of reloading the page
            setIsSuccess(true);

        } catch (e: any) {
            console.error(e);
            setError(e?.message || String(e) || "Something went wrong processing your approval.");
            setIsSubmitting(false);
        }
    };

    if (isSuccess) {
        return (
            <div className="min-h-screen bg-slate-100 font-sans flex items-center justify-center p-4">
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 max-w-md text-center">
                    <div className="w-16 h-16 mx-auto bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-slate-800 mb-2">Document Executed</h2>
                    <p className="text-slate-500 mb-8 leading-relaxed">
                        Thank you! Your document has been signed successfully. A PDF receipt has been securely archived and emailed to you for your records.
                    </p>
                    <p className="text-sm font-medium text-slate-400">
                        You may now close this window.
                    </p>
                </div>
            </div>
        );
    }

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
                    <span className="text-sm border-l border-slate-300 pl-3 font-medium text-slate-500">Document Portal</span>
                </div>
                {isSigned && (
                    <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Executed</span>
                )}
            </header>

            {/* Document Container */}
            <div className="max-w-4xl mx-auto py-8 px-4 print:py-0 print:px-0">
                <div id="contract-document-wrapper" className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden print:shadow-none print:border-none print:rounded-none">

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
                                <h1 className="text-2xl font-bold text-slate-800 tracking-tight">DOCUMENT</h1>
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
                                            Action Required
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
                                    <h3 className="text-sm font-semibold text-green-800">Document Executed — Electronically Signed</h3>
                                    <p className="text-sm text-green-700 mt-0.5">Primary Signer: <strong>{initialContract.approvedBy}</strong></p>
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

                    {/* Contract Body (Injected) */}
                    <div className="px-10 py-8">
                        {/* We add a style tag to apply CSS to the dynamically generated buttons so Tailwind works smoothly on them */}
                        <style dangerouslySetInnerHTML={{__html: `
                            .doc-block-btn {
                                display: inline-flex;
                                align-items: center;
                                justify-content: center;
                                background-color: #eff6ff;
                                color: #2563eb;
                                padding: 6px 12px;
                                border: 1px dashed #93c5fd;
                                border-radius: 4px;
                                font-weight: 600;
                                font-size: 0.875rem;
                                cursor: pointer;
                                transition: all 0.2s;
                                min-width: 120px;
                            }
                            .doc-block-btn:hover {
                                background-color: #dbeafe;
                                border-color: #3b82f6;
                            }
                            .doc-block-btn.init-block {
                                min-width: 80px;
                                padding: 4px 8px;
                            }
                            .prose .doc-block-btn img {
                                margin: 0;
                            }
                        `}} />
                        <div
                            ref={contractBodyRef}
                            className="prose prose-sm max-w-none text-slate-700 prose-headings:text-slate-800 prose-headings:font-semibold prose-h2:text-lg prose-h3:text-base prose-p:leading-relaxed prose-p:text-sm prose-strong:text-slate-800 prose-li:text-sm"
                            dangerouslySetInnerHTML={{ __html: parsedBody }}
                        />
                    </div>

                    {/* Final Submission Block */}
                    {!isSigned && (
                        <div className="px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8">
                                <div className="bg-slate-50 border border-slate-200 p-6 rounded-xl flex items-center justify-between">
                                    <div>
                                        <h3 className="text-sm font-bold text-slate-800">Finalize & Submit</h3>
                                        <p className="text-xs text-slate-500 mt-1">
                                            {totalRequiredBlocks > 0 
                                                ? `Please fill out all ${totalRequiredBlocks} blocks above to finalize.`
                                                : "No advanced signature blocks found. Click submit to legally agree."}
                                        </p>
                                        {error && <p className="text-red-600 text-xs font-medium mt-2">{error}</p>}
                                    </div>
                                    <button
                                        onClick={handleFinalSubmit}
                                        disabled={isSubmitting || !canSubmit}
                                        className={`px-8 py-3 rounded-lg font-semibold text-sm transition shadow-sm ${
                                            canSubmit 
                                                ? "bg-slate-800 text-white hover:bg-slate-900" 
                                                : "bg-slate-200 text-slate-400 cursor-not-allowed"
                                        }`}
                                    >
                                        {isSubmitting ? "Finalizing..." : "Submit Signed Document"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Footer */}
                    <div className="bg-slate-50 border-t border-slate-200 px-10 py-4 text-center">
                        <p className="text-xs text-slate-400">
                            This document was prepared by {companyName}. {companyPhone && `Contact: ${companyPhone}.`} {companyEmail && `Email: ${companyEmail}.`}
                        </p>
                        <p className="text-[10px] text-slate-300 mt-1">
                            Electronic signatures on this document comply with the U.S. ESIGN Act and UETA.
                        </p>
                    </div>
                </div>
            </div>

            <DocumentSignModal
                isOpen={modalOpen}
                onClose={() => {
                    setModalOpen(false);
                    setActiveBlockId(null);
                }}
                mode={modalMode}
                onSign={handleSignBlock}
            />
        </div>
    );
}
