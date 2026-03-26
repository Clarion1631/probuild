"use client";

import { useState, useEffect } from "react";
import { sendInvoiceToClient } from "@/lib/actions";
import { toast } from "sonner";

export default function SendInvoiceModal({ invoiceId, clientEmail, onClose }: { invoiceId: string; clientEmail?: string; onClose: () => void }) {
    const [isSending, setIsSending] = useState(false);
    const [sendToEmail, setSendToEmail] = useState(clientEmail || "");

    async function handleSend() {
        if (!sendToEmail.trim()) {
            toast.error("Please enter an email address.");
            return;
        }
        setIsSending(true);
        try {
            const result = await sendInvoiceToClient(invoiceId, sendToEmail.trim());
            toast.success(`Invoice sent to ${result.sentTo}`);
            onClose();
        } catch (e: any) {
            toast.error(e.message || "Failed to send invoice");
        } finally {
            setIsSending(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full overflow-hidden border border-hui-border max-h-[85vh] flex flex-col">
                <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center shrink-0 bg-gradient-to-r from-emerald-50 to-teal-50">
                    <div>
                        <h2 className="text-lg font-bold text-hui-textMain">Send Invoice to Client</h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">The client will receive an email with a link to view and pay online.</p>
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

                    {/* What happens */}
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-2">
                        <h3 className="text-sm font-semibold text-emerald-800">What happens when you send:</h3>
                        <ul className="text-xs text-emerald-700 space-y-1.5">
                            <li className="flex items-start gap-2">
                                <svg className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                Client receives a professional email with a "View & Pay" button
                            </li>
                            <li className="flex items-start gap-2">
                                <svg className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                Invoice status will change to "Issued" if currently Draft
                            </li>
                            <li className="flex items-start gap-2">
                                <svg className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                You'll receive a notification when they view it
                            </li>
                            <li className="flex items-start gap-2">
                                <svg className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                They can pay online via credit card, ACH, or financing
                            </li>
                        </ul>
                    </div>
                </div>

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 shrink-0 bg-slate-50">
                    <button onClick={onClose} className="hui-btn hui-btn-secondary" disabled={isSending}>Cancel</button>
                    <button onClick={handleSend} disabled={isSending || !sendToEmail.trim()} className="hui-btn hui-btn-green flex items-center gap-2">
                        {isSending ? (
                            <>
                                <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                Sending...
                            </>
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                                Send Invoice
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
