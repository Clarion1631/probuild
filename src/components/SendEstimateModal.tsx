"use client";

import { useState, useEffect } from "react";
import { sendEstimateToClient, getDocumentTemplates } from "@/lib/actions";
import { toast } from "sonner";

type Template = { id: string; name: string; type: string; body: string; isDefault: boolean };

export default function SendEstimateModal({ estimateId, clientEmail, onClose }: { estimateId: string; clientEmail?: string; onClose: () => void }) {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
    const [isSending, setIsSending] = useState(false);
    const [previewBody, setPreviewBody] = useState("");

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

    async function handleSend() {
        if (!clientEmail) {
            toast.error("This client has no email address. Please add one first.");
            return;
        }
        setIsSending(true);
        try {
            const result = await sendEstimateToClient(estimateId, selectedTemplateId || undefined);
            toast.success(`Estimate sent to ${result.sentTo}`);
            onClose();
        } catch (e: any) {
            toast.error(e.message || "Failed to send estimate");
        } finally {
            setIsSending(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
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
                            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            <span className="text-sm font-medium text-hui-textMain">{clientEmail || "No email on file"}</span>
                        </div>
                        {!clientEmail && (
                            <p className="text-xs text-red-500 mt-1">Please add an email address to the client before sending.</p>
                        )}
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
                                dangerouslySetInnerHTML={{ __html: previewBody }}
                            />
                        </div>
                    )}
                </div>

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 shrink-0 bg-slate-50">
                    <button onClick={onClose} className="hui-btn hui-btn-secondary" disabled={isSending}>Cancel</button>
                    <button onClick={handleSend} disabled={isSending || !clientEmail} className="hui-btn hui-btn-green flex items-center gap-2">
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
