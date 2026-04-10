"use client";

import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { sendEstimateToClient, getDocumentTemplates } from "@/lib/actions";
import { toast } from "sonner";

type Template = { id: string; name: string; type: string; body: string; isDefault: boolean };

export default function SendEstimateModal({ estimateId, clientEmail, onClose }: { estimateId: string; clientEmail?: string; onClose: () => void }) {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
    const [isSending, setIsSending] = useState(false);
    const [previewBody, setPreviewBody] = useState("");
    const [sendToEmail, setSendToEmail] = useState(clientEmail || "");
    const [ccEmails, setCcEmails] = useState("");
    const [ccError, setCcError] = useState("");
    const [customMessage, setCustomMessage] = useState("");

    // P1.5 — capture state
    const [capturedPdfUrl, setCapturedPdfUrl] = useState<string | null>(null);
    const [captureReady, setCaptureReady] = useState(false);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        getDocumentTemplates().then((data: any[]) => {
            const termsTemplates = data.filter(t => t.type === "terms");
            setTemplates(termsTemplates);
            const defaultT = termsTemplates.find(t => t.isDefault);
            if (defaultT) {
                setSelectedTemplateId(defaultT.id);
                setPreviewBody(defaultT.body);
            }
        });
    }, []);

    useEffect(() => {
        const t = templates.find(t => t.id === selectedTemplateId);
        setPreviewBody(t?.body || "");
    }, [selectedTemplateId, templates]);

    // Listen for the capture postMessage from the hidden iframe
    useEffect(() => {
        async function handleMessage(e: MessageEvent) {
            if (e.origin !== window.location.origin) return;
            if (e.data?.type !== "estimate-capture-done") return;

            if (e.data.error || !e.data.dataUrl) {
                console.warn("PDF capture failed:", e.data.error);
                // Fallback: allow sending without captured PDF (server-side fallback will be used)
                setCaptureReady(true);
                return;
            }

            try {
                // Convert dataUrl → blob → upload to pdf-upload route
                const res = await fetch(e.data.dataUrl);
                const blob = await res.blob();
                const formData = new FormData();
                formData.append("pdf", blob, `Estimate_${estimateId}.pdf`);

                const uploadRes = await fetch(`/api/portal/estimates/${estimateId}/pdf-upload`, {
                    method: "POST",
                    body: formData,
                });

                if (uploadRes.ok) {
                    const json = await uploadRes.json();
                    setCapturedPdfUrl(json.url);
                } else {
                    console.warn("PDF upload failed, falling back to server-side generation");
                }
            } catch (err) {
                console.warn("PDF capture upload error:", err);
            } finally {
                setCaptureReady(true);
            }
        }

        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [estimateId]);

    function validateCc(raw: string): string {
        if (!raw.trim()) return "";
        const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const parts = raw.split(",").map(e => e.trim()).filter(Boolean);
        if (parts.length > 20) return "Too many CC recipients (max 20).";
        const invalid = parts.filter(e => !EMAIL_REGEX.test(e));
        if (invalid.length > 0) return `Invalid: ${invalid.join(", ")}`;
        return "";
    }

    async function handleSend() {
        if (!sendToEmail.trim()) {
            toast.error("Please enter an email address.");
            return;
        }
        const ccValidation = validateCc(ccEmails);
        if (ccValidation) {
            toast.error(ccValidation);
            return;
        }
        setIsSending(true);
        try {
            const ccList = ccEmails.split(",").map(e => e.trim()).filter(Boolean);
            const result = await sendEstimateToClient(
                estimateId,
                selectedTemplateId || undefined,
                sendToEmail.trim(),
                ccList.length > 0 ? ccList : undefined,
                customMessage.trim() || undefined,
                capturedPdfUrl || undefined
            );
            if (!result.success) {
                toast.error(result.error || "Failed to send estimate");
                return;
            }
            toast.success(`Estimate sent to ${result.sentTo}`);
            onClose();
        } catch (e: any) {
            toast.error("An unexpected error occurred. Please try again.");
        } finally {
            setIsSending(false);
        }
    }

    const isConfirmDisabled = isSending || !sendToEmail.trim() || !!ccError || !captureReady;

    return (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
            {/* Hidden capture iframe — loads portal estimate in capture mode */}
            <iframe
                ref={iframeRef}
                src={`/portal/estimates/${estimateId}?capture=1`}
                title="pdf-capture"
                style={{ position: "fixed", top: -9999, left: -9999, width: 960, height: 1400, opacity: 0, pointerEvents: "none" }}
                aria-hidden="true"
            />

            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full overflow-hidden border border-hui-border max-h-[85vh] flex flex-col">
                <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center shrink-0">
                    <div>
                        <h2 className="text-lg font-bold text-hui-textMain">Send Estimate to Client</h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">The client will receive an email with a link to view and sign.</p>
                    </div>
                    <button onClick={onClose} className="text-hui-textMuted hover:text-hui-textMain transition">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="p-6 space-y-5 overflow-y-auto flex-1">
                    {/* Email */}
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Sending To</label>
                        <div className="flex items-center gap-2 bg-slate-50 px-4 py-3 rounded-lg border border-hui-border">
                            <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            <input
                                type="email"
                                value={sendToEmail}
                                onChange={e => setSendToEmail(e.target.value)}
                                placeholder="client@email.com"
                                className="flex-1 text-sm font-medium text-hui-textMain bg-transparent focus:outline-none"
                            />
                        </div>
                    </div>

                    {/* CC */}
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">CC <span className="text-hui-textMuted font-normal">(optional)</span></label>
                        <div className="flex items-center gap-2 bg-slate-50 px-4 py-3 rounded-lg border border-hui-border">
                            <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            <input
                                type="text"
                                value={ccEmails}
                                onChange={e => { setCcEmails(e.target.value); setCcError(validateCc(e.target.value)); }}
                                onBlur={e => setCcError(validateCc(e.target.value))}
                                placeholder="email1@example.com, email2@example.com"
                                className="flex-1 text-sm text-hui-textMain bg-transparent focus:outline-none"
                            />
                        </div>
                        {ccError && <p className="text-xs text-red-500 mt-1">{ccError}</p>}
                    </div>

                    {/* Custom Message */}
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Personal Message <span className="text-hui-textMuted font-normal">(optional)</span></label>
                        <textarea
                            value={customMessage}
                            onChange={e => setCustomMessage(e.target.value)}
                            placeholder="Add a personal note to include in the email..."
                            rows={3}
                            className="hui-input w-full resize-none"
                        />
                    </div>

                    {/* Template Picker */}
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Terms & Conditions Template</label>
                        <select
                            className="hui-input w-full"
                            value={selectedTemplateId}
                            onChange={e => setSelectedTemplateId(e.target.value)}
                        >
                            <option value="">None — send without T&C</option>
                            {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (Default)" : ""}</option>
                            ))}
                        </select>
                    </div>

                    {/* Preview */}
                    {previewBody && (
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Preview</label>
                            <div
                                className="bg-slate-50 rounded-lg border border-hui-border p-4 text-sm text-slate-700 max-h-48 overflow-y-auto prose prose-sm"
                                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewBody) }}
                            />
                        </div>
                    )}

                    {/* Capture status */}
                    {!captureReady && (
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                            <svg className="animate-spin w-3.5 h-3.5 text-indigo-500 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                            Generating PDF attachment…
                        </div>
                    )}
                    {captureReady && capturedPdfUrl && (
                        <div className="flex items-center gap-2 text-xs text-green-700">
                            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            PDF ready — will be attached to the email.
                        </div>
                    )}
                    {captureReady && !capturedPdfUrl && (
                        <div className="flex items-center gap-2 text-xs text-amber-700">
                            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            PDF will be generated from template (portal capture unavailable).
                        </div>
                    )}
                </div>

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 shrink-0 bg-slate-50">
                    <button onClick={onClose} className="hui-btn hui-btn-secondary" disabled={isSending}>Cancel</button>
                    <button onClick={handleSend} disabled={isConfirmDisabled} className="hui-btn hui-btn-green flex items-center gap-2 disabled:opacity-50">
                        {isSending ? (
                            <>
                                <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                Sending...
                            </>
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                                Send Estimate
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
