"use client";

import { useState, useEffect, useRef } from "react";
import { recordPayment, issueInvoice, deleteInvoice, updateInvoiceNotes, addInvoiceMilestone, unrecordPayment, splitInvoiceMilestones, sendPaymentReceipt, createQBPaymentLink, refreshQBPayments, breakQBInvoiceLink, emailInvoiceCopyToMe, updatePendingMilestoneAmounts, deleteInvoiceMilestone } from "@/lib/actions";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";
import SendInvoiceModal from "@/components/SendInvoiceModal";
import RecordPaymentModal from "@/components/RecordPaymentModal";
import BulkActionBar from "@/components/BulkActionBar";
import SendMilestonesModal from "@/components/SendMilestonesModal";
import UndoPaymentModal from "@/components/UndoPaymentModal";
import DocumentComments from "@/components/DocumentComments";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { formatMoneyDate } from "@/lib/payment-date";
import type { CheckEvidence } from "@/lib/check-evidence";

const METHOD_LABELS: Record<string, string> = {
    card: "Card",
    ach: "ACH",
    check: "Check",
    cash: "Cash",
    quickbooks: "QuickBooks",
};

function formatPaymentMethod(method: string | null | undefined, ref: string | null | undefined): string {
    if (!method) return "";
    const label = METHOD_LABELS[method] ?? method.toUpperCase();
    if (method === "check" && ref) return `Check #${ref}`;
    if (ref) return `${label} · ${ref}`;
    return label;
}

