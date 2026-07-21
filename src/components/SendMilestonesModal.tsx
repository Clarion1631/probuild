"use client";

import { useRef, useState } from "react";
import { sendMilestoneInvoices } from "@/lib/actions";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

type SendResult = Awaited<ReturnType<typeof sendMilestoneInvoices>>;
type DriftRow = NonNullable<SendResult["driftReview"]>[number];

export default function SendMilestonesModal({
    invoiceId,
    clientEmail,
    selectedPaymentIds,
    selectedPayments,
    onClose,
}: {
    invoiceId: string;
    clientEmail?: string;
    selectedPaymentIds: string[];
    selectedPayments: any[];
    onClose: () => void;
}) {
    const [isSending, setIsSending] = useState(false);
    const [sendToEmail, setSendToEmail] = useState(clientEmail || "");
    const [phase, setPhase] = useState<"compose" | "review">("compose");
    const sendRequestIdRef = useRef<string | null>(null);
    const [driftRows, setDriftRows] = useState<DriftRow[]>([]);

    const totalAmount = selectedPayments.reduce((sum, p) => sum + Number(p.amount), 0);

    // Single submit path. With no `reconcile` map this is the compose-phase send;
    // with one it's the review-phase "reconcile & send" for the drifting rows only.
    async function submit(reconcile?: Record<string, number>) {
        if (!sendToEmail.trim()) {
            toast.error("Please enter an email address.");
            return;
        }
        const email = sendToEmail.trim();
        const ids = reconcile ? driftRows.map(r => r.id) : selectedPaymentIds;
        setIsSending(true);
        try {
            sendRequestIdRef.current ||= crypto.randomUUID();
            const result = await sendMilestoneInvoices(
                invoiceId,
                ids,
                email,
                reconcile ? { reconcile } : undefined,
                sendRequestIdRef.current,
            );
            // A returned result is definitive. A thrown transport error retains the
            // key so the next click resumes the same provider-idempotent attempt.
            if (!result.retrySameRequest) sendRequestIdRef.current = null;

            // Drift detected → enter (or stay in) the review step. Never close here.
            if (result.needsReview && result.driftReview?.length) {
                if (result.sent > 0) {
                    toast.success(`Sent ${result.sent} invoice(s) to ${email}`);
                }
                // Surface any NON-drift failures/skips so they aren't lost behind the
                // review step (the resubmit only carries the drifting milestones).
                const otherSkips = result.skipped - result.driftReview.length;
                if (result.failed > 0 || otherSkips > 0) {
                    const firstFail = result.results.find(r => r.status === "failed");
                    toast.warning(
                        `${result.failed} failed${otherSkips > 0 ? `, ${otherSkips} skipped` : ""}` +
                        (firstFail?.error ? ` — ${firstFail.error}` : "")
                    );
                }
                setDriftRows(result.driftReview);
                setPhase("review");
                toast.warning(
                    reconcile
                        ? "QuickBooks changed again — please re-review the amounts."
                        : `${result.driftReview.length} milestone(s) differ from QuickBooks — review below.`
                );
                return;
            }

            // No outstanding drift → normal outcome.
            if (result.success) {
                const reconciledCount = result.results.filter(r => r.status === "reconciled").length;
                toast.success(
                    reconciledCount > 0
                        ? `Sent ${result.sent} invoice(s) to ${email} (${reconciledCount} reconciled to QuickBooks)`
                        : `Successfully sent ${result.sent} invoice(s) to ${email}`
                );
                // Delivered-but-not-recorded must be loud: the milestone will still
                // show "Send" because the stamp failed, and a blind resend would
                // email the client twice.
                const recordingIssues = result.results.filter(r => (r.status === "sent" || r.status === "reconciled") && r.error);
                if (recordingIssues.length > 0) {
                    toast.warning(`The email went out, but recording it failed — verify in QuickBooks before resending (${recordingIssues[0].error})`);
                }
                if (result.failed > 0 || result.skipped > 0) {
                    toast.warning(`Failed: ${result.failed}, Skipped: ${result.skipped}`);
                }
            } else {
                toast.error(result.error || "Failed to send invoices");
                const firstBad = result.results.find(r => r.status === "failed" || r.status === "skipped");
                if (firstBad?.error) {
                    toast.error(`Detail: ${firstBad.error}`);
                }
            }
            if (!result.retrySameRequest) onClose();
        } catch (e: any) {
            toast.error(e.message || "Failed to send invoices");
        } finally {
            setIsSending(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full overflow-hidden border border-hui-border max-h-[85vh] flex flex-col">
                <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center shrink-0 bg-gradient-to-r from-emerald-50 to-teal-50">
                    <div>
                        <h2 className="text-lg font-bold text-hui-textMain">
                            {phase === "review" ? "Amounts changed in QuickBooks" : "Send Milestones to Client"}
                        </h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">
                            {phase === "review"
                                ? "Review the differences below before sending."
                                : "The client will receive one email from your company listing only these milestones, with a link to view and pay online."}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isSending}
                        aria-label="Close"
                        className="text-hui-textMuted hover:text-hui-textMain transition disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {phase === "compose" ? (
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

                        {/* Milestones List */}
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Milestones to Send</label>
                            <div className="bg-slate-50 rounded-lg border border-hui-border divide-y divide-hui-border text-xs max-h-36 overflow-y-auto">
                                {selectedPayments.map((p: any) => (
                                    <div key={p.id} className="flex justify-between items-center px-4 py-2.5">
                                        <span className="font-medium text-hui-textMain">{p.name}</span>
                                        <span className="font-semibold text-slate-700">{formatCurrency(Number(p.amount))}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-between items-center px-4 py-2 text-xs font-semibold text-hui-textMain bg-slate-100 rounded-b-lg border-x border-b border-hui-border">
                                <span>Total Requested</span>
                                <span>{formatCurrency(totalAmount)}</span>
                            </div>
                        </div>

                        {/* What happens */}
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-2">
                            <h3 className="text-sm font-semibold text-emerald-800">What happens when you send:</h3>
                            <ul className="text-xs text-emerald-700 space-y-1.5 list-disc pl-4">
                                <li>Each milestone is synced to QuickBooks and its amount verified before anything goes out.</li>
                                <li>Client receives one email requesting only the milestone(s) above — never the full invoice balance.</li>
                                <li>The email opens their client portal focused on these payments, with a Pay Now button.</li>
                                <li>Parent invoice status will change to {"Issued"} if currently a Draft.</li>
                            </ul>
                        </div>
                    </div>
                ) : (
                    <div className="p-6 space-y-5 overflow-y-auto flex-1">
                        <div className="bg-amber-50 border border-amber-200 rounded-lg divide-y divide-amber-200 text-xs">
                            {driftRows.map(row => {
                                const delta = row.qbTotal - row.probuildAmount;
                                const higher = row.direction === "higher";
                                return (
                                    <div key={row.id} className="px-4 py-3">
                                        <div className="font-semibold text-hui-textMain mb-1.5">{row.name}</div>
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-slate-500">
                                                ProBuild <span className="font-medium text-slate-700">{formatCurrency(row.probuildAmount)}</span>
                                            </span>
                                            <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                                            <span className="text-slate-500">
                                                QuickBooks <span className="font-semibold text-hui-textMain">{formatCurrency(row.qbTotal)}</span>
                                            </span>
                                            <span className={`font-semibold whitespace-nowrap ${higher ? "text-amber-700" : "text-blue-700"}`}>
                                                {higher ? "▲" : "▼"} {formatCurrency(Math.abs(delta))}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                            <p className="text-xs text-amber-800">
                                QuickBooks is the system of record for what the client is charged. Reconciling
                                updates the ProBuild milestone (and the linked estimate) to match the QuickBooks
                                total, then sends the invoice.
                            </p>
                        </div>
                    </div>
                )}

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 shrink-0 bg-slate-50">
                    {phase === "compose" ? (
                        <>
                            <button onClick={onClose} className="hui-btn hui-btn-secondary" disabled={isSending}>Cancel</button>
                            <button onClick={() => submit()} disabled={isSending || !sendToEmail.trim()} className="hui-btn hui-btn-green flex items-center gap-2">
                                {isSending ? (
                                    <>
                                        <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                        Sending...
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                                        Send Milestones
                                    </>
                                )}
                            </button>
                        </>
                    ) : (
                        <>
                            <button onClick={onClose} className="hui-btn hui-btn-secondary" disabled={isSending}>Cancel</button>
                            <button onClick={() => submit(Object.fromEntries(driftRows.map(r => [r.id, r.qbTotal])))} disabled={isSending} className="hui-btn hui-btn-green flex items-center gap-2">
                                {isSending ? (
                                    <>
                                        <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                        Reconciling...
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        Reconcile & Send
                                    </>
                                )}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
