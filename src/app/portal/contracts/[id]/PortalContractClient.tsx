"use client";

import React, { useState, useEffect, useRef } from "react";
import DOMPurify from "isomorphic-dompurify";
import { approveContract, markContractViewed } from "@/lib/actions";
import DocumentSignModal from "@/components/DocumentSignModal";
import { toast } from "sonner";
import { buildPdf } from "@/lib/build-pdf";
import { CONTRACT_PROSE_CLASSES } from "@/lib/contract-styles";
import DocumentLetterhead from "@/components/DocumentLetterhead";
import { buildLetterheadConfig } from "@/lib/letterhead";
import { COMPANY_TIME_ZONE } from "@/lib/company-day";

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
        initialContract.status === "Finalized";
    // Client has signed but the company still needs to countersign before the contract is
    // fully executed (plan B). The signing form stays hidden, but we show an "awaiting
    // countersignature" message rather than "Executed", and there's no executed PDF yet.
    const awaitingCountersign =
        !!initialContract.requiresCountersign &&
        initialContract.status === "Signed" &&
        !initialContract.companySignedAt;
    const isExecuted = isSigned && !awaitingCountersign;
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";
    const companyLicense = companySettings?.licenseNumber || "";

    // Deterministic across server (UTC) and client (browser tz) render: this component
    // now server-renders (see isomorphic-dompurify migration), so bare toLocaleDateString/
    // toLocaleString would diverge and cause hydration mismatches. companySettings does not
    // carry a timeZone field (see publicCompanySettingsSelect), so use the shared constant.
    const tz = COMPANY_TIME_ZONE;
    const fmtDate = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz });
    const fmtDateTime = (d: Date | string) => new Date(d).toLocaleString("en-US", { timeZone: tz });

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
    const [pdfDownloadUrl, setPdfDownloadUrl] = useState<string | null>(null);
    const [awaitingCountersignResult, setAwaitingCountersignResult] = useState(false);

    // Detect View. Pass the accessToken through so the server-side ownership
    // check accepts the magic-link path (no portal session required).
    useEffect(() => {
        markContractViewed(initialContract.id, accessToken || undefined).catch(console.error);
    }, [initialContract.id, accessToken]);

    // Parse and Inject HTML Buttons — returns derived block counts alongside HTML
    const { parsedBody, totalRequiredBlocks, totalSigBlocks } = React.useMemo(() => {
        // Sanitize DB content before rendering; our own placeholder injections below are safe
        let html = DOMPurify.sanitize(initialContract.body || "", { USE_PROFILES: { html: true } });
        const escapeHtml = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

        let sigCount = 0;
        let initCount = 0;

        // Replace Signature Blocks
        html = html.replace(/\{\{SIGNATURE_BLOCK\}\}/g, () => {
            const id = `sig-${sigCount++}`;
            const localSig = signatures[id];
            if (localSig) {
                const safeUrl = escapeHtml(localSig.image);
                const safeName = escapeHtml(localSig.name || "Client");
                const sigDateStr = fmtDate(new Date());
                const sigDateHtml = `<span style="display:block;font-size:11px;color:#475569;margin-top:2px;">Date: ${sigDateStr}</span>`;
                return `<span style="display:inline-block;margin:4px 0;"><img src="${safeUrl}" alt="Client Signature" style="height:48px;object-fit:contain;mix-blend-mode:multiply;" /><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Client — ${safeName}</span>${sigDateHtml}</span>`;
            }
            if (isSigned && initialContract.signatureUrl) {
                const safeUrl = escapeHtml(initialContract.signatureUrl);
                const safeName = escapeHtml(initialContract.approvedBy || "Client");
                const sigDateStr = initialContract.approvedAt ? fmtDate(initialContract.approvedAt) : "";
                const sigDateHtml = sigDateStr ? `<span style="display:block;font-size:11px;color:#475569;margin-top:2px;">Date: ${sigDateStr}</span>` : "";
                return `<span style="display:inline-block;margin:4px 0;"><img src="${safeUrl}" alt="Client Signature" style="height:48px;object-fit:contain;mix-blend-mode:multiply;" /><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Client — ${safeName}</span>${sigDateHtml}</span>`;
            }
            if (isSigned && initialContract.approvedBy) {
                const safeName = escapeHtml(initialContract.approvedBy);
                const sigDateStr = initialContract.approvedAt ? fmtDate(initialContract.approvedAt) : "";
                const sigDateHtml = sigDateStr ? `<span style="display:block;font-size:11px;color:#475569;margin-top:2px;">Date: ${sigDateStr}</span>` : "";
                return `<span style="display:inline-block;border-bottom:1.5px solid #64748b;min-width:200px;padding-bottom:4px;margin:4px 0;"><span style="font-weight:600;color:#0f172a;">${safeName}</span><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Client Signature</span>${sigDateHtml}</span>`;
            }
            return `<button type="button" class="doc-block-btn sig-block" data-id="${id}" aria-label="Click to sign"><span class="signing-line"></span><span class="signing-cta"><svg class="signing-pen" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>Tap to sign</span><span class="signing-type">Client Signature</span></button>`;
        });

        // Replace Initial Blocks
        html = html.replace(/\{\{INITIAL_BLOCK\}\}/g, () => {
            const id = `init-${initCount++}`;
            const localInit = initials[id];
            if (localInit) {
                return `<span style="display:inline-block;border-bottom:1.5px solid #64748b;min-width:60px;text-align:center;padding-bottom:4px;margin:4px 0;"><span style="font-size:12px;font-weight:600;color:#0f172a;letter-spacing:1px;">${escapeHtml(localInit.name || "Int.")}</span></span>`;
            }
            if (isSigned) {
                return `<span style="display:inline-block;border-bottom:1.5px solid #64748b;min-width:60px;text-align:center;padding-bottom:4px;margin:4px 0;"><span style="font-size:12px;font-weight:600;color:#0f172a;letter-spacing:1px;">Int.</span></span>`;
            }
            return `<button type="button" class="doc-block-btn init-block" data-id="${id}" aria-label="Click to initial"><span class="signing-line"></span><span class="signing-cta"><svg class="signing-pen" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>Tap to initial</span><span class="signing-type">Initials</span></button>`;
        });

        // Replace Date Blocks with current date (if not signed) or approved date
        const dateStr = isSigned && initialContract.approvedAt
            ? fmtDate(initialContract.approvedAt)
            : fmtDate(new Date());

        html = html.replace(/\{\{DATE_BLOCK\}\}/g, `<strong>${dateStr}</strong>`);

        // Contractor date block — resolves to the contractor's signing date
        const contractorDateStr = initialContract.contractorSignedAt
            ? fmtDate(initialContract.contractorSignedAt)
            : "";
        const contractorDatePattern = /\{\{CONTRACTOR_DATE_BLOCK\}\}|<span[^>]*data-merge-field="CONTRACTOR_DATE_BLOCK"[^>]*>[^<]*<\/span>/g;
        html = html.replace(contractorDatePattern, contractorDateStr ? `<strong>${contractorDateStr}</strong>` : "");

        // Replace Contractor Signature Block — show stored sig image or pending placeholder (read-only for client)
        // Matches both raw {{CONTRACTOR_SIGNATURE_BLOCK}} and TipTap <span data-merge-field="CONTRACTOR_SIGNATURE_BLOCK">...</span>
        // contractorSignedBy is HTML-escaped before injection to prevent XSS (injected after DOMPurify runs)
        const contractorBlockPattern = /\{\{CONTRACTOR_SIGNATURE_BLOCK\}\}|<span[^>]*data-merge-field="CONTRACTOR_SIGNATURE_BLOCK"[^>]*>[^<]*<\/span>/g;
        if (initialContract.contractorSignatureUrl && /^(data:image\/(png|jpeg|webp);base64,|https?:\/\/)/.test(initialContract.contractorSignatureUrl)) {
            const safeUrl = escapeHtml(initialContract.contractorSignatureUrl);
            const safeName = escapeHtml(initialContract.contractorSignedBy || "Signed");
            const sigDateHtml = contractorDateStr ? `<span style="display:block;font-size:11px;color:#475569;margin-top:2px;">Date: ${contractorDateStr}</span>` : "";
            html = html.replace(contractorBlockPattern,
                `<span style="display:inline-block;margin:4px 0;"><img src="${safeUrl}" alt="Contractor Signature" style="height:48px;object-fit:contain;mix-blend-mode:multiply;" /><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Contractor — ${safeName}</span>${sigDateHtml}</span>`
            );
        } else {
            html = html.replace(contractorBlockPattern,
                `<span style="display:inline-block;border-bottom:1.5px solid #64748b;min-width:200px;height:40px;margin:4px 0;padding-bottom:4px;"><span style="display:block;font-size:10px;color:#94a3b8;margin-top:2px;">Contractor Signature — Pending</span></span>`
            );
        }

        return { parsedBody: html, totalRequiredBlocks: sigCount + initCount, totalSigBlocks: sigCount };
    }, [initialContract.body, isSigned, initialContract.approvedAt, initialContract.contractorSignedAt, initialContract.contractorSignatureUrl, initialContract.contractorSignedBy, signatures, initials]);

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

    // Mark elements with data-pdf-row for smart pagination. Lists and tables
    // are marked at the row level (li/tr) instead of the container so a long
    // list/table doesn't become one oversized row that forces pathological
    // page advances. The buildPdf algorithm filters out nested rows, so it's
    // safe to mark both a paragraph and a child element — but we don't mark
    // doc-block-btn buttons since they're typically inline within paragraphs.
    useEffect(() => {
        if (!contractBodyRef.current) return;
        const root = contractBodyRef.current;
        const children = Array.from(root.children) as HTMLElement[];
        children.forEach(child => {
            const tag = child.tagName.toLowerCase();
            if (tag === "ul" || tag === "ol") {
                Array.from(child.children).forEach(li => {
                    (li as HTMLElement).setAttribute("data-pdf-row", "true");
                });
            } else if (tag === "table") {
                child.querySelectorAll("tr").forEach(tr => {
                    (tr as HTMLElement).setAttribute("data-pdf-row", "true");
                });
            } else {
                child.setAttribute("data-pdf-row", "true");
            }
        });
    }, [parsedBody, signatures, initials]);

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
    const hasContractorBlock = (initialContract.body || "").includes("{{CONTRACTOR_SIGNATURE_BLOCK}}")
        || (initialContract.body || "").includes('data-merge-field="CONTRACTOR_SIGNATURE_BLOCK"');
    const contractorHasSigned = !!initialContract.contractorSignedAt;
    const awaitingContractor = hasContractorBlock && !contractorHasSigned;
    const canSubmit = initialContract.originalPdfPath
        ? !!signatures["primary"]
        : (isAllBlocksSigned || totalRequiredBlocks === 0) && !awaitingContractor;

    const handleFinalSubmit = async () => {
        if (!canSubmit) {
            setError(initialContract.originalPdfPath ? "Please sign the document before submitting." : "Please fill out all required signature and initial blocks within the document.");
            return;
        }

        setIsSubmitting(true);
        setError("");

        try {
            if (initialContract.originalPdfPath) {
                const primarySigData = signatures["primary"];
                if (!primarySigData) throw new Error("Signature is required");
                const primarySigUrl = primarySigData.image;
                const primarySigName = primarySigData.name;
                const userAgent = window.navigator.userAgent;

                await approveContract(initialContract.id, primarySigName, userAgent, primarySigUrl, accessToken || undefined);

                const finalizeUrl = accessToken
                    ? `/api/portal/contracts/${initialContract.id}/finalize?token=${encodeURIComponent(accessToken)}`
                    : `/api/portal/contracts/${initialContract.id}/finalize`;
                const response = await fetch(finalizeUrl, {
                    method: 'POST'
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Failed to finalize PDF contract: ${errText}`);
                }
                const result = await response.json();
                if (result?.awaitingCountersign) setAwaitingCountersignResult(true);
                if (result?.file?.url) setPdfDownloadUrl(result.file.url);

                setIsSubmitting(false);
                setIsSuccess(true);
                return;
            }

            // Stage 1: Capture DOM BEFORE server action to avoid re-render race.
            const element = document.getElementById("contract-document-wrapper");
            if (!element) {
                throw new Error("Could not locate the contract document for PDF capture. Please refresh and try again.");
            }

            const prevShadow = element.style.boxShadow;
            const prevBorder = element.style.border;
            const prevOverflow = element.style.overflow;
            let pdfBlob: Blob;

            // Pre-capture: replace interactive <button> signature blocks with
            // inline-styled <img> elements. html-to-image's toJpeg has trouble
            // rendering dynamically-modified <button> content through its SVG
            // foreignObject pipeline — the useEffect-injected signature images
            // don't survive the clone+serialize step. Using inline styles on the
            // img (not Tailwind classes) ensures reliable capture.
            const savedBlockHtml = new Map<HTMLElement, { html: string; tag: string }>();
            if (contractBodyRef.current) {
                const replaceBlocksForCapture = (
                    selector: string,
                    stateMap: Record<string, { image: string; name: string }>,
                    imgHeight: string,
                    label: string,
                ) => {
                    contractBodyRef.current!.querySelectorAll(selector).forEach(btn => {
                        const el = btn as HTMLElement;
                        const id = el.dataset.id;
                        if (!id || !stateMap[id]) return;

                        // Save original HTML for restoration after capture
                        savedBlockHtml.set(el, { html: el.innerHTML, tag: el.tagName });

                        // Replace innerHTML with inline-styled img (no Tailwind classes)
                        el.innerHTML = `<img src="${stateMap[id].image}" alt="${label}" style="height:${imgHeight};object-fit:contain;display:block;margin:4px 0;" />`;
                        // Override button-specific styling that might interfere
                        el.style.cursor = "default";
                        el.style.border = "none";
                        el.style.background = "transparent";
                        el.style.padding = "0";
                        el.style.display = "block";
                    });
                };

                replaceBlocksForCapture(".sig-block", signatures, "48px", "Signature");
                replaceBlocksForCapture(".init-block", initials, "32px", "Initials");
            }

            // Remote signature images (e.g. a Storage-hosted contractor signature) must be
            // inlined as data-URLs before capture: html-to-image can drop cross-origin
            // <img> during clone+serialize, or taint the canvas. We FETCH each remote src
            // and swap in a data-URL, then restore the original src in finally. The client's
            // own just-drawn blocks already carry in-memory data-URLs, so they're skipped.
            const inlinedImgs: { el: HTMLImageElement; src: string }[] = [];
            try {
                element.style.boxShadow = "none";
                element.style.border = "none";
                element.style.overflow = "visible";

                const remoteImgEls = (Array.from(element.querySelectorAll("img")) as HTMLImageElement[])
                    .filter((img) => /^https?:\/\//i.test(img.src));
                await Promise.all(remoteImgEls.map(async (img) => {
                    try {
                        const res = await fetch(img.src, { cache: "force-cache" });
                        if (!res.ok) return;
                        const blob = await res.blob();
                        const dataUrl = await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result as string);
                            reader.onerror = () => reject(reader.error);
                            reader.readAsDataURL(blob);
                        });
                        inlinedImgs.push({ el: img, src: img.src });
                        img.src = dataUrl;
                    } catch {
                        // Leave the original src; html-to-image will still attempt a CORS fetch.
                    }
                }));

                const pdf = await buildPdf(element, {
                    bannerText: `${companyName}  •  ${initialContract.title}  (continued)`,
                });
                pdfBlob = pdf.output('blob');
            } finally {
                element.style.boxShadow = prevShadow;
                element.style.border = prevBorder;
                element.style.overflow = prevOverflow;

                // Restore inlined remote image sources
                inlinedImgs.forEach(({ el, src }) => { el.src = src; });

                // Restore original button HTML after capture
                savedBlockHtml.forEach(({ html }, el) => {
                    el.innerHTML = html;
                    el.style.cursor = "";
                    el.style.border = "";
                    el.style.background = "";
                    el.style.padding = "";
                    el.style.display = "";
                });
            }

            // Stage 2: Record approval in DB (after DOM is captured)
            const primarySigData = Object.values(signatures)[0];
            const primarySigUrl = primarySigData?.image || null;
            const primarySigName = primarySigData?.name || "Accepted Digitally";
            const userAgent = window.navigator.userAgent;

            await approveContract(initialContract.id, primarySigName, userAgent, primarySigUrl || undefined, accessToken || undefined);

            // Stage 3: Upload captured PDF to finalize
            {
                const formData = new FormData();
                formData.append("pdf", pdfBlob);

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
                const result = await response.json();
                if (result?.awaitingCountersign) setAwaitingCountersignResult(true);
                if (result?.file?.url) setPdfDownloadUrl(result.file.url);
            }

            setIsSubmitting(false);
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
                    {awaitingCountersignResult ? (
                        <>
                            <div className="w-16 h-16 mx-auto bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-6">
                                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h2 className="text-2xl font-bold text-slate-800 mb-2">You&apos;re Signed</h2>
                            <p className="text-slate-500 mb-6 leading-relaxed">
                                Thank you! {companyName}{" "}will countersign to finalize this contract. We&apos;ll email you the fully executed copy — it will also appear in your portal.
                            </p>
                        </>
                    ) : (
                        <>
                            <div className="w-16 h-16 mx-auto bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
                                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h2 className="text-2xl font-bold text-slate-800 mb-2">Document Executed</h2>
                            <p className="text-slate-500 mb-6 leading-relaxed">
                                Thank you! Your signed document has been finalized. A copy has been emailed to you for your records.
                            </p>
                            {pdfDownloadUrl && (
                                <a
                                    href={pdfDownloadUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-6 py-3 bg-slate-800 hover:bg-slate-900 text-white text-sm font-semibold rounded-lg transition shadow-sm mb-6"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
                                    </svg>
                                    Download Executed PDF
                                </a>
                            )}
                        </>
                    )}
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
                    {isExecuted && (
                        <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Executed</span>
                    )}
                    {awaitingCountersign && (
                        <span className="px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold border border-amber-200">Awaiting countersignature</span>
                    )}
                    <a
                        href="/portal"
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 transition"
                    >
                        ← Back to My Portal
                    </a>
                </div>
            </header>

            {/* Awaiting company countersignature — the client has signed, the company hasn't yet. */}
            {awaitingCountersign && (
                <div className="max-w-4xl mx-auto mt-6 px-4 print:hidden">
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 shadow-sm">
                        <h3 className="text-sm font-semibold text-amber-900">You&apos;ve signed — awaiting {companyName}&apos;s signature</h3>
                        <p className="text-xs text-amber-700 mt-1">Thanks! {companyName}{" "}will countersign to finalize this contract. You&apos;ll receive the fully executed copy by email, and it will appear here too.</p>
                    </div>
                </div>
            )}

            {/* Executed PDF Download Banner — shown once the document has been signed & archived */}
            {isExecuted && archivedPdfUrl && (
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
                    {initialContract.originalPdfPath ? (
                        <>
                            {/* PDF Viewer */}
                            <div className="w-full aspect-[3/4] sm:h-[650px] bg-slate-100 border-b border-slate-200 relative">
                                <iframe
                                    src={`${archivedPdfUrl || initialContract.originalPdfUrl}#toolbar=1&navpanes=0&scrollbar=1`}
                                    className="w-full h-full border-0"
                                    title={initialContract.title}
                                    style={{ minHeight: "100%" }}
                                />
                            </div>

                            {/* Signed Badge for PDF Contract */}
                            {isSigned && initialContract.approvedBy && (
                                <div className="p-8 bg-green-50 border-t border-green-200">
                                    <div className="flex items-start gap-3 max-w-md mx-auto">
                                        <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                                            <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-semibold text-green-800">{awaitingCountersign ? "You've Signed — Awaiting Company Countersignature" : "Document Executed — Electronically Signed"}</h3>
                                            <p className="text-sm text-green-700 mt-0.5">Primary Signer: <strong>{initialContract.approvedBy}</strong></p>
                                            <p className="text-xs text-green-600 mt-0.5">{fmtDateTime(initialContract.approvedAt)}</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Sign Button/Form for PDF Contract */}
                            {!isSigned && (
                                <div className="p-8 bg-slate-50 border-t border-slate-200">
                                    <div className="max-w-md mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                                        <h3 className="text-sm font-bold text-slate-800 mb-2">Sign this Contract</h3>
                                        <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                                            Please click below to draw your signature and type your name. Your signature and audit information will be appended to a Certificate of Execution page at the end of the PDF.
                                        </p>
                                        
                                        {signatures["primary"] ? (
                                            <div className="space-y-4">
                                                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                                                    <p className="text-xs font-semibold text-green-800 uppercase tracking-wider mb-2">Your Signature</p>
                                                    <img src={signatures["primary"].image} alt="Drawn Signature" className="h-12 object-contain bg-white rounded border border-green-100 p-1" />
                                                    <p className="text-sm font-bold text-slate-800 mt-2">{signatures["primary"].name}</p>
                                                    <button 
                                                        type="button" 
                                                        onClick={() => { setModalMode("signature"); setActiveBlockId("primary"); setModalOpen(true); }}
                                                        className="text-xs text-blue-600 hover:text-blue-800 font-medium underline mt-2 inline-block"
                                                    >
                                                        Change Signature
                                                    </button>
                                                </div>
                                                {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
                                                <button
                                                    onClick={handleFinalSubmit}
                                                    disabled={isSubmitting}
                                                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg font-semibold text-sm transition shadow-sm disabled:opacity-50"
                                                >
                                                    {isSubmitting ? "Finalizing..." : "Submit Signed Document"}
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="text-center">
                                                {error && <p className="text-red-600 text-xs font-medium mb-3">{error}</p>}
                                                <button
                                                    type="button"
                                                    onClick={() => { setModalMode("signature"); setActiveBlockId("primary"); setModalOpen(true); }}
                                                    className="w-full py-4 border-2 border-dashed border-blue-300 hover:border-blue-500 rounded-xl text-blue-600 hover:text-blue-800 font-semibold text-sm transition flex flex-col items-center justify-center gap-2 bg-blue-50/50"
                                                >
                                                    <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                                    </svg>
                                                    Click to Draw Signature
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            {/* Document Header */}
                            <DocumentLetterhead
                                config={buildLetterheadConfig(companySettings)}
                                rightContent={
                                    <div className="text-right">
                                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">DOCUMENT</h1>
                                        <div className="mt-2 space-y-1 text-sm">
                                            <p className="text-slate-500">Date: <span className="text-slate-700">{initialContract.sentAt ? fmtDate(initialContract.sentAt) : fmtDate(initialContract.createdAt)}</span></p>
                                        </div>
                                        <div className="mt-3">
                                            {isExecuted ? (
                                                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-xs font-bold bg-green-50 text-green-700 border border-green-200 uppercase tracking-wider">
                                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                                    Executed
                                                </span>
                                            ) : awaitingCountersign ? (
                                                <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
                                                    Awaiting Countersignature
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
                                <div data-pdf-row="true" className="mx-10 mt-6 p-5 bg-green-50 border border-green-200 rounded-lg">
                                    <div className="flex items-start gap-3">
                                        <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                                            <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-semibold text-green-800">{awaitingCountersign ? "You've Signed — Awaiting Company Countersignature" : "Document Executed — Electronically Signed"}</h3>
                                            <p className="text-sm text-green-700 mt-0.5">Primary Signer: <strong>{initialContract.approvedBy}</strong></p>
                                            <p className="text-xs text-green-600 mt-0.5">{fmtDateTime(initialContract.approvedAt)}</p>
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
                            <div data-pdf-row="true" className="px-5 sm:px-10 pt-8 pb-2">
                                <h2 className="text-xl font-bold text-slate-800 text-center">{initialContract.title}</h2>
                                <div className="w-16 h-0.5 bg-slate-300 mx-auto mt-3"></div>
                            </div>

                            {/* Contract Body (Injected) */}
                            <div className="px-5 sm:px-10 py-8">
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
                        </>
                    )}

                    {/* Final Submission Block */}
                    {!isSigned && !initialContract.originalPdfPath && (
                        <div data-pdf-skip="true" className="px-5 sm:px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8">
                                {awaitingContractor && (
                                    <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl mb-4 flex items-center gap-3">
                                        <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        <p className="text-sm text-amber-800">This document is awaiting the contractor&apos;s signature. You will be able to sign and submit once the contractor has signed.</p>
                                    </div>
                                )}
                                <div className="bg-slate-50 border border-slate-200 p-6 rounded-xl flex items-center justify-between">
                                    <div>
                                        <h3 className="text-sm font-bold text-slate-800">Finalize & Submit</h3>
                                        <p className="text-xs text-slate-500 mt-1">
                                            {awaitingContractor
                                                ? "Awaiting contractor signature before you can submit."
                                                : totalRequiredBlocks > 0
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
                    <div data-pdf-row="true" className="bg-slate-50 border-t border-slate-200 px-5 sm:px-10 py-4 text-center">
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
