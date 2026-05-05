"use client";

import React, { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { approveContract, markContractViewed } from "@/lib/actions";
import DocumentSignModal from "@/components/DocumentSignModal";
import { toast } from "sonner";
import { toJpeg } from "html-to-image";
import { jsPDF } from "jspdf";
import { CONTRACT_PROSE_CLASSES } from "@/lib/contract-styles";
import DocumentLetterhead from "@/components/DocumentLetterhead";
import { buildLetterheadConfig } from "@/lib/letterhead";

export default function PortalContractClient({
    initialContract,
    companySettings,
    archivedPdfUrl,
    accessToken,
}: {
    initialContract: any;
    companySettings?: any;
    archivedPdfUrl?: string | null;
    accessToken?: string | null;
}) {
    const isSigned =
        initialContract.status === "Signed" ||
        initialContract.status === "Approved" ||
        initialContract.status === "Finalized";
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";
    const companyLicense = companySettings?.licenseNumber || "";

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

    // Detect View. Pass the accessToken through so the server-side ownership
    // check accepts the magic-link path (no portal session required).
    useEffect(() => {
        markContractViewed(initialContract.id, accessToken || undefined).catch(console.error);
    }, [initialContract.id, accessToken]);

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
            
            await approveContract(initialContract.id, primarySigName, userAgent, primarySigUrl || undefined, accessToken || undefined);
            
            // Stage 2: Capture crisp DOM Snapshot
            const element = document.getElementById("contract-document-wrapper");
            if (element) {
                // Strip decoration that breaks A4 sizing, and temporarily ensure nothing clips
                // the full document height before we capture it.
                const prevShadow = element.style.boxShadow;
                const prevBorder = element.style.border;
                const prevOverflow = element.style.overflow;
                element.style.boxShadow = "none";
                element.style.border = "none";
                element.style.overflow = "visible";

                // Sanity-check: warn if anything is still clipping. If scrollHeight > offsetHeight
                // the captured image will be short — we need to hunt down the ancestor and fix.
                if (element.scrollHeight > element.offsetHeight + 1) {
                    console.debug(
                        "[contract-pdf] wrapper is shorter than its content",
                        { offsetHeight: element.offsetHeight, scrollHeight: element.scrollHeight }
                    );
                }

                // Capture crisp DOM snapshot. JPEG (quality 0.92) drops file size vs PNG and
                // stays well under Vercel's 4.5MB function payload cap.
                // pixelRatio: 1.5 is a deliberate trade-off — crisp enough on retina but
                // keeps the rasterised canvas well under browser memory limits for tall
                // multi-page contracts (a 10-page contract at pixelRatio 2 can exceed
                // Chrome's canvas byte cap).
                const imgData = await toJpeg(element, { quality: 0.92, pixelRatio: 1.5 });

                // Restore inline styles so the live page keeps looking right
                element.style.boxShadow = prevShadow;
                element.style.border = prevBorder;
                element.style.overflow = prevOverflow;

                // Build a multi-page A4 PDF. Rather than cropping the image to the page height
                // (which requires canvas slicing and re-encoding), we draw the full image onto
                // each page at a negative Y offset. jsPDF clips image draws to the page MediaBox
                // so each page shows the correct slice without double-exposure.
                const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
                const pageW = pdf.internal.pageSize.getWidth();
                const pageH = pdf.internal.pageSize.getHeight();
                const margin = 20;
                const usableH = pageH - margin;
                const imgProps = pdf.getImageProperties(imgData);
                const scaledTotalH = (imgProps.height * pageW) / imgProps.width;

                let rendered = 0;
                let pageIdx = 0;
                while (rendered < scaledTotalH && pageIdx < 30) {
                    if (pageIdx > 0) pdf.addPage();
                    pdf.addImage(imgData, "JPEG", 0, -rendered, pageW, scaledTotalH);
                    rendered += usableH;
                    pageIdx++;
                }

                // Stage 3: Send blob to finalize server action (include token so the finalize
                // route can verify ownership for lead-owned contracts with no portal session)
                const blob = pdf.output('blob');
                const formData = new FormData();
                formData.append("pdf", blob);

                const finalizeUrl = accessToken
                    ? `/api/portal/contracts/${initialContract.id}/finalize?token=${encodeURIComponent(accessToken)}`
                    : `/api/portal/contracts/${initialContract.id}/finalize`;
                const response = await fetch(finalizeUrl, {
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
                        <img src={companySettings.logoUrl} alt={companyName} className="h-10 w-auto object-contain" />
                    ) : (
                        <img src="/logo.png" alt={companyName} className="h-10 w-auto object-contain" />
                    )}
                    <div className="border-l border-slate-300 pl-3">
                        <div className="text-sm font-semibold text-slate-700 leading-tight">{companyName}</div>
                        {companyLicense && (
                            <div className="text-[11px] text-slate-500 leading-tight">Lic# {companyLicense}</div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {isSigned && (
                        <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Executed</span>
                    )}
                    <a
                        href="/portal"
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 transition"
                    >
                        ← Back to My Portal
                    </a>
                </div>
            </header>

            {/* Executed PDF Download Banner — shown once the document has been signed & archived */}
            {isSigned && archivedPdfUrl && (
                <div className="max-w-4xl mx-auto mt-6 px-4 print:hidden">
                    <div className="bg-white border border-green-200 rounded-xl p-5 flex items-center justify-between shadow-sm">
                        <div>
                            <h3 className="text-sm font-semibold text-slate-800">Your executed document is ready</h3>
                            <p className="text-xs text-slate-500 mt-1">A permanent PDF copy has been archived for your records.</p>
                        </div>
                        <a
                            href={archivedPdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-sm font-semibold rounded-lg transition shadow-sm"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
                            </svg>
                            Download Executed PDF
                        </a>
                    </div>
                </div>
            )}

            {/* Document Container */}
            <div className="max-w-4xl mx-auto py-8 px-4 print:py-0 print:px-0">
                <div id="contract-document-wrapper" className="bg-white rounded-lg shadow-sm border border-slate-200 print:shadow-none print:border-none print:rounded-none">

                    {/* Document Header */}
                    <DocumentLetterhead
                        config={buildLetterheadConfig(companySettings)}
                        rightContent={
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
                        }
                    />

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

                            /* Print & PDF page-break safety */
                            .prose h2, .prose h3 {
                                break-after: avoid;
                                page-break-after: avoid;
                            }
                            .prose p, .prose li, .prose table, .prose tr {
                                break-inside: avoid;
                                page-break-inside: avoid;
                            }
                            .doc-block-btn {
                                break-inside: avoid;
                                page-break-inside: avoid;
                            }
                            .prose h2 + *, .prose h3 + * {
                                break-before: avoid;
                                page-break-before: avoid;
                            }
                            @media print {
                                .no-print, .print\\:hidden { display: none !important; }
                                body { font-size: 11pt; line-height: 1.6; color: #000; }
                                .prose { max-width: 100%; }
                                .prose h2 { font-size: 16pt; margin-top: 18pt; }
                                .prose h3 { font-size: 13pt; margin-top: 14pt; }
                                .prose p { margin-bottom: 6pt; orphans: 3; widows: 3; }
                                .prose li { orphans: 2; widows: 2; }
                            }
                        `}} />
                        <div
                            ref={contractBodyRef}
                            className={CONTRACT_PROSE_CLASSES}
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
