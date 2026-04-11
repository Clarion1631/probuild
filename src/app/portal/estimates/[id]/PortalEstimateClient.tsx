"use client";

import React, { useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import DOMPurify from "dompurify";
import { approveEstimate, markEstimateViewed, generatePdfUploadToken } from "@/lib/actions";
import SignaturePad from "@/components/SignaturePad";
import PortalPayButton from "@/components/PortalPayButton";
import PortalPayInFullButton from "@/components/PortalPayInFullButton";
import { formatCurrency } from "@/lib/utils";

export default function PortalEstimateClient({ initialEstimate, companySettings }: { initialEstimate: any, companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [isDownloading, setIsDownloading] = useState(false);
    // C5 — temporarily override approved state to show "Approved" badge during pre-approval capture
    const [approvedOverride, setApprovedOverride] = useState<boolean | null>(null);
    const viewedRef = useRef(false);
    const documentRef = useRef<HTMLDivElement>(null);
    const searchParams = useSearchParams();
    const paymentStatus = searchParams.get("payment");
    const isCapture = searchParams.get("capture") === "1";
    // C1 — upload token passed from admin iframe via query param
    const uploadTokenParam = searchParams.get("upload_token") || "";
    const router = useRouter();

    useEffect(() => {
        if (viewedRef.current) return;
        viewedRef.current = true;
        if (!isCapture) {
            markEstimateViewed(initialEstimate.id).catch(console.error);
        }
    }, [initialEstimate.id, isCapture]);

    // Shared helper: build a paginated jsPDF from an element
    async function buildPdf(element: HTMLElement): Promise<import("jspdf").jsPDF> {
        const { toJpeg } = await import("html-to-image");
        const { jsPDF } = await import("jspdf");
        const imgData = await toJpeg(element, { quality: 0.85, pixelRatio: 1.5 });
        const pdf = new jsPDF("p", "mm", "a4");
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfPageHeight = pdf.internal.pageSize.getHeight();
        const imgRenderedHeight = (element.offsetHeight * pdfWidth) / element.offsetWidth;
        let heightLeft = imgRenderedHeight;
        let position = 0;
        pdf.addImage(imgData, "JPEG", 0, position, pdfWidth, imgRenderedHeight);
        heightLeft -= pdfPageHeight;
        while (heightLeft > 0) {
            position -= pdfPageHeight;
            pdf.addPage();
            pdf.addImage(imgData, "JPEG", 0, position, pdfWidth, imgRenderedHeight);
            heightLeft -= pdfPageHeight;
        }
        return pdf;
    }

    // Capture mode: auto-capture DOM and postMessage PDF to parent
    // C6 — use document.fonts.ready + requestAnimationFrame instead of a hardcoded delay
    useEffect(() => {
        if (!isCapture) return;
        let cancelled = false;

        async function waitAndCapture() {
            // Wait for all web fonts to finish loading
            await document.fonts.ready;
            // Wait for any in-flight images to decode
            const imgs = Array.from(document.images);
            await Promise.all(
                imgs
                    .filter(img => !img.complete)
                    .map(img => new Promise<void>(resolve => {
                        img.onload = () => resolve();
                        img.onerror = () => resolve();
                    }))
            );
            // One animation frame ensures the DOM has painted at least once
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            // Small extra buffer for CSS transitions / layout
            await new Promise<void>(resolve => setTimeout(resolve, 200));

            if (cancelled) return;

            const element = document.getElementById("estimate-document-wrapper");
            if (!element) {
                window.parent.postMessage({ type: "estimate-capture-done", error: "no-element" }, window.location.origin);
                return;
            }
            try {
                const pdf = await buildPdf(element);
                const dataUrl = pdf.output("datauristring");
                // Include the upload token so the parent can authenticate the storage upload
                window.parent.postMessage({ type: "estimate-capture-done", dataUrl, uploadToken: uploadTokenParam }, window.location.origin);
            } catch (err) {
                window.parent.postMessage({ type: "estimate-capture-done", error: String(err) }, window.location.origin);
            }
        }

        waitAndCapture();
        return () => { cancelled = true; };
    }, [isCapture, uploadTokenParam]); // eslint-disable-line react-hooks/exhaustive-deps

    async function handleDownload() {
        const element = document.getElementById("estimate-document-wrapper");
        if (!element) return;
        setIsDownloading(true);
        try {
            const prevShadow = element.style.boxShadow;
            const prevBorder = element.style.border;
            element.style.boxShadow = "none";
            element.style.border = "none";
            const pdf = await buildPdf(element);
            element.style.boxShadow = prevShadow;
            element.style.border = prevBorder;
            pdf.save(`Estimate_${initialEstimate.code || initialEstimate.id}.pdf`);
        } catch (err) {
            console.error("Download failed:", err);
        } finally {
            setIsDownloading(false);
        }
    }

    useEffect(() => {
        if (paymentStatus !== "success") return;
        const timer = setTimeout(() => router.refresh(), 3000);
        return () => clearTimeout(timer);
    }, [paymentStatus, router]);

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

            // Step 1: Temporarily show "Approved" badge in the DOM so the captured PDF
            // reflects the final approved state rather than "Pending Approval" (C5)
            setApprovedOverride(true);
            // Give React one frame to re-render the badge before capturing
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

            // Step 2: Capture the portal view with the signature drawn and "Approved" badge
            let capturedPdfUrl: string | undefined;
            const element = document.getElementById("estimate-document-wrapper");
            if (element) {
                try {
                    const pdf = await buildPdf(element);
                    const blob = pdf.output("blob");
                    const fd = new FormData();
                    fd.append("pdf", blob, `Signed_Estimate_${initialEstimate.code || initialEstimate.id}.pdf`);

                    // Generate a fresh upload token for this request (C1)
                    let token = "";
                    try { token = await generatePdfUploadToken(initialEstimate.id); } catch { /* fallback: no token */ }

                    const res = await fetch(`/api/portal/estimates/${initialEstimate.id}/pdf-upload`, {
                        method: "POST",
                        headers: token ? { "x-upload-token": token } : {},
                        body: fd,
                    });
                    if (res.ok) {
                        const json = await res.json();
                        capturedPdfUrl = json.url;
                    }
                } catch (captureErr) {
                    console.error("PDF capture failed, falling back to server-side generation:", captureErr);
                }
            }

            // Step 3: Approve — passes captured URL so the confirmation email gets the portal-quality PDF
            await approveEstimate(initialEstimate.id, signature.trim(), userAgent, signatureDataUrl, capturedPdfUrl);
            window.location.reload();
        } catch (e) {
            // Restore the badge to real status on error
            setApprovedOverride(null);
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
    const tax = subtotal * 0.088;
    const total = subtotal + tax;
    // C5 — approvedOverride lets us temporarily show "Approved" in the badge before the actual DB update
    const isApproved = approvedOverride ?? (initialEstimate.status === "Approved");
    const stripeEnabled = companySettings?.stripeEnabled !== false;
    const schedules: any[] = initialEstimate.paymentSchedules || [];
    // Show pay-in-full when: no schedules at all, OR the auto-created "Payment in Full" row exists but isn't paid and has no active Stripe session (handles abandoned checkouts)
    // Suppress immediately after a successful payment redirect — webhook may not have updated status yet
    const showPayInFull = paymentStatus !== "success" && isApproved && stripeEnabled && (
        schedules.length === 0 ||
        schedules.some(s => s.name === "Payment in Full" && s.status !== "Paid" && !s.stripeSessionId)
    );
    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";
    const companyLicense = companySettings?.licenseNumber || "";

    return (
        <div className="min-h-screen bg-slate-100 font-sans">
            {/* Minimal Top Bar — hidden in capture mode */}
            <header className={`bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between print:hidden${isCapture ? " hidden" : ""}`}>
                <div className="flex items-center gap-3">
                    {companySettings?.logoUrl ? (
                        <img src={companySettings.logoUrl} alt={companyName} className="h-8 w-auto object-contain" />
                    ) : (
                        <img src="/logo.png" alt={companyName} className="h-8 w-auto object-contain" />
                    )}
                    <span className="text-sm text-slate-500">Estimate Portal</span>
                </div>
                <button
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
                {isApproved && (
                    <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-semibold border border-green-200">✓ Approved & Signed</span>
                )}
            </header>

            {/* Payment status banners — hidden in capture mode */}
            {paymentStatus === "success" && !isCapture && (
                <div className="max-w-4xl mx-auto px-4 pt-4 print:hidden">
                    <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-3 flex items-center gap-3">
                        <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        <p className="text-sm font-medium text-green-800">Payment successful! Your milestone has been marked as paid.</p>
                    </div>
                </div>
            )}
            {paymentStatus === "cancelled" && !isCapture && (
                <div className="max-w-4xl mx-auto px-4 pt-4 print:hidden">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-5 py-3 flex items-center gap-3">
                        <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <p className="text-sm font-medium text-amber-800">Payment was cancelled. You can try again anytime.</p>
                    </div>
                </div>
            )}

            {/* Document Container */}
            <div className={`max-w-4xl mx-auto py-8 px-4 print:py-0 print:px-0${isCapture ? " py-0 px-0" : ""}`}>
                <div id="estimate-document-wrapper" ref={documentRef} className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden print:shadow-none print:border-none print:rounded-none">

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
                                {companyLicense && <p className="text-sm text-slate-500">Lic# {companyLicense}</p>}
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
                                    <span>Tax (8.8%)</span>
                                    <span>{formatCurrency(tax)}</span>
                                </div>
                                <div className="border-t-2 border-slate-800 mt-1 pt-2 flex justify-between text-lg font-bold text-slate-800">
                                    <span>Total</span>
                                    <span>{formatCurrency(total)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Pay in Full — hidden in capture mode */}
                    {showPayInFull && !isCapture && (
                        <PortalPayInFullButton
                            estimateId={initialEstimate.id}
                            displayAmount={total}
                            settings={companySettings}
                        />
                    )}

                    {/* Payment Schedule — hide auto-created "Payment in Full" rows from milestone list */}
                    {schedules.filter((s: any) => s.name !== "Payment in Full").length > 0 && (
                        <div className="px-10 pb-8">
                            <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3">Payment Schedule</h2>
                            <div className="border border-slate-200 rounded-md overflow-hidden">
                                {schedules.filter((s: any) => s.name !== "Payment in Full").map((p: any) => {
                                    const isPaid = p.status === "Paid";
                                    return (
                                        <div key={p.id} className={`flex flex-wrap justify-between items-center px-5 py-3 text-sm border-b last:border-b-0 border-slate-100 gap-3 ${isPaid ? "bg-green-50" : ""}`}>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-slate-700">{p.name}</span>
                                                    {p.percentage && <span className="text-slate-400">({p.percentage}%)</span>}
                                                    {isPaid && (
                                                        <span className="text-[10px] font-bold uppercase text-green-700 bg-green-100 px-1.5 py-0.5 rounded">Paid</span>
                                                    )}
                                                </div>
                                                {isPaid && p.paymentDate && (
                                                    <p className="text-xs text-slate-400 mt-0.5">Paid {new Date(p.paymentDate).toLocaleDateString()}</p>
                                                )}
                                                {!isPaid && p.dueDate && (
                                                    <p className="text-xs text-slate-400 mt-0.5">Due {new Date(p.dueDate).toLocaleDateString()}</p>
                                                )}
                                            </div>
                                            <div className="flex gap-4 items-center">
                                                <span className="font-semibold text-slate-800">{formatCurrency(p.amount)}</span>
                                                {paymentStatus === "success" && !isPaid && p.stripeSessionId ? (
                                                    <span className="text-xs text-slate-500 italic">Payment processing…</span>
                                                ) : (
                                                    isApproved && !isPaid && stripeEnabled && Number(p.amount) > 0 && (
                                                        <PortalPayButton
                                                            paymentScheduleId={p.id}
                                                            estimateId={initialEstimate.id}
                                                            amount={Number(p.amount)}
                                                            label="Pay Now"
                                                            settings={companySettings}
                                                        />
                                                    )
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
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
                                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(initialEstimate.termsAndConditions ?? "") }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Signature / Approval Area — hidden in capture mode */}
                    {!isApproved && !isCapture && (
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
                            This estimate was prepared by {companyName}.{companyLicense && ` Lic# ${companyLicense}.`} {companyPhone && `Contact: ${companyPhone}.`} {companyEmail && `Email: ${companyEmail}.`}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
