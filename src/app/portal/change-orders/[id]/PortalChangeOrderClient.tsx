"use client";

import React, { useState } from "react";
import { approveChangeOrder } from "@/lib/actions";
import SignaturePad from "@/components/SignaturePad";
import Link from "next/link";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { coTaxRate, coTaxLabel, coLineCents, coItemsSubtotal, billableCoItems } from "@/lib/co-tax";
import { buildPdf } from "@/lib/build-pdf";

export default function PortalChangeOrderClient({ initialData, companySettings }: { initialData: any, companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [isDownloading, setIsDownloading] = useState(false);

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
    const isSent = initialData.status === "Sent";
    const isDeclined = initialData.status === "Declined";
    // Draft covers "never sent yet" and "pulled back for edits after being sent" — the
    // client-facing copy already calls this state "Under Revision" in the skipped panel
    // below; the badge reuses that same label so a Draft/superseded CO never reads as
    // approvable on the printed PDF.
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";
    const changeOrderBannerText = `${companyName} • Change Order ${initialData.code} (continued)`;

    async function handleDownload() {
        const element = document.getElementById("change-order-document-wrapper");
        if (!element) return;
        setIsDownloading(true);
        const prevShadow = element.style.boxShadow;
        const prevBorder = element.style.border;
        // buildPdf measures element.offsetHeight BEFORE the html-to-image capture step,
        // which filters out [data-pdf-skip] nodes. The two terminal panels below (Ready
        // to Approve? / Change Order Under Revision) are data-pdf-skip, so if they're
        // still visible during measurement, totalHeight is inflated relative to what's
        // actually captured — which can add a blank trailing page. Hide them for
        // measurement too so both steps see the identical layout.
        const skipEls = Array.from(element.querySelectorAll<HTMLElement>("[data-pdf-skip]"));
        const prevDisplays = skipEls.map(el => el.style.display);
        try {
            element.style.boxShadow = "none";
            element.style.border = "none";
            skipEls.forEach(el => { el.style.display = "none"; });
            const pdf = await buildPdf(element, { bannerText: changeOrderBannerText });
            pdf.save(`ChangeOrder_${initialData.code || initialData.id}.pdf`);
        } catch (err) {
            console.error("Download failed:", err);
            toast.error("Couldn't generate the PDF. Please try again.");
        } finally {
            // Restore even on failure — a thrown buildPdf() must not leave the
            // card visually altered (no shadow/border, hidden panels) for the rest of the visit.
            element.style.boxShadow = prevShadow;
            element.style.border = prevBorder;
            skipEls.forEach((el, i) => { el.style.display = prevDisplays[i]; });
            setIsDownloading(false);
        }
    }

    const items = initialData.items || [];
    // Same integer-cents math as the editor, updateChangeOrder's item sync, and
    // billChangeOrderCore. Tax follows the estimate's treatment (tax-exempt
    // customers pay none) — the amount shown here is what the customer signs
    // AND what billing charges, to the cent.
    const subtotal = coItemsSubtotal(items);
    const tax = Math.round(subtotal * coTaxRate(initialData.estimate) * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    const taxLabel = coTaxLabel(initialData.estimate);
    const isCostPlus = initialData.pricingType === "COST_PLUS";
    const schedules = initialData.paymentSchedules || [];

    // Split on blank lines so each paragraph can be its own top-level data-pdf-row —
    // build-pdf.ts hard-slices any row taller than one page, which can cut through a
    // text line if the whole description is one atomic row. Sibling rows give the
    // paginator safe break points between paragraphs (mirrors PortalInvoiceClient's
    // Notes section).
    //
    // A single paragraph with no blank lines (the real Mesplay Foundation CO has one)
    // can still be taller than a page, so any paragraph over ~700 chars is further
    // chunked at sentence boundaries (". ", "! ", "? ", punctuation kept with the
    // preceding chunk) — accumulating sentences until the next one would cross the
    // limit, then starting a new chunk. A single sentence longer than 700 chars is
    // never split mid-sentence; it becomes its own chunk, and 700+ chars is still far
    // below a page. Each chunk becomes its own sibling data-pdf-row too.
    const DESCRIPTION_CHUNK_MAX_LEN = 700;
    function chunkParagraph(paragraph: string): string[] {
        if (paragraph.length <= DESCRIPTION_CHUNK_MAX_LEN) return [paragraph];
        const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
        const chunks: string[] = [];
        let current = "";
        for (const sentence of sentences) {
            if (current && current.length + 1 + sentence.length > DESCRIPTION_CHUNK_MAX_LEN) {
                chunks.push(current);
                current = sentence;
            } else {
                current = current ? `${current} ${sentence}` : sentence;
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }
    const descriptionParagraphs = initialData.description
        ? String(initialData.description).split(/\n\s*\n/).map((p: string) => p.trim()).filter(Boolean)
        : [];
    const descriptionChunks = descriptionParagraphs.flatMap((para: string, paraIdx: number) =>
        chunkParagraph(para).map((text: string, chunkIdx: number) => ({ text, paraIdx, chunkIdx }))
    );
    // Gap below a chunk: pb-8 for the final row, pb-3 between paragraphs (existing
    // rhythm), or a tighter pb-1 when the next row is another chunk of the SAME
    // paragraph — these rows only ever use bottom padding (no row has top padding),
    // so "space above the next chunk" is expressed as this row's own bottom padding.
    function descriptionRowPadding(i: number): string {
        if (i === descriptionChunks.length - 1) return "pb-8";
        const next = descriptionChunks[i + 1];
        return next.paraIdx === descriptionChunks[i].paraIdx ? "pb-1" : "pb-3";
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
                    <span className="text-sm text-slate-500">Change Order Portal</span>
                </div>
                <div className="flex items-center gap-4">
                    <button
                        data-pdf-skip="true"
                        onClick={handleDownload}
                        disabled={isDownloading}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
                    >
                        {isDownloading ? (
                            <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                        ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        )}
                        {isDownloading ? "Generating..." : "Download PDF"}
                    </button>
                    <Link data-pdf-skip="true" href={`/portal/projects/${initialData.projectId}`} className="text-sm text-blue-600 hover:underline">
                        Back to Portal
                    </Link>
                    {isApproved && (
                        <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Approved & Signed</span>
                    )}
                </div>
            </header>

            {/* Document Container */}
            <div className="max-w-4xl mx-auto py-8 px-4 print:py-0 print:px-0">
                <div id="change-order-document-wrapper" className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden print:shadow-none print:border-none print:rounded-none">

                    {/* Document Header */}
                    <div data-pdf-row="true" className="px-5 sm:px-10 pt-10 pb-8 border-b border-slate-200">
                        <div className="flex flex-col gap-6 sm:flex-row sm:justify-between items-start">
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
                                    ) : isSent ? (
                                        <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
                                            Sent - Awaiting Approval
                                        </span>
                                    ) : isDeclined ? (
                                        <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-red-50 text-red-700 border border-red-200 uppercase tracking-wider">
                                            Declined
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-bold bg-slate-100 text-slate-600 border border-slate-300 uppercase tracking-wider">
                                            Under Revision
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Bill To */}
                        <div className="mt-8 pt-6 border-t border-slate-100">
                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-8">
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

                    {/* Memo / Description — heading and the FIRST description chunk share one
                        data-pdf-row (anti-orphan: keeps the heading from stranding alone at the
                        bottom of a page with no text under it). Remaining chunks are sibling
                        data-pdf-row blocks (not nested inside a parent that itself carries
                        data-pdf-row, which build-pdf.ts would ignore) so a long description gets
                        safe page breaks between paragraphs, and between chunks of an over-length
                        paragraph, instead of one atomic block that can hard-slice through text. */}
                    {descriptionChunks.length > 0 && (
                        <div className="border-b border-slate-100">
                            <div data-pdf-row="true" className={`px-5 sm:px-10 pt-8 ${descriptionRowPadding(0)}`}>
                                <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">Reason for Change</h2>
                                <p className="mt-3 text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
                                    {descriptionChunks[0].text}
                                </p>
                            </div>
                            {descriptionChunks.slice(1).map((chunk, sliceIdx: number) => {
                                const i = sliceIdx + 1;
                                return (
                                    <div
                                        key={`${chunk.paraIdx}-${chunk.chunkIdx}`}
                                        data-pdf-row="true"
                                        className={`px-5 sm:px-10 text-sm text-slate-600 leading-relaxed whitespace-pre-wrap ${descriptionRowPadding(i)}`}
                                    >
                                        {chunk.text}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {isCostPlus && (
                        <div data-pdf-row="true" className="mx-5 sm:mx-10 mt-6 p-5 bg-amber-50 border border-amber-200 rounded-lg">
                            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider">Cost-plus terms</p>
                            <p className="text-xl font-bold text-slate-900 mt-1">Cost + {initialData.markupPercent ?? 10}% + tax</p>
                            <p className="text-sm text-slate-600 mt-2">This approval covers the scope and markup terms. Work is billed from actual time and materials; scope-line prices are non-binding estimates.</p>
                        </div>
                    )}

                    {/* Signed Badge */}
                    {isApproved && initialData.approvedBy && (
                        <div data-pdf-row="true" className="mx-5 sm:mx-10 mt-6 p-5 bg-green-50 border border-green-200 rounded-lg">
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

                    {/* Company Countersignature */}
                    {initialData.companySignedBy && (
                        <div data-pdf-row="true" className="mx-5 sm:mx-10 mt-4 p-5 bg-slate-50 border border-slate-200 rounded-lg">
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center shrink-0">
                                    <svg className="h-4 w-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-slate-800">Countersigned by {companyName}</h3>
                                    <p className="text-sm text-slate-700 mt-0.5">Signed by: <strong>{initialData.companySignedBy}</strong></p>
                                    {initialData.companySignedAt && (
                                        <p className="text-xs text-slate-500 mt-0.5">{new Date(initialData.companySignedAt).toLocaleString()}</p>
                                    )}
                                </div>
                            </div>
                            {initialData.companySignatureUrl && (
                                <div className="mt-4 pt-4 border-t border-slate-200 flex flex-col items-start">
                                    <span className="text-[10px] text-slate-500 uppercase font-semibold mb-2">Electronic Signature</span>
                                    <img src={initialData.companySignatureUrl} alt="Company signature" className="h-16 object-contain mix-blend-multiply" />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Line Items Table */}
                    <div className="px-5 sm:px-10 py-8">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b-2 border-slate-200">
                                    <th className="text-left py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">{isCostPlus ? "Scope estimate (not a fixed price)" : "Description"}</th>
                                    <th className="text-center py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider w-12 sm:w-20">Qty</th>
                                    <th className="hidden sm:table-cell text-right py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider w-28">Unit Price</th>
                                    <th className="text-right py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider w-24 sm:w-28">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {/* Line amounts must sum to the subtotal below, which excludes
                                    section headers — a header mirrors the lines beneath it. */}
                                {billableCoItems(items).map((item: any) => {
                                    const itemTotal = coLineCents(Number(item.quantity || 0), Number(item.unitCost || 0)) / 100;
                                    return (
                                        <tr data-pdf-row="true" key={item.id}>
                                            <td className="py-3 align-top">
                                                <div className="font-medium text-slate-800">{item.name}</div>
                                                {item.description && (
                                                    <div className="mt-1 text-xs text-slate-500 leading-relaxed whitespace-pre-wrap">{item.description}</div>
                                                )}
                                            </td>
                                            <td className="py-3 text-center text-slate-600 align-top">{item.quantity}</td>
                                            <td className="hidden sm:table-cell py-3 text-right text-slate-600 align-top">{formatCurrency(item.unitCost)}</td>
                                            <td className="py-3 text-right font-medium text-slate-800 align-top">{formatCurrency(itemTotal)}</td>
                                        </tr>
                                    );
                                })}
                                {items.length === 0 && (
                                    <tr data-pdf-row="true"><td colSpan={4} className="py-6 text-center text-slate-400">No items specified for this Change Order.</td></tr>
                                )}
                            </tbody>
                        </table>

                        {/* Totals */}
                        {!isCostPlus ? <div data-pdf-row="true" className="flex justify-end mt-6">
                            <div className="w-full sm:w-72">
                                <div className="flex justify-between py-2 text-sm text-slate-600">
                                    <span>Subtotal</span>
                                    <span>{formatCurrency(subtotal)}</span>
                                </div>
                                <div className="flex justify-between py-2 text-sm text-slate-600">
                                    <span>{taxLabel}</span>
                                    <span>{formatCurrency(tax)}</span>
                                </div>
                                <div className="border-t-2 border-slate-800 mt-1 pt-2 flex justify-between text-lg font-bold text-amber-600">
                                    <span>Revised Amount</span>
                                    <span>{formatCurrency(total)}</span>
                                </div>
                            </div>
                        </div> : <div data-pdf-row="true" className="flex justify-end mt-6"><div className="w-full sm:w-72 border-t-2 border-slate-800 pt-3 text-right"><p className="text-xs text-slate-500 uppercase">Approved terms</p><p className="text-lg font-bold text-amber-600">Cost + {initialData.markupPercent ?? 10}% + tax</p></div></div>}

                        {!isCostPlus && schedules.length > 0 && (
                            <div className="mt-8 border-t border-slate-200 pt-6">
                                <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3">Payment schedule</h3>
                                <div className="space-y-2">
                                    {schedules.map((row: any) => <div data-pdf-row="true" key={row.id} className="flex justify-between text-sm"><span>{row.name}{row.dueDate ? ` · ${new Date(row.dueDate).toLocaleDateString()}` : ""}</span><strong>{formatCurrency(row.amount)}</strong></div>)}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Signature / Approval Area */}
                    {isSent && (
                        <div data-pdf-skip="true" className="px-5 sm:px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8">
                                <div className="text-center max-w-lg mx-auto">
                                    <h3 className="text-lg font-bold text-slate-800 mb-2">Ready to Approve?</h3>
                                    <p className="text-sm text-slate-500 mb-6">
                                        {isCostPlus
                                            ? `By signing below, you authorize the scope and cost + ${initialData.markupPercent ?? 10}% + tax terms. Actual time and materials will be billed later.`
                                            : "By signing below, you authorize the project modifications and budget adjustments outlined in this Change Order."}
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
                                                        <strong className="text-slate-700">ESIGN Act Disclosure:</strong> By signing above and clicking &quot;Sign &amp; Approve,&quot; I confirm that (1) my drawn signature and typed name constitute my legal electronic signature under the U.S. ESIGN Act (15 U.S.C. § 7001) and UETA, (2) I have reviewed and agree to the modifications, and (3) I authorize the described work and payment adjustments.
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
                    {!isApproved && !isSent && (
                        <div data-pdf-skip="true" className="px-5 sm:px-10 pb-10 print:hidden">
                            <div className="border-t-2 border-slate-200 pt-8 text-center">
                                <h3 className="text-lg font-bold text-slate-800 mb-2">Change Order Under Revision</h3>
                                <p className="text-sm text-slate-500">This change order is not currently available for approval. Please use the newest link from your contractor.</p>
                            </div>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
}
