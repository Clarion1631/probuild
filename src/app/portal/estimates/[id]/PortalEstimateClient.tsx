"use client";

import React, { useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import DOMPurify from "dompurify";
import { approveEstimate, markEstimateViewed, generatePdfUploadToken } from "@/lib/actions";
import SignaturePad from "@/components/SignaturePad";
import PortalPayButton from "@/components/PortalPayButton";
import PortalPayInFullButton from "@/components/PortalPayInFullButton";
import { formatCurrency } from "@/lib/utils";
import DocumentLetterhead from "@/components/DocumentLetterhead";
import { buildLetterheadConfig } from "@/lib/letterhead";
import { buildPdf } from "@/lib/build-pdf";
import { getTaxCertStatus } from "@/lib/tax-cert";

class PaymentSectionErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError() {
        return { hasError: true };
    }
    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error("[payment-section-error]", { message: error.message, stack: error.stack, info });
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="px-10 py-6 border-t border-slate-200 bg-amber-50 text-sm text-amber-900">
                    Something went wrong loading the payment section. Please refresh the page or contact us to complete your payment.
                </div>
            );
        }
        return this.props.children;
    }
}

export default function PortalEstimateClient({ initialEstimate, companySettings }: { initialEstimate: any, companySettings?: any }) {
    const [isApproving, setIsApproving] = useState(false);
    const [signature, setSignature] = useState("");
    const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [isDownloading, setIsDownloading] = useState(false);
    // C5 — temporarily override approved state to show "Approved" badge during pre-approval capture
    const [approvedOverride, setApprovedOverride] = useState<boolean | null>(null);
    // C6 — temporarily override signature block data so the captured PDF includes the signature
    const [signatureBlockOverride, setSignatureBlockOverride] = useState<{
        approvedBy: string; signatureUrl: string; approvedAt: Date;
    } | null>(null);
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

    const estimateBannerText = `${companySettings?.companyName || "Golden Touch Remodeling"}  •  Estimate ${initialEstimate.code}  (continued)`;

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
                const pdf = await buildPdf(element, { bannerText: estimateBannerText });
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
            const pdf = await buildPdf(element, { bannerText: estimateBannerText });
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

            // Step 1: Temporarily show "Approved" badge and signature block in the DOM so the
            // captured PDF reflects the final signed state (C5/C6)
            setSignatureBlockOverride({ approvedBy: signature.trim(), signatureUrl: signatureDataUrl!, approvedAt: new Date() });
            setApprovedOverride(true);
            // Give React one frame to re-render the badge before capturing
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

            // Step 2: Capture the portal view with the signature drawn and "Approved" badge
            let capturedPdfUrl: string | undefined;
            const element = document.getElementById("estimate-document-wrapper");
            if (element) {
                try {
                    const pdf = await buildPdf(element, { bannerText: estimateBannerText });
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
            setSignatureBlockOverride(null);
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
    const taxExempt = !!initialEstimate.taxExempt;
    let salesTaxes: { name: string; rate: number; isDefault: boolean }[] = [];
    try { salesTaxes = companySettings?.salesTaxes ? JSON.parse(companySettings.salesTaxes) : []; } catch { /* ignore */ }
    const defaultTax = salesTaxes.find((t: any) => t.isDefault) || salesTaxes[0] || null;
    const savedRate = initialEstimate.taxRatePercent != null ? Number(initialEstimate.taxRatePercent) : null;
    const savedName = initialEstimate.taxRateName || null;
    const effectiveRate = savedRate ?? (defaultTax ? defaultTax.rate : 8.8);
    const effectiveRateDisplay = Number(parseFloat(String(effectiveRate)).toFixed(4));
    const effectiveName = savedName ?? (defaultTax ? defaultTax.name : "Tax");
    const taxRate = taxExempt ? 0 : effectiveRate / 100;
    const taxLabel = taxExempt ? null : `${effectiveName} (${effectiveRateDisplay}%)`;
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = subtotal + tax;
    // C5 — approvedOverride lets us temporarily show "Approved" in the badge before the actual DB update.
    // Signing auto-invoices the estimate, so post-approval statuses (Invoiced/Partially Paid/Paid)
    // and a stored signature all count as approved.
    const isApproved = approvedOverride ?? (
        ["Approved", "Invoiced", "Partially Paid", "Paid"].includes(initialEstimate.status) || !!initialEstimate.approvedAt
    );
    const stripeEnabled = companySettings?.stripeEnabled !== false;
    // Signing auto-creates an invoice from this estimate; once it exists, ITS
    // milestones are the payable source of truth (QuickBooks pay links live there,
    // and paying estimate-side copies would double-bill the job).
    const linkedInvoice: any = (initialEstimate.invoices && initialEstimate.invoices[0]) || null;
    const schedules: any[] = linkedInvoice?.payments?.length
        ? linkedInvoice.payments
        : (initialEstimate.paymentSchedules || []);
    const files: any[] = initialEstimate.files || [];
    // WA DOR: a tax-exempt sale needs the client's reseller permit / exemption
    // certificate on file. Warn (never block signing) until a valid one exists.
    const portalClientRecord = initialEstimate.project?.client ?? initialEstimate.lead?.client ?? null;
    const taxCertStatus = getTaxCertStatus({
        url: portalClientRecord?.taxExemptCertUrl,
        expiresAt: portalClientRecord?.taxExemptCertExpiresAt,
    });
    const showTaxCertBanner = taxExempt && taxCertStatus !== "valid";
    // Show pay-in-full when: no schedules at all, OR the auto-created "Payment in Full" row exists but isn't paid and has no active Stripe session (handles abandoned checkouts)
    // Suppress immediately after a successful payment redirect — webhook may not have updated status yet
    // (and always once the invoice exists — its milestones carry the pay buttons instead)
    const showPayInFull = paymentStatus !== "success" && isApproved && stripeEnabled && !linkedInvoice && (
        schedules.length === 0 ||
        schedules.some(s => s.name === "Payment in Full" && s.status !== "Paid" && !s.stripeSessionId)
    );

    // Telemetry: log Pay-button DOM state on mount so we can confirm visibility on iPhone customers
    useEffect(() => {
        const t = setTimeout(() => {
            try {
                const buttons = document.querySelectorAll('[data-pay-button]');
                const report = Array.from(buttons).map(el => {
                    const cs = window.getComputedStyle(el);
                    const r = (el as HTMLElement).getBoundingClientRect();
                    return {
                        visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0,
                        bg: cs.backgroundColor,
                        color: cs.color,
                        rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) },
                        tag: el.tagName.toLowerCase(),
                    };
                });
                console.info("[pay-button-render]", {
                    page: "estimate",
                    estimateId: initialEstimate.id,
                    ua: navigator.userAgent,
                    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
                    gates: { isApproved, stripeEnabled, scheduleCount: schedules.length, paymentStatus, showPayInFull },
                    buttonCount: buttons.length,
                    buttons: report,
                });
                if ((window as any).Sentry?.addBreadcrumb) {
                    (window as any).Sentry.addBreadcrumb({ category: "pay-button", level: "info", data: { page: "estimate", ua: navigator.userAgent, buttonCount: buttons.length, buttons: report } });
                }
            } catch (err) {
                console.error("[pay-button-render] telemetry failed:", err);
            }
        }, 250);
        return () => clearTimeout(t);
        // Mount-only: capture initial render state. Gate values are read fresh inside the effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialEstimate.id]);

    const companyName = companySettings?.companyName || "Golden Touch Remodeling";
    const companyPhone = companySettings?.phone || "";
    const companyEmail = companySettings?.email || "";
    const companyAddress = companySettings?.address || "";
    const companyLicense = companySettings?.licenseNumber || "";

    return (
        <div className="min-h-screen bg-slate-50 font-sans">
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
                <div className="max-w-6xl mx-auto px-4 pt-4 print:hidden">
                    <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-3 flex items-center gap-3">
                        <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        <p className="text-sm font-medium text-green-800">Payment successful! Your milestone has been marked as paid.</p>
                    </div>
                </div>
            )}
            {paymentStatus === "cancelled" && !isCapture && (
                <div className="max-w-6xl mx-auto px-4 pt-4 print:hidden">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-5 py-3 flex items-center gap-3">
                        <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <p className="text-sm font-medium text-amber-800">Payment was cancelled. You can try again anytime.</p>
                    </div>
                </div>
            )}

            {/* Tax-exemption certificate notice — outside the document wrapper so it
                never lands in the captured/signed PDF; informational only, signing stays enabled */}
            {showTaxCertBanner && !isCapture && (
                <div className="max-w-6xl mx-auto px-4 pt-4 print:hidden">
                    <div className="bg-amber-50 border border-amber-300 rounded-lg px-5 py-3 flex items-start gap-3">
                        <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" /></svg>
                        <div>
                            <p className="text-sm font-semibold text-amber-800">
                                {taxCertStatus === "expired"
                                    ? "The tax-exemption certificate we have on file for you has expired"
                                    : "Tax-exemption certificate needed"}
                            </p>
                            <p className="text-sm text-amber-800/90 mt-0.5">
                                This estimate is tax-exempt, and Washington State requires us to keep a current reseller
                                permit or exemption certificate on file. Please send {taxCertStatus === "expired" ? "an updated" : "a"} copy to{" "}
                                {companySettings?.email ? (
                                    <a href={`mailto:${companySettings.email}?subject=${encodeURIComponent(`Tax exemption certificate — Estimate ${initialEstimate.code || ""}`)}`} className="font-semibold underline hover:text-amber-900">
                                        {companySettings.email}
                                    </a>
                                ) : (
                                    "us"
                                )}
                                {isApproved ? "." : " — you can still review and sign in the meantime."}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Document Container */}
            <div className={`max-w-6xl mx-auto py-8 px-4 print:py-0 print:px-0${isCapture ? " py-0 px-0" : ""}`}>
                <div id="estimate-document-wrapper" ref={documentRef} className="bg-white rounded-lg shadow-sm overflow-hidden print:shadow-none print:rounded-none">

                    {/* Document Header */}
                    <DocumentLetterhead
                        config={buildLetterheadConfig(companySettings)}
                        rightContent={
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
                        }
                    />

                    {/* Bill To */}
                    <div className="px-10 pt-6 pb-0">
                        <div className="grid grid-cols-3 gap-8">
                            <div>
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Prepared For</p>
                                <p className="text-sm font-semibold text-slate-800">{initialEstimate.clientName || "Client"}</p>
                                {initialEstimate.clientEmail && <p className="text-sm text-slate-500">{initialEstimate.clientEmail}</p>}
                            </div>
                            <div>
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Project</p>
                                <p className="text-sm font-semibold text-slate-800">{initialEstimate.title || "Project"}</p>
                                <p className="text-sm text-slate-500">{initialEstimate.projectName || initialEstimate.leadName || ""}</p>
                            </div>
                            {initialEstimate.jobsiteAddress && (
                                <div>
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Jobsite Address</p>
                                    <p className="text-sm text-slate-700">{initialEstimate.jobsiteAddress}</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Signed Badge */}
                    {isApproved && (signatureBlockOverride?.approvedBy || initialEstimate.approvedBy) && (
                        <div className="mx-10 mt-6 p-5 bg-green-50 border border-green-200 rounded-lg">
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                                    <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-green-800">Electronically Signed and Approved</h3>
                                    <p className="text-sm text-green-700 mt-0.5">Signed by: <strong>{signatureBlockOverride?.approvedBy ?? initialEstimate.approvedBy}</strong></p>
                                    <p className="text-xs text-green-600 mt-0.5">{new Date(signatureBlockOverride?.approvedAt ?? initialEstimate.approvedAt).toLocaleString()}</p>
                                    <p className="text-xs text-green-700 mt-1 flex items-center gap-1.5"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg> A copy of the signed PDF has been sent to your email.</p>
                                </div>
                            </div>
                            {(signatureBlockOverride?.signatureUrl || initialEstimate.signatureUrl) && (
                                <div className="mt-4 pt-4 border-t border-green-200 flex flex-col items-start">
                                    <span className="text-[10px] text-green-600 uppercase font-semibold mb-2">Electronic Signature</span>
                                    <img src={signatureBlockOverride?.signatureUrl ?? initialEstimate.signatureUrl} alt="Signature" className="h-16 object-contain mix-blend-multiply" />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Line Items — editor-matched layout */}
                    <div className="bg-white">
                        {/* Column headers */}
                        <div className="flex text-[11px] font-bold text-slate-400 border-b border-slate-200 px-10 py-3.5 uppercase tracking-wider">
                            <div className="flex-1">Item Description</div>
                            <div className="w-20 text-right">Qty</div>
                            <div className="w-32 text-right">Unit Price</div>
                            <div className="w-32 text-right">Amount</div>
                        </div>

                        <div className="divide-y divide-slate-100/80">
                            {items.map((item: any) => {
                                const hasSubItems = item.subItems && item.subItems.length > 0;
                                const itemTotal = calculateTotal(item);

                                if (hasSubItems) {
                                    return (
                                        <React.Fragment key={item.id}>
                                            {/* Category header */}
                                            <div data-pdf-row="true" className="flex items-center px-10 py-3.5 bg-slate-50">
                                                <div className="flex-1 font-bold text-sm text-slate-800">{item.name}</div>
                                                <div className="w-20"></div>
                                                <div className="w-32"></div>
                                                <div className="w-32 text-right font-bold text-sm text-slate-800">{formatCurrency(itemTotal)}</div>
                                            </div>
                                            {/* Sub-items */}
                                            {item.subItems.map((sub: any) => (
                                                <div data-pdf-row="true" key={sub.id} className="flex items-start bg-white px-10 py-3">
                                                    <div className="flex-1 pl-6">
                                                        <div className="text-sm font-medium text-slate-700">{sub.name}</div>
                                                        {sub.description && <div className="text-xs text-slate-400 mt-1 leading-relaxed max-w-[85%]">{sub.description}</div>}
                                                    </div>
                                                    <div className="w-20 text-right text-sm text-slate-500">{sub.quantity}</div>
                                                    <div className="w-32 text-right text-sm text-slate-500">{formatCurrency(sub.unitCost)}</div>
                                                    <div className="w-32 text-right text-sm font-semibold text-slate-700">{formatCurrency(Number(sub.total))}</div>
                                                </div>
                                            ))}
                                        </React.Fragment>
                                    );
                                }

                                // Standalone item
                                return (
                                    <div data-pdf-row="true" key={item.id} className="flex items-start px-10 py-3 bg-white">
                                        <div className="flex-1">
                                            <div className="text-sm font-medium text-slate-800">{item.name}</div>
                                            {item.description && <div className="text-xs text-slate-400 mt-1 leading-relaxed max-w-[85%]">{item.description}</div>}
                                        </div>
                                        <div className="w-20 text-right text-sm text-slate-500">{item.quantity}</div>
                                        <div className="w-32 text-right text-sm text-slate-500">{formatCurrency(item.unitCost)}</div>
                                        <div className="w-32 text-right text-sm font-semibold text-slate-800">{formatCurrency(itemTotal)}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Totals */}
                    <div data-pdf-row="true" className="px-10 py-8 border-t border-slate-100 flex justify-end">
                        <div className="w-72 space-y-2 text-sm">
                            <div className="flex justify-between text-slate-500 font-medium">
                                <span>Subtotal</span>
                                <span className="text-slate-800">{formatCurrency(subtotal)}</span>
                            </div>
                            {!taxExempt && taxLabel && (
                                <div className="flex justify-between text-slate-500 font-medium">
                                    <span>{taxLabel}</span>
                                    <span className="text-slate-800">{formatCurrency(tax)}</span>
                                </div>
                            )}
                            <div className="border-t-2 border-slate-800 pt-3 mt-1 flex justify-between text-lg font-bold text-slate-800">
                                <span>Total</span>
                                <span>{formatCurrency(total)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Pay in Full — hidden in capture mode */}
                    {showPayInFull && !isCapture && (
                        <PaymentSectionErrorBoundary>
                            <PortalPayInFullButton
                                estimateId={initialEstimate.id}
                                displayAmount={total}
                                settings={companySettings}
                            />
                        </PaymentSectionErrorBoundary>
                    )}

                    {/* Payment Schedule — hide auto-created "Payment in Full" rows from milestone list */}
                    {schedules.filter((s: any) => s.name !== "Payment in Full").length > 0 && (
                        <PaymentSectionErrorBoundary>
                        <div className="px-10 pb-8">
                            <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3">Payment Schedule</h2>
                            <div className="border border-slate-200 rounded-md overflow-hidden">
                                {schedules.filter((s: any) => s.name !== "Payment in Full").map((p: any) => {
                                    const isPaid = p.status === "Paid";
                                    return (
                                        <div data-pdf-row="true" key={p.id} className={`flex flex-wrap justify-between items-center px-5 py-3 text-sm border-b last:border-b-0 border-slate-100 gap-3 ${isPaid ? "bg-green-50" : ""}`}>
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
                                                    isApproved && !isPaid && Number(p.amount) > 0 && (p.qbInvoiceLink || stripeEnabled) && (
                                                        <PortalPayButton
                                                            paymentScheduleId={p.id}
                                                            {...(linkedInvoice ? { invoiceId: linkedInvoice.id } : { estimateId: initialEstimate.id })}
                                                            amount={Number(p.amount)}
                                                            label="Pay Now"
                                                            settings={companySettings}
                                                            qbPayLink={p.qbInvoiceLink || null}
                                                        />
                                                    )
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        </PaymentSectionErrorBoundary>
                    )}

                    {/* Terms & Conditions */}
                    {initialEstimate.termsAndConditions && (
                        <TermsAndConditions html={initialEstimate.termsAndConditions} />
                    )}

                    {/* Signature / Approval Area — hidden in capture mode */}
                    {!isApproved && !isCapture && (
                        <div data-pdf-row="true" className="px-10 pb-10 print:hidden">
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
                    <div data-pdf-row="true" className="bg-slate-50/60 border-t border-slate-100 px-10 py-4 text-center">
                        <p className="text-xs text-slate-400">
                            This estimate was prepared by {companyName}.{companyLicense && ` Lic# ${companyLicense}.`} {companyPhone && `Contact: ${companyPhone}.`} {companyEmail && `Email: ${companyEmail}.`}
                        </p>
                    </div>
                </div>

                {/* Attachments — interactive download links, shown only in the live portal (not in the captured PDF) */}
                {!isCapture && files.length > 0 && (
                    <div className="bg-white rounded-lg shadow-sm mt-6 print:hidden">
                        <div className="px-10 py-5 border-b border-slate-100">
                            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Attachments</h2>
                        </div>
                        <ul className="divide-y divide-slate-100">
                            {files.map((f: any) => (
                                <li key={f.id}>
                                    <a
                                        href={f.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-3 px-10 py-3 hover:bg-slate-50 transition group"
                                    >
                                        <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                        <span className="flex-1 text-sm font-medium text-slate-700 group-hover:text-indigo-600 truncate">{f.name}</span>
                                        <span className="text-xs text-slate-400 flex-shrink-0">{formatFileSize(f.size)}</span>
                                        <svg className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
}

function formatFileSize(bytes: number): string {
    if (!bytes || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TermsAndConditions({ html }: { html: string }) {
    const ref = useRef<HTMLDivElement>(null);

    // Detect rich HTML by whether the content starts with a block-level tag.
    // Legacy plain-text snapshots never start with "<p" or "<h"; editor-produced
    // HTML always does. Anchoring to trimStart() avoids false-positives from
    // angle brackets appearing mid-sentence in plain text.
    const trimmed = html.trimStart();
    const isRichHtml =
        trimmed.startsWith("<p") ||
        trimmed.startsWith("<h") ||
        trimmed.startsWith("<ul") ||
        trimmed.startsWith("<ol") ||
        trimmed.startsWith("<div");

    const sanitized = isRichHtml ? DOMPurify.sanitize(html) : "";

    // After mount, wrap each top-level block element in a data-pdf-row wrapper
    // so the PDF paginator can break between paragraphs/sections instead of
    // treating the entire terms block as one atomic chunk.
    useEffect(() => {
        if (!ref.current || !isRichHtml) return;
        const container = ref.current;
        const children = Array.from(container.children) as HTMLElement[];
        children.forEach(child => {
            child.setAttribute("data-pdf-row", "true");
        });
    }, [sanitized, isRichHtml]);

    // Strip leading heading/paragraph if it duplicates our own "Terms & Conditions" label.
    // Handles nested inline tags (<strong>, <em>, etc.) and "and" vs "&" variants.
    const stripped = sanitized.replace(
        /^\s*<(h[1-6]|p)[^>]*>(?:\s*<(?!\/)[^>]*>)*\s*Terms\s*(?:&amp;|&|and)\s*Conditions\s*(?:\s*<\/[^>]+>)*\s*<\/\1>\s*/i,
        ""
    );

    const contentClassName = "border-l-2 border-slate-300 pl-6 py-1 prose prose-sm max-w-none text-slate-600 prose-headings:text-slate-800 prose-headings:font-semibold prose-headings:text-sm prose-headings:mt-4 prose-headings:mb-2 prose-strong:text-slate-700 prose-p:leading-relaxed prose-p:text-[13px] prose-p:my-1.5 prose-li:text-[13px] prose-li:my-0.5 prose-ol:pl-4 prose-ul:pl-4 prose-ol:my-2 prose-ul:my-2";

    return (
        <div className="px-10 pb-10 border-t border-slate-200 pt-8">
            {/* Section heading — always rendered once */}
            <div data-pdf-row="true" className="flex items-center gap-2 mb-4">
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Terms &amp; Conditions</h2>
            </div>
            {isRichHtml ? (
                /* Rich HTML path — sanitized and injected; each block gets data-pdf-row via useEffect */
                <div
                    ref={ref}
                    className={contentClassName}
                    dangerouslySetInnerHTML={{ __html: stripped }}
                />
            ) : (
                /* Legacy plain-text path — rendered as JSX to avoid markup injection */
                <div data-pdf-row="true" className={contentClassName}>
                    <p className="whitespace-pre-wrap">{html}</p>
                </div>
            )}
        </div>
    );
}
