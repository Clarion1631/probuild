"use client";

import React, { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { approveContract, markContractViewed } from "@/lib/actions";
import DocumentSignModal from "@/components/DocumentSignModal";
import { toast } from "sonner";
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

    // Blocks Tracking (derived from parsedBody memo — not state)

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [isSuccess, setIsSuccess] = useState(false);

    // Detect View
    useEffect(() => {
        markContractViewed(initialContract.id).catch(console.error);
    }, [initialContract.id]);

    // Parse and Inject HTML Buttons — returns derived block counts alongside HTML
    const { parsedBody, totalRequiredBlocks, totalSigBlocks } = React.useMemo(() => {
        // Sanitize DB content before rendering; our own placeholder injections below are safe
        let html = DOMPurify.sanitize(initialContract.body || "", { USE_PROFILES: { html: true } });

        let sigCount = 0;
        let initCount = 0;

        // Replace Signature Blocks
        html = html.replace(/\{\{SIGNATURE_BLOCK\}\}/g, () => {
            const id = `sig-${sigCount++}`;
            return `<button type="button" class="doc-block-btn sig-block" data-id="${id}" aria-label="Click to sign"><span class="signing-line"></span><span class="signing-cta"><svg class="signing-pen" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>Tap to sign</span><span class="signing-type">Client Signature</span></button>`;
        });

        // Replace Initial Blocks
        html = html.replace(/\{\{INITIAL_BLOCK\}\}/g, () => {
            const id = `init-${initCount++}`;
            return `<button type="button" class="doc-block-btn init-block" data-id="${id}" aria-label="Click to initial"><span class="signing-line"></span><span class="signing-cta"><svg class="signing-pen" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>Tap to initial</span><span class="signing-type">Initials</span></button>`;
        });

        // Replace Date Blocks with current date (if not signed) or approved date
        const dateStr = isSigned && initialContract.approvedAt
            ? new Date(initialContract.approvedAt).toLocaleDateString()
            : new Date().toLocaleDateString();

        html = html.replace(/\{\{DATE_BLOCK\}\}/g, `<strong>${dateStr}</strong>`);

        // Replace Contractor Signature Block — show stored sig image or pending placeholder (read-only for client)
        // contractorSignedBy is HTML-escaped before injection to prevent XSS (injected after DOMPurify runs)
        const escapeHtml = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
        if (initialContract.contractorSignatureUrl && /^data:image\/(png|jpeg|webp);base64,/.test(initialContract.contractorSignatureUrl)) {
            const safeUrl = escapeHtml(initialContract.contractorSignatureUrl);
            const safeName = escapeHtml(initialContract.contractorSignedBy || "Signed");
            html = html.replace(/\{\{CONTRACTOR_SIGNATURE_BLOCK\}\}/g,
                `<span style="display:inline-block;margin:4px 0;"><img src="${safeUrl}" alt="Contractor Signature" style="height:48px;object-fit:contain;mix-blend-mode:multiply;" /><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Contractor — ${safeName}</span></span>`
            );
        } else {
            html = html.replace(/\{\{CONTRACTOR_SIGNATURE_BLOCK\}\}/g,
                `<span style="display:inline-block;border-bottom:1.5px solid #64748b;min-width:200px;height:40px;margin:4px 0;padding-bottom:4px;"><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Contractor Signature — Pending</span></span>`
            );
        }

        return { parsedBody: html, totalRequiredBlocks: sigCount + initCount, totalSigBlocks: sigCount };
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
        const sigDefaultHtml = `<span class="signing-line"></span><span class="signing-cta"><svg class="signing-pen" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>Tap to sign</span><span class="signing-type">Client Signature</span>`;
        const initDefaultHtml = `<span class="signing-line"></span><span class="signing-cta"><svg class="signing-pen" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>Tap to initial</span><span class="signing-type">Initials</span>`;

        const syncBtn = (btn: Element, stateMap: Record<string, any>, defaultHtml: string) => {
            const id = (btn as HTMLElement).dataset.id;
            if (!id) return;

            if (stateMap[id]) {
                // It is signed — show ink-on-paper image
                btn.innerHTML = `<img src="${stateMap[id].image}" class="h-12 object-contain mix-blend-multiply" alt="Signed" />`;
                btn.classList.add('signed-block');
                btn.classList.remove('unsigned-block', 'error-block');
            } else {
                // Unsigned — show signature line design
                btn.innerHTML = defaultHtml;
                btn.classList.remove('signed-block');
                if (error) {
                    btn.classList.add('error-block');
                    btn.classList.remove('unsigned-block');
                } else {
                    btn.classList.add('unsigned-block');
                    btn.classList.remove('error-block');
                }
            }
        };

        sigBtns.forEach(btn => syncBtn(btn, signatures, sigDefaultHtml));
        initBtns.forEach(btn => syncBtn(btn, initials, initDefaultHtml));
    }, [signatures, initials, error, isSigned]);

    // Handle Modal Finish
    const handleSignBlock = (dataUrl: string, typedName: string) => {
        if (!activeBlockId) return;

        if (modalMode === "signature") {
            const isFirstSig = Object.keys(signatures).length === 0;
            const newSigs = { ...signatures, [activeBlockId]: { image: dataUrl, name: typedName } };
            setSignatures(newSigs);

            const remainingCount = totalSigBlocks - Object.keys(newSigs).length;
            if (isFirstSig && remainingCount > 0) {
                toast(`Apply this signature to all ${remainingCount} remaining block${remainingCount !== 1 ? "s" : ""}?`, {
                    action: {
                        label: "Apply to all",
                        onClick: () => {
                            const allSigs: Record<string, { image: string; name: string }> = {};
                            for (let i = 0; i < totalSigBlocks; i++) {
                                allSigs[`sig-${i}`] = { image: dataUrl, name: typedName };
                            }
                            setSignatures(allSigs);
                        },
                    },
                    duration: 8000,
                });
            }
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
            
            await approveContract(initialContract.id, primarySigName, userAgent, primarySigUrl || undefined);
            
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
                                display: block;
                                cursor: pointer;
                                transition: all 0.2s;
                                background: transparent;
                                border: none;
                                padding: 0;
                                min-width: 200px;
                                max-width: 280px;
                                margin: 12px 0 4px;
                                text-align: left;
                            }
                            .doc-block-btn.init-block {
                                min-width: 120px;
                                max-width: 180px;
                            }
                            .signing-line {
                                display: block;
                                border-bottom: 1.5px solid #64748b;
                                margin-bottom: 4px;
                                height: 32px;
                            }
                            .signing-cta {
                                display: flex;
                                align-items: center;
                                gap: 4px;
                                font-size: 11px;
                                font-weight: 500;
                                color: #2563eb;
                                padding: 2px 0;
                            }
                            .signing-pen {
                                flex-shrink: 0;
                                stroke: #2563eb;
                            }
                            .signing-type {
                                display: block;
                                font-size: 10px;
                                color: #94a3b8;
                                margin-top: 1px;
                            }
                            .doc-block-btn.unsigned-block .signing-line {
                                border-color: #3b82f6;
                                animation: signing-pulse 2s ease-in-out infinite;
                            }
                            .doc-block-btn.error-block .signing-line {
                                border-color: #ef4444;
                                animation: signing-pulse 0.8s ease-in-out infinite;
                            }
                            .doc-block-btn.error-block .signing-cta {
                                color: #dc2626;
                            }
                            .doc-block-btn.error-block .signing-pen {
                                stroke: #dc2626;
                            }
                            .doc-block-btn.signed-block {
                                min-width: auto;
                            }
                            .doc-block-btn:hover .signing-line {
                                border-color: #1d4ed8;
                                box-shadow: 0 1px 0 #1d4ed8;
                            }
                            @keyframes signing-pulse {
                                0%, 100% { opacity: 1; }
                                50% { opacity: 0.5; }
                            }
                            .prose .doc-block-btn img {
                                margin: 0;
                                display: inline;
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

            {/* Signing Progress Bar — fixed at bottom, outside overflow-hidden wrapper */}
            {!isSigned && totalRequiredBlocks > 0 && (
                <div className="fixed bottom-0 inset-x-0 z-20 flex justify-center px-4 pb-4 pointer-events-none print:hidden">
                    <div className="pointer-events-auto bg-white border border-slate-200 rounded-xl shadow-lg px-5 py-3 flex items-center gap-4 max-w-md w-full">
                        <div className="flex-1">
                            {(() => {
                                const completed = Object.keys(signatures).length + Object.keys(initials).length;
                                const pct = Math.round((completed / totalRequiredBlocks) * 100);
                                return (
                                    <>
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-xs font-semibold text-slate-700">
                                                {completed === totalRequiredBlocks
                                                    ? "All blocks signed — ready to submit"
                                                    : `${completed} of ${totalRequiredBlocks} signature${totalRequiredBlocks !== 1 ? "s" : ""} completed`}
                                            </span>
                                            <span className="text-xs text-slate-400">{pct}%</span>
                                        </div>
                                        <div className="w-full bg-slate-100 rounded-full h-1.5">
                                            <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                                        </div>
                                    </>
                                );
                            })()}
                        </div>
                        {Object.keys(signatures).length + Object.keys(initials).length === totalRequiredBlocks && (
                            <span className="w-6 h-6 bg-green-100 text-green-600 rounded-full flex items-center justify-center shrink-0">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            </span>
                        )}
                    </div>
                </div>
            )}

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