export default function InvoiceEditor({ project, initialInvoice, checkEvidence = {} }: { project: any, initialInvoice: any, checkEvidence?: Record<string, CheckEvidence> }) {
    const router = useRouter();
    const [isIssuing, setIsIssuing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showSendModal, setShowSendModal] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [showSendMilestonesModal, setShowSendMilestonesModal] = useState(false);
    const [notes, setNotes] = useState(initialInvoice.notes || "");
    const [isSavingNotes, setIsSavingNotes] = useState(false);
    const [showAddMilestone, setShowAddMilestone] = useState(false);
    const [milestoneName, setMilestoneName] = useState("");
    const [milestoneAmount, setMilestoneAmount] = useState("");
    const [milestoneDueDate, setMilestoneDueDate] = useState<string>("");
    const [isAddingMilestone, setIsAddingMilestone] = useState(false);
    const [undoPaymentTarget, setUndoPaymentTarget] = useState<any | null>(null);
    const [recordingFor, setRecordingFor] = useState<{ id: string; name: string; amount: number } | null>(null);
    const [isSendingReceipt, setIsSendingReceipt] = useState<string | null>(null);
    const [qbBusy, setQbBusy] = useState<string | null>(null);
    const [isEmailingCopy, setIsEmailingCopy] = useState(false);

    // Break QB Link confirm dialog (replaces window.confirm so the "also delete
    // in QuickBooks" checkbox has somewhere to live).
    const [breakQBTarget, setBreakQBTarget] = useState<{ id: string; name: string } | null>(null);
    const [breakQBDeleteInQBO, setBreakQBDeleteInQBO] = useState(false);

    // Edit amounts (rebalance Pending milestones without changing the invoice total)
    type EditRow = { name: string; amount: string; dueDate: string };
    const [editMode, setEditMode] = useState(false);
    const [editRows, setEditRows] = useState<Record<string, EditRow>>({});
    const [isSavingEdit, setIsSavingEdit] = useState(false);

    // Delete a non-mirrored, non-QB-linked Pending milestone
    const [deleteMilestoneTarget, setDeleteMilestoneTarget] = useState<{ id: string; name: string } | null>(null);
    const [isDeletingMilestone, setIsDeletingMilestone] = useState(false);

    // On view: if any pending milestone is on the QuickBooks rail, pull settled
    // payments right now (the hourly cron is the backstop, this is the fast path).
    const qbCheckedRef = useRef(false);
    useEffect(() => {
        if (qbCheckedRef.current) return;
        const hasQBPending = (initialInvoice.payments || []).some((p: any) => p.status === "Pending" && p.qbInvoiceId);
        if (!hasQBPending) return;
        qbCheckedRef.current = true;
        refreshQBPayments(initialInvoice.id)
            .then((res) => {
                if (res.settled > 0) {
                    toast.success(`Payment received via QuickBooks (${res.settled} milestone${res.settled > 1 ? "s" : ""} settled)`);
                    router.refresh();
                }
            })
            .catch(() => { /* cron will catch up */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialInvoice.id]);

    async function handleQBLink(payment: { id: string; qbInvoiceLink?: string | null }) {
        // Already pushed → just copy the live link.
        if (payment.qbInvoiceLink) {
            await navigator.clipboard.writeText(payment.qbInvoiceLink).catch(() => {});
            toast.success("QuickBooks pay link copied to clipboard");
            return;
        }
        setQbBusy(payment.id);
        try {
            const res = await createQBPaymentLink(payment.id);
            if (!res.success) {
                toast.error(res.error || "QuickBooks push failed");
            } else if (res.payLink) {
                await navigator.clipboard.writeText(res.payLink).catch(() => {});
                toast.success("QuickBooks invoice created — pay link copied to clipboard");
                router.refresh();
            } else {
                toast.warning("QuickBooks invoice created, but no pay link — enable QuickBooks Payments in QBO to accept cards/ACH.");
                router.refresh();
            }
        } finally {
            setQbBusy(null);
        }
    }

    // Recover a milestone whose QuickBooks invoice was voided/deleted: clear the
    // stale link so it can be re-created fresh. Money state is untouched. Opens
    // the confirm dialog below (with the optional "also delete in QuickBooks"
    // checkbox) instead of firing immediately.
    function handleBreakQBLink(payment: { id: string; name: string }) {
        setBreakQBDeleteInQBO(false);
        setBreakQBTarget(payment);
    }

    async function confirmBreakQBLink() {
        if (!breakQBTarget) return;
        const target = breakQBTarget;
        setQbBusy(target.id);
        try {
            const res = await breakQBInvoiceLink(target.id, { deleteInQBO: breakQBDeleteInQBO });
            if (!res.success) {
                toast.error(res.error);
                return;
            }
            if (res.warning) toast.warning(res.warning);
            else toast.success("QuickBooks link cleared — you can now re-create it.");
            setBreakQBTarget(null);
            router.refresh();
        } finally {
            setQbBusy(null);
        }
    }

    // Split payments state
    type SplitRow = { id: number; name: string; amount: string };
    let splitNextId = 1;
    const [showSplit, setShowSplit] = useState(false);
    const [splitRows, setSplitRows] = useState<SplitRow[]>([{ id: splitNextId++, name: "", amount: "" }]);
    const [isSplitting, setIsSplitting] = useState(false);

    async function handleSendReceipt(paymentId: string) {
        setIsSendingReceipt(paymentId);
        try {
            const result = await sendPaymentReceipt(paymentId);
            if (result.success) {
                toast.success("Receipt sent");
                router.refresh();
            } else {
                toast.error(result.error || "Failed to send receipt");
            }
        } catch (e: any) {
            toast.error(e?.message || "Failed to send receipt");
        } finally {
            setIsSendingReceipt(null);
        }
    }

    async function handleEmailMeCopy() {
        setIsEmailingCopy(true);
        try {
            const res = await emailInvoiceCopyToMe(initialInvoice.id);
            if (res.success) {
                toast.success(`Copy emailed to ${res.sentTo}`);
            } else {
                toast.error(res.error || "Failed to email copy");
            }
        } catch (e: any) {
            toast.error(e?.message || "Failed to email copy");
        } finally {
            setIsEmailingCopy(false);
        }
    }

    async function handleAddMilestone() {
        const amount = Number(milestoneAmount);
        if (!milestoneName.trim()) {
            toast.error("Milestone name is required");
            return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            toast.error("Amount must be greater than zero");
            return;
        }
        setIsAddingMilestone(true);
        try {
            await addInvoiceMilestone(initialInvoice.id, {
                name: milestoneName.trim(),
                amount,
                dueDate: milestoneDueDate || null,
            });
            toast.success("Milestone added");
            setMilestoneName("");
            setMilestoneAmount("");
            setMilestoneDueDate("");
            setShowAddMilestone(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to add milestone");
        } finally {
            setIsAddingMilestone(false);
        }
    }

    async function handleSplit() {
        const valid = splitRows.filter((r) => r.name.trim() && parseFloat(r.amount) > 0);
        if (!valid.length) return;
        setIsSplitting(true);
        try {
            const res = await splitInvoiceMilestones(
                initialInvoice.id,
                valid.map((r) => ({ name: r.name.trim(), amount: parseFloat(r.amount) })),
            );
            if (!res.success) {
                toast.error(res.error || "Failed to update payment schedule");
                return;
            }
            toast.success("Payment schedule updated");
            setShowSplit(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to update payment schedule");
        } finally {
            setIsSplitting(false);
        }
    }

    const pendingPayments = (initialInvoice.payments || []).filter((p: any) => p.status === "Pending");
    const requiredRemaining = pendingPayments.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);

    function handleEnterEditMode() {
        const rows: Record<string, EditRow> = {};
        for (const p of pendingPayments) {
            rows[p.id] = {
                name: p.name,
                amount: String(Number(p.amount)),
                dueDate: p.dueDate ? new Date(p.dueDate).toISOString().slice(0, 10) : "",
            };
        }
        setEditRows(rows);
        setEditMode(true);
        setShowSplit(false);
        setShowAddMilestone(false);
    }

    function handleCancelEditMode() {
        setEditMode(false);
        setEditRows({});
    }

    const enteredSum = Object.values(editRows).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const editTotalsMatch = Math.abs(enteredSum - requiredRemaining) < 0.005;

    async function handleSaveEdit() {
        setIsSavingEdit(true);
        try {
            const rows = Object.entries(editRows).map(([scheduleId, r]) => ({
                scheduleId,
                name: r.name.trim(),
                amount: parseFloat(r.amount) || 0,
                dueDate: r.dueDate || null,
            }));
            const res = await updatePendingMilestoneAmounts(initialInvoice.id, rows);
            for (const warning of res.warnings || []) toast.warning(warning);
            if (!res.warnings || res.warnings.length === 0) toast.success("Payment schedule updated");
            handleCancelEditMode();
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to update milestone amounts");
        } finally {
            setIsSavingEdit(false);
        }
    }

    async function handleDeleteMilestone() {
        if (!deleteMilestoneTarget) return;
        setIsDeletingMilestone(true);
        try {
            await deleteInvoiceMilestone(deleteMilestoneTarget.id);
            toast.success("Milestone deleted");
            setDeleteMilestoneTarget(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to delete milestone");
        } finally {
            setIsDeletingMilestone(false);
        }
    }

    async function handleUnrecord(paymentId: string) {
        try {
            const res = await unrecordPayment(paymentId, initialInvoice.id);
            if (!res?.success) {
                toast.error("Nothing to unrecord — the payment may have already been undone");
                setUndoPaymentTarget(null);
                router.refresh();
                return;
            }
            toast("Payment unrecorded");
            setUndoPaymentTarget(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e?.message || "Failed to unrecord payment");
        }
    }

    async function handleIssueInvoice() {
        setIsIssuing(true);
        try {
            await issueInvoice(initialInvoice.id);
            toast.success("Invoice issued");
            router.refresh();
        } catch (e) {
            console.error(e);
        } finally {
            setIsIssuing(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Are you sure you want to delete this invoice? This cannot be undone.")) return;
        setIsDeleting(true);
        try {
            const res = await deleteInvoice(initialInvoice.id);
            if (!res.success) {
                toast.error(res.error || "Cannot delete this invoice");
                return;
            }
            toast.success("Invoice deleted");
            router.push(`/projects/${res.projectId}/invoices`);
        } catch (e: any) {
            toast.error(e.message || "Cannot delete this invoice");
        } finally {
            setIsDeleting(false);
        }
    }

    async function handleSaveNotes() {
        setIsSavingNotes(true);
        try {
            await updateInvoiceNotes(initialInvoice.id, notes);
            toast.success("Notes saved");
        } catch (e: any) {
            toast.error("Failed to save notes");
        } finally {
            setIsSavingNotes(false);
        }
    }

    const clientName = initialInvoice.client?.name || project.client?.name || "Client";
    const clientEmail = initialInvoice.client?.email || project.client?.email || "";
    const projectLocation = project.location || "";
    const issueDate = initialInvoice.issueDate
        ? new Date(initialInvoice.issueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const createdDate = new Date(initialInvoice.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const sentDate = initialInvoice.sentAt
        ? new Date(initialInvoice.sentAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
    const viewedDate = initialInvoice.viewedAt
        ? new Date(initialInvoice.viewedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;

    const paidCount = (initialInvoice.payments || []).filter((p: any) => p.status === "Paid").length;
    const totalCount = (initialInvoice.payments || []).length;
    const sendablePayments = (initialInvoice.payments || []).filter((p: any) => p.status !== "Paid" && p.status !== "Canceled");
    const canDelete = initialInvoice.status === "Draft" || (initialInvoice.status === "Issued" && paidCount === 0);

    return (
        <div className="flex flex-col h-full bg-hui-background">
            {/* Top Navigation */}
            <div className="bg-white border-b border-hui-border px-6 py-4 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <button onClick={() => router.push(`/projects/${project.id}/invoices`)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                        Back to Invoices
                    </button>
                    <div className="h-4 w-px bg-hui-border"></div>
                    <span className="text-sm font-medium text-hui-textMain">{initialInvoice.code}</span>
                    <StatusBadge status={initialInvoice.status} />
                    {paidCount > 0 && totalCount > 0 && (
                        <span className="text-xs text-hui-textMuted bg-slate-100 px-2 py-0.5 rounded-full">
                            {paidCount}/{totalCount} payments received
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {/* Portal Preview */}
                    <button
                        onClick={() => window.open(`/portal/invoices/${initialInvoice.id}`, '_blank')}
                        className="hui-btn hui-btn-secondary flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        Preview
                    </button>

                    {/* View PDF */}
                    <a
                        href={`/api/pdf/invoices/${initialInvoice.id}?inline=true`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hui-btn hui-btn-secondary flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        View PDF
                    </a>

                    {/* Email me a copy */}
                    <button
                        onClick={handleEmailMeCopy}
                        disabled={isEmailingCopy}
                        className="hui-btn hui-btn-secondary flex items-center gap-2 disabled:opacity-50"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                            <polyline points="22,6 12,13 2,6" />
                        </svg>
                        {isEmailingCopy ? "Sending..." : "Email me a copy"}
                    </button>


                    {/* Delete - only if Draft/Issued with no payments */}
                    {canDelete && (
                        <button
                            onClick={handleDelete}
                            disabled={isDeleting}
                            className="hui-btn hui-btn-secondary text-red-600 border-red-200 hover:bg-red-50 flex items-center gap-2 disabled:opacity-50"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            {isDeleting ? "Deleting..." : "Delete"}
                        </button>
                    )}

                    {/* Issue button (draft only) */}
                    {initialInvoice.status === "Draft" && (
                        <button
                            onClick={handleIssueInvoice}
                            disabled={isIssuing}
                            className="hui-btn hui-btn-primary flex items-center gap-2 disabled:opacity-50"
                        >
                            {isIssuing ? "Issuing..." : "Issue Invoice"}
                        </button>
                    )}

                    {/* Send button */}
                    <button
                        onClick={() => setShowSendModal(true)}
                        className="hui-btn hui-btn-green flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        Send
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4 lg:p-8 flex justify-center">
                <div className="w-full max-w-5xl space-y-6">

                    {/* Document Header */}
                    <div className="hui-card overflow-hidden">
                        <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"></div>
                        <div className="p-8 space-y-6">
                            <div className="flex justify-between items-start">
                                <div>
                                    <h1 className="text-3xl font-bold text-hui-textMain">Invoice</h1>
                                    <p className="text-sm text-hui-textMuted mt-1">{project.name}</p>
                                </div>
                                <div className="text-right">
                                    <StatusBadge status={initialInvoice.status} />
                                </div>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-6 sm:gap-12 text-sm">
                                <div>
                                    <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Bill To</p>
                                    <p className="font-semibold text-base text-hui-textMain">{clientName}</p>
                                    <p className="text-hui-textMuted">{clientEmail || "No email provided"}</p>
                                    {projectLocation && <p className="text-hui-textMuted mt-1">{projectLocation}</p>}
                                </div>
                                <div>
                                    <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Invoice Details</p>
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                                        <span className="text-hui-textMuted">Invoice #</span>
                                        <span className="text-right font-medium text-hui-textMain">{initialInvoice.code}</span>
                                        <span className="text-hui-textMuted">Created</span>
                                        <span className="text-right text-hui-textMain">{createdDate}</span>
                                        {issueDate && (
                                            <>
                                                <span className="text-hui-textMuted">Issued</span>
                                                <span className="text-right text-hui-textMain font-medium">{issueDate}</span>
                                            </>
                                        )}
                                        {sentDate && (
                                            <>
                                                <span className="text-hui-textMuted">Sent</span>
                                                <span className="text-right text-hui-textMain">{sentDate}</span>
                                            </>
                                        )}
                                        {viewedDate && (
                                            <>
                                                <span className="text-hui-textMuted">Viewed</span>
                                                <span className="text-right text-emerald-600 font-medium flex items-center justify-end gap-1">
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                                    {viewedDate}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="h-px w-full bg-hui-border my-4"></div>

                            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 bg-slate-50 p-5 rounded-lg border border-hui-border">
                                <div>
                                    <p className="text-hui-textMuted text-sm mb-1">Total Amount</p>
                                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(initialInvoice.totalAmount)}</p>
                                </div>
                                <div className="text-center">
                                    <p className="text-hui-textMuted text-sm mb-1">Paid</p>
                                    <p className="text-2xl font-bold text-hui-primary">{formatCurrency(Number(initialInvoice.totalAmount || 0) - Number(initialInvoice.balanceDue || 0))}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-hui-textMuted text-sm mb-1">Balance Due</p>
                                    <p className={`text-2xl font-bold ${Number(initialInvoice.balanceDue) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatCurrency(initialInvoice.balanceDue)}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Notes */}
                    <div className="hui-card p-6">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="font-semibold text-hui-textMain flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                Notes
                            </h2>
                            <button
                                onClick={handleSaveNotes}
                                disabled={isSavingNotes}
                                className="hui-btn hui-btn-secondary text-xs py-1 px-3 disabled:opacity-50"
                            >
                                {isSavingNotes ? "Saving..." : "Save Notes"}
                            </button>
                        </div>
                        <textarea
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder="Add internal notes or payment instructions that will be visible to the client..."
                            className="hui-input w-full h-24 resize-none text-sm"
                        />
                    </div>

                    {/* Comments */}
                    <div className="hui-card p-6">
                        <h2 className="font-semibold text-hui-textMain flex items-center gap-2 mb-3">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            Comments
                        </h2>
                        <div className="h-96 border border-hui-border rounded-lg overflow-hidden">
                            <DocumentComments documentType="invoice" documentId={initialInvoice.id} showClientTab={true} />
                        </div>
                    </div>

                    {/* Payments Schedule */}
                    <div className="hui-card overflow-hidden">
                        <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex justify-between items-center">
                            <h2 className="font-semibold text-hui-textMain flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                                Payment Schedule
                            </h2>
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-hui-textMuted">
                                    {paidCount} of {totalCount} paid
                                </span>
                                <button
                                    onClick={() => { setShowSplit(v => !v); setShowAddMilestone(false); if (editMode) handleCancelEditMode(); }}
                                    className="hui-btn hui-btn-secondary text-xs py-1 px-3 flex items-center gap-1"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                                    {showSplit ? "Cancel" : "Split payments"}
                                </button>
                                <button
                                    onClick={() => { setShowAddMilestone(v => !v); setShowSplit(false); if (editMode) handleCancelEditMode(); }}
                                    className="hui-btn hui-btn-secondary text-xs py-1 px-3 flex items-center gap-1"
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                                    {showAddMilestone ? "Cancel" : "Add extra charge"}
                                </button>
                                {pendingPayments.length > 0 && (
                                    <button
                                        onClick={() => {
                                            if (editMode) { handleCancelEditMode(); return; }
                                            setShowSplit(false);
                                            setShowAddMilestone(false);
                                            handleEnterEditMode();
                                        }}
                                        className="hui-btn hui-btn-secondary text-xs py-1 px-3 flex items-center gap-1"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                        {editMode ? "Cancel" : "Edit amounts"}
                                    </button>
                                )}
                            </div>
                        </div>
                        {showSplit && (
                            <div className="px-6 py-4 border-b border-hui-border bg-blue-50/40">
                                <p className="text-xs text-hui-textMuted mb-3">
                                    Define how the balance is split into payment installments. Replaces existing pending milestones and recalculates the invoice total.
                                </p>
                                <div className="space-y-2 mb-3">
                                    <div className="grid grid-cols-[1fr_140px_32px] gap-2 px-1">
                                        <span className="text-[11px] uppercase tracking-wide text-hui-textMuted">Description</span>
                                        <span className="text-[11px] uppercase tracking-wide text-hui-textMuted">Amount</span>
                                        <span />
                                    </div>
                                    {splitRows.map((row) => (
                                        <div key={row.id} className="grid grid-cols-[1fr_140px_32px] gap-2 items-center">
                                            <input
                                                type="text"
                                                placeholder="e.g. Deposit, Final Payment"
                                                value={row.name}
                                                onChange={(e) => setSplitRows(prev => prev.map(r => r.id === row.id ? { ...r, name: e.target.value } : r))}
                                                className="hui-input text-sm"
                                            />
                                            <div className="relative">
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hui-textMuted text-sm">$</span>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    placeholder="0.00"
                                                    value={row.amount}
                                                    onChange={(e) => setSplitRows(prev => prev.map(r => r.id === row.id ? { ...r, amount: e.target.value } : r))}
                                                    className="hui-input text-sm pl-6 w-full"
                                                />
                                            </div>
                                            <button
                                                onClick={() => setSplitRows(prev => prev.filter(r => r.id !== row.id))}
                                                disabled={splitRows.length === 1}
                                                className="p-1 rounded text-hui-textMuted hover:text-red-500 hover:bg-red-50 disabled:opacity-30 transition"
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex items-center justify-between">
                                    <button
                                        onClick={() => setSplitRows(prev => [...prev, { id: Date.now(), name: "", amount: "" }])}
                                        className="text-xs text-hui-primary hover:underline flex items-center gap-1"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
                                        Add row
                                    </button>
                                    <button
                                        onClick={handleSplit}
                                        disabled={isSplitting || !splitRows.some(r => r.name.trim() && parseFloat(r.amount) > 0)}
                                        className="hui-btn hui-btn-primary text-sm disabled:opacity-50"
                                    >
                                        {isSplitting ? "Saving..." : "Apply schedule"}
                                    </button>
                                </div>
                            </div>
                        )}
                        {showAddMilestone && (
                            <div className="px-6 py-4 border-b border-hui-border bg-amber-50/40">
                                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:items-end">
                                    <div className="col-span-5">
                                        <label className="block text-[11px] uppercase tracking-wide text-hui-textMuted mb-1">Description</label>
                                        <input
                                            type="text"
                                            value={milestoneName}
                                            onChange={e => setMilestoneName(e.target.value)}
                                            placeholder="e.g. Final Payment"
                                            className="hui-input w-full text-sm"
                                        />
                                    </div>
                                    <div className="col-span-3">
                                        <label className="block text-[11px] uppercase tracking-wide text-hui-textMuted mb-1">Amount ($)</label>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={milestoneAmount}
                                            onChange={e => setMilestoneAmount(e.target.value)}
                                            placeholder="0.00"
                                            className="hui-input w-full text-sm"
                                        />
                                    </div>
                                    <div className="col-span-3">
                                        <label className="block text-[11px] uppercase tracking-wide text-hui-textMuted mb-1">Due Date (optional)</label>
                                        <input
                                            type="date"
                                            value={milestoneDueDate}
                                            onChange={e => setMilestoneDueDate(e.target.value)}
                                            className="hui-input w-full text-sm"
                                        />
                                    </div>
                                    <div className="col-span-1">
                                        <button
                                            onClick={handleAddMilestone}
                                            disabled={isAddingMilestone}
                                            className="hui-btn hui-btn-primary text-sm w-full disabled:opacity-50"
                                        >
                                            {isAddingMilestone ? "..." : "Add"}
                                        </button>
                                    </div>
                                </div>
                                <p className="text-[11px] text-hui-textMuted mt-2">
                                    Adds a new payment milestone and increases the invoice total by this amount.
                                </p>
                            </div>
                        )}
                        {editMode && (
                            <div className="px-6 py-3 border-b border-hui-border bg-indigo-50/40 flex items-center justify-between gap-4">
                                <p className="text-xs text-hui-textMuted">
                                    Edit the name, amount, or due date of the pending milestones below. The total must stay
                                    the same — use &quot;Add extra charge&quot; or a change order to change the invoice total.
                                </p>
                                <div className="flex items-center gap-3 shrink-0">
                                    <span className={`text-xs font-medium whitespace-nowrap ${editTotalsMatch ? "text-emerald-600" : "text-red-600"}`}>
                                        Entered {formatCurrency(enteredSum)} / Required {formatCurrency(requiredRemaining)}
                                    </span>
                                    <button
                                        onClick={handleCancelEditMode}
                                        disabled={isSavingEdit}
                                        className="hui-btn hui-btn-secondary text-sm disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleSaveEdit}
                                        disabled={isSavingEdit || !editTotalsMatch}
                                        className="hui-btn hui-btn-primary text-sm disabled:opacity-50"
                                    >
                                        {isSavingEdit ? "Saving..." : "Save"}
                                    </button>
                                </div>
                            </div>
                        )}
                        <div className="overflow-x-auto">
                        <table className="w-full min-w-[34rem] text-sm text-left">
                            <thead className="bg-white text-hui-textMuted border-b border-hui-border">
                                <tr>
                                    <th className="px-4 py-3 w-10 text-center">
                                        <input
                                            type="checkbox"
                                            checked={sendablePayments.length > 0 && sendablePayments.every((p: any) => selectedIds.has(p.id))}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setSelectedIds(new Set(sendablePayments.map((p: any) => p.id)));
                                                } else {
                                                    setSelectedIds(new Set());
                                                }
                                            }}
                                            className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
                                        />
                                    </th>
                                    <th className="px-6 py-3 font-medium">Description</th>
                                    <th className="px-6 py-3 font-medium">Due Date</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Amount</th>
                                    <th className="px-6 py-3 font-medium text-right">Payment Date</th>
                                    <th className="px-6 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {(!initialInvoice.payments || initialInvoice.payments.length === 0) && (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-12 text-center text-hui-textMuted">
                                            <div className="flex flex-col items-center">
                                                <svg className="w-10 h-10 mb-2 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                <p className="font-medium text-hui-textMain">No payment schedule</p>
                                                <p className="text-sm">This invoice has no payment milestones.</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {initialInvoice.payments?.map((payment: any) => {
                                    const isPastDue = payment.dueDate && new Date(payment.dueDate) < new Date() && payment.status !== "Paid";
                                    const methodLabel = formatPaymentMethod(payment.paymentMethod, payment.referenceNumber);
                                    const evidence = payment.status === "Paid" ? checkEvidence[payment.id] : undefined;
                                    const receiptSentLabel = payment.receiptSentAt
                                        ? `Last sent ${new Date(payment.receiptSentAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                                        : undefined;
                                    const isSendable = payment.status !== "Paid" && payment.status !== "Canceled";
                                    const sentLabel = payment.qbInvoiceSentAt
                                        ? `Sent · ${new Date(payment.qbInvoiceSentAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
                                        : null;
                                    return (
                                        <tr key={payment.id} className={`hover:bg-slate-50 transition ${isPastDue ? 'bg-red-50/30' : ''}`}>
                                            <td className="px-4 py-4 w-10 text-center">
                                                {isSendable ? (
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.has(payment.id)}
                                                        onChange={(e) => {
                                                            const newSet = new Set(selectedIds);
                                                            if (e.target.checked) {
                                                                newSet.add(payment.id);
                                                            } else {
                                                                newSet.delete(payment.id);
                                                            }
                                                            setSelectedIds(newSet);
                                                        }}
                                                        className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
                                                    />
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4 font-medium text-hui-textMain">
                                                {editMode && payment.status === 'Pending' ? (
                                                    <>
                                                        <input
                                                            type="text"
                                                            value={editRows[payment.id]?.name ?? ""}
                                                            onChange={(e) => setEditRows(prev => ({ ...prev, [payment.id]: { ...prev[payment.id], name: e.target.value } }))}
                                                            className="hui-input text-sm w-full"
                                                        />
                                                        {payment.qbInvoiceId && (
                                                            <p className="text-[11px] text-amber-700 mt-1">
                                                                QuickBooks invoice will be re-staged at the new amount.
                                                            </p>
                                                        )}
                                                    </>
                                                ) : (
                                                    <>
                                                        <div>{payment.name}</div>
                                                        {payment.status === 'Paid' && methodLabel && (
                                                            <div className="text-[11px] text-hui-textMuted font-normal mt-0.5">{methodLabel}</div>
                                                        )}
                                                        {evidence && (
                                                            <div className="text-[11px] text-hui-textMuted font-normal mt-0.5" title={`Confirmed by ${evidence.confirmedBy}`}>
                                                                Paid by {evidence.payerName ?? "(payer not readable on image)"}, chk#{evidence.checkNumber}
                                                                {evidence.driveFileId && (
                                                                    <>
                                                                        {" · "}
                                                                        <a
                                                                            href={`https://drive.google.com/file/d/${encodeURIComponent(evidence.driveFileId)}/view`}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="font-medium text-hui-primary hover:underline"
                                                                        >
                                                                            check image ↗
                                                                        </a>
                                                                    </>
                                                                )}
                                                            </div>
                                                        )}
                                                        {payment.status !== 'Paid' && sentLabel && (
                                                            <div className="text-[11px] text-emerald-600 font-semibold mt-0.5 flex items-center gap-1">
                                                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                                                {sentLabel}
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted">
                                                {editMode && payment.status === 'Pending' ? (
                                                    <input
                                                        type="date"
                                                        value={editRows[payment.id]?.dueDate ?? ""}
                                                        onChange={(e) => setEditRows(prev => ({ ...prev, [payment.id]: { ...prev[payment.id], dueDate: e.target.value } }))}
                                                        className="hui-input text-sm w-full"
                                                    />
                                                ) : payment.dueDate ? (
                                                    <span className={isPastDue ? 'text-red-600 font-medium' : ''}>
                                                        {new Date(payment.dueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                                        {isPastDue && <span className="ml-1 text-[10px] uppercase font-bold">overdue</span>}
                                                    </span>
                                                ) : 'Upon receipt'}
                                            </td>
                                            <td className="px-6 py-4">
                                                <div className="flex items-center gap-2">
                                                    <StatusBadge status={payment.status} />
                                                    {payment.status !== 'Paid' && payment.qbSyncError && (
                                                        <span
                                                            className="text-[10px] font-bold uppercase text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded"
                                                            title="The linked QuickBooks invoice appears voided or deleted. Use Break QB Link to clear it, then re-create the invoice."
                                                        >
                                                            QB {payment.qbSyncError === 'notFound' ? 'missing' : 'voided'}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 text-right font-medium text-hui-textMain">
                                                {editMode && payment.status === 'Pending' ? (
                                                    <div className="relative">
                                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hui-textMuted text-sm">$</span>
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="0.01"
                                                            value={editRows[payment.id]?.amount ?? ""}
                                                            onChange={(e) => setEditRows(prev => ({ ...prev, [payment.id]: { ...prev[payment.id], amount: e.target.value } }))}
                                                            className="hui-input text-sm pl-6 w-32 text-right"
                                                        />
                                                    </div>
                                                ) : (
                                                    formatCurrency(payment.amount)
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-right text-hui-textMuted">
                                                {payment.paymentDate
                                                    ? formatMoneyDate(payment.paymentDate, { year: 'numeric', month: 'short', day: 'numeric' })
                                                    : '—'}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <div className="flex items-center justify-end gap-2 flex-wrap">
                                                    {editMode && payment.status === 'Pending' && (
                                                        <span className="text-xs text-hui-textMuted italic">Editing…</span>
                                                    )}
                                                    {!editMode && payment.status !== 'Paid' && (
                                                        <>
                                                        <button
                                                            onClick={() => handleQBLink(payment)}
                                                            disabled={qbBusy === payment.id}
                                                            title={payment.qbInvoiceLink ? "Copy the QuickBooks pay link" : "Create a QuickBooks invoice with a hosted pay link (card/ACH)"}
                                                            className="hui-btn hui-btn-secondary py-1 px-3 text-xs w-auto h-8 flex items-center justify-center whitespace-nowrap disabled:opacity-50"
                                                        >
                                                            {qbBusy === payment.id ? "Pushing…" : payment.qbInvoiceLink ? "Copy QB Link" : "QuickBooks Link"}
                                                        </button>
                                                        {isSendable && (
                                                            <button
                                                                onClick={() => {
                                                                    setSelectedIds(new Set([payment.id]));
                                                                    setShowSendMilestonesModal(true);
                                                                }}
                                                                className="hui-btn hui-btn-secondary py-1 px-3 text-xs w-auto h-8 flex items-center justify-center whitespace-nowrap"
                                                                title={payment.qbInvoiceSentAt ? "Resend the payment request email for just this milestone" : "Email the client a payment request for just this milestone"}
                                                            >
                                                                {payment.qbInvoiceSentAt ? "Resend" : "Send"}
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => setRecordingFor({ id: payment.id, name: payment.name, amount: Number(payment.amount) })}
                                                            className="hui-btn hui-btn-primary py-1 px-3 text-xs w-auto h-8 flex items-center justify-center whitespace-nowrap"
                                                        >
                                                            Record Payment
                                                        </button>
                                                        {payment.qbInvoiceId && (
                                                            <button
                                                                onClick={() => handleBreakQBLink(payment)}
                                                                disabled={qbBusy === payment.id}
                                                                title="QuickBooks invoice voided or deleted? Clear the link so you can re-create it."
                                                                className="text-xs text-hui-textMuted hover:text-red-600 underline underline-offset-2 disabled:opacity-50 whitespace-nowrap"
                                                            >
                                                                {qbBusy === payment.id ? "Working…" : "Break QB Link"}
                                                            </button>
                                                        )}
                                                        {payment.status === 'Pending' && !payment.sourceScheduleId && !payment.qbInvoiceId && (
                                                            <button
                                                                onClick={() => setDeleteMilestoneTarget({ id: payment.id, name: payment.name })}
                                                                title="Delete this milestone"
                                                                className="p-1.5 rounded text-hui-textMuted hover:text-red-600 hover:bg-red-50 transition"
                                                            >
                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                                            </button>
                                                        )}
                                                        </>
                                                    )}
                                                    {payment.status === 'Paid' && (
                                                        <>
                                                            <button
                                                                onClick={() => handleSendReceipt(payment.id)}
                                                                disabled={isSendingReceipt === payment.id}
                                                                title={receiptSentLabel}
                                                                className="hui-btn hui-btn-secondary py-1 px-3 text-xs w-auto h-8 disabled:opacity-50 flex items-center justify-center whitespace-nowrap"
                                                            >
                                                                {isSendingReceipt === payment.id
                                                                    ? "Sending..."
                                                                    : payment.receiptSentAt ? "Resend Receipt" : "Send Receipt"}
                                                            </button>
                                                            <button
                                                                onClick={() => setUndoPaymentTarget(payment)}
                                                                className="text-xs text-hui-textMuted hover:text-red-600 underline underline-offset-2"
                                                                title="Mark as unpaid"
                                                            >
                                                                Undo
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        </div>
                    </div>

                </div>
            </div>

            {/* Break QB Link confirm dialog */}
            {breakQBTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setBreakQBTarget(null)}>
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-amber-50/50 rounded-t-xl">
                            <h3 className="text-lg font-semibold text-slate-900">Break QuickBooks Link</h3>
                            <button type="button" onClick={() => setBreakQBTarget(null)} className="text-slate-400 hover:text-slate-600 transition rounded-lg p-1 hover:bg-slate-100">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="px-6 py-4 space-y-3">
                            <p className="text-sm text-slate-700">
                                Break the QuickBooks link for <strong>&quot;{breakQBTarget.name}&quot;</strong>?
                            </p>
                            <p className="text-xs text-slate-500">
                                Use this when the QuickBooks invoice was voided or deleted and this milestone is stuck
                                on &quot;Pending&quot;. It clears the QuickBooks link in ProBuild so you can re-create it fresh
                                with &quot;QuickBooks Link&quot;. It does NOT change the paid/unpaid status.
                            </p>
                            <label className="flex items-start gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={breakQBDeleteInQBO}
                                    onChange={(e) => setBreakQBDeleteInQBO(e.target.checked)}
                                    className="mt-0.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span>
                                    Also delete the staged invoice in QuickBooks.
                                    {breakQBDeleteInQBO
                                        ? " This WILL delete it in QuickBooks (if it has no linked payment)."
                                        : " Leave unchecked to keep the QuickBooks invoice as-is (e.g. a voided invoice kept for audit)."}
                                </span>
                            </label>
                        </div>
                        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50/50 rounded-b-xl">
                            <button type="button" onClick={() => setBreakQBTarget(null)} disabled={qbBusy === breakQBTarget.id} className="hui-btn hui-btn-secondary">
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={confirmBreakQBLink}
                                disabled={qbBusy === breakQBTarget.id}
                                className="hui-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                            >
                                {qbBusy === breakQBTarget.id ? "Working…" : "Break Link"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Milestone confirm dialog */}
            {deleteMilestoneTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setDeleteMilestoneTarget(null)}>
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-red-50/50 rounded-t-xl">
                            <h3 className="text-lg font-semibold text-slate-900">Delete Milestone</h3>
                            <button type="button" onClick={() => setDeleteMilestoneTarget(null)} className="text-slate-400 hover:text-slate-600 transition rounded-lg p-1 hover:bg-slate-100">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="px-6 py-4">
                            <p className="text-sm text-slate-700">
                                Delete <strong>&quot;{deleteMilestoneTarget.name}&quot;</strong>? This removes the milestone and
                                lowers the invoice total by its amount. This cannot be undone.
                            </p>
                        </div>
                        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50/50 rounded-b-xl">
                            <button type="button" onClick={() => setDeleteMilestoneTarget(null)} disabled={isDeletingMilestone} className="hui-btn hui-btn-secondary">
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleDeleteMilestone}
                                disabled={isDeletingMilestone}
                                className="hui-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                            >
                                {isDeletingMilestone ? "Deleting…" : "Delete Milestone"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Send Invoice Modal */}
            {showSendModal && (
                <SendInvoiceModal
                    invoiceId={initialInvoice.id}
                    clientEmail={clientEmail}
                    onClose={() => { setShowSendModal(false); router.refresh(); }}
                />
            )}

            {/* Record Payment Modal */}
            {recordingFor && (
                <RecordPaymentModal
                    milestoneName={recordingFor.name}
                    amount={recordingFor.amount}
                    onClose={() => setRecordingFor(null)}
                    onSubmit={async (input) => {
                        const result = await recordPayment(recordingFor.id, initialInvoice.id, { ...input, method: input.method as string });
                        if (result.success) router.refresh();
                        return { success: result.success, error: (result as any).error };
                    }}
                />
            )}

            {/* Undo Payment Modal */}
            {undoPaymentTarget && (() => {
                const payments = initialInvoice.payments || [];
                const invoiceTotal = Number(initialInvoice.totalAmount) || 0;
                const paidSchedules = payments.filter((p: any) => p.status === "Paid");
                const paidSum = paidSchedules.reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0);
                const currentBalance = Math.max(0, invoiceTotal - paidSum);
                return (
                    <UndoPaymentModal
                        milestoneName={undoPaymentTarget.name || "Payment"}
                        amount={Number(undoPaymentTarget.amount) || 0}
                        paymentMethod={undoPaymentTarget.paymentMethod || null}
                        referenceNumber={undoPaymentTarget.referenceNumber || null}
                        paidAt={undoPaymentTarget.paidAt || null}
                        paymentDate={undoPaymentTarget.paymentDate || null}
                        hasStripeIntent={!!undoPaymentTarget.stripePaymentIntentId}
                        hasQbPayment={undoPaymentTarget.paymentMethod === "quickbooks"}
                        entityLabel="invoice"
                        currentBalance={currentBalance}
                        estimateTotal={invoiceTotal}
                        currentStatus={initialInvoice.status}
                        otherPaidCount={paidSchedules.filter((p: any) => p.id !== undoPaymentTarget.id).length}
                        statusBeforePayment={null}
                        onClose={() => setUndoPaymentTarget(null)}
                        onConfirm={() => handleUnrecord(undoPaymentTarget.id)}
                    />
                );
            })()}

            {selectedIds.size > 0 && (
                <BulkActionBar
                    count={selectedIds.size}
                    onClear={() => setSelectedIds(new Set())}
                    actions={[
                        {
                            label: "Send to client",
                            icon: (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                </svg>
                            ),
                            onClick: () => setShowSendMilestonesModal(true),
                        },
                    ]}
                />
            )}

            {showSendMilestonesModal && (
                <SendMilestonesModal
                    invoiceId={initialInvoice.id}
                    clientEmail={clientEmail}
                    selectedPaymentIds={Array.from(selectedIds)}
                    selectedPayments={initialInvoice.payments?.filter((p: any) => selectedIds.has(p.id)) || []}
                    onClose={() => {
                        setShowSendMilestonesModal(false);
                        setSelectedIds(new Set());
                        router.refresh();
                    }}
                />
            )}
        </div>
    );
}
