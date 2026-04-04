"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateRetainer, deleteRetainer } from "@/lib/actions";
import Link from "next/link";
import { toast } from "sonner";

interface RetainerData {
    id: string;
    code: string;
    status: string;
    totalAmount: number;
    balanceDue: number;
    amountPaid: number;
    notes: string | null;
    dueDate: string | null;
    issueDate: string | null;
    createdAt: string;
}

export default function RetainerEditor({ retainer, projectId }: { retainer: RetainerData; projectId: string }) {
    const router = useRouter();

    const [amount, setAmount] = useState(retainer.totalAmount.toString());
    const [notes, setNotes] = useState(retainer.notes || "");
    const [dueDate, setDueDate] = useState(retainer.dueDate || "");
    const [status, setStatus] = useState(retainer.status);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    async function handleSave() {
        if (!amount || parseFloat(amount) <= 0) {
            toast.error("Amount must be greater than 0");
            return;
        }

        setSaving(true);
        try {
            await updateRetainer(retainer.id, {
                totalAmount: parseFloat(amount),
                notes,
                dueDate: dueDate || null,
                status,
            });
            toast.success("Retainer updated");
            router.refresh();
        } catch {
            toast.error("Failed to update retainer");
        } finally {
            setSaving(false);
        }
    }

    async function handleSend() {
        setSaving(true);
        try {
            await updateRetainer(retainer.id, { status: "Sent" });
            setStatus("Sent");
            toast.success("Retainer marked as Sent");
            router.refresh();
        } catch {
            toast.error("Failed to send retainer");
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Are you sure you want to delete this retainer?")) return;
        setDeleting(true);
        try {
            await deleteRetainer(retainer.id);
            toast.success("Retainer deleted");
            router.push(`/projects/${projectId}/retainers`);
        } catch {
            toast.error("Failed to delete retainer");
            setDeleting(false);
        }
    }

    const statusColor: Record<string, string> = {
        "Draft": "bg-slate-100 text-slate-700",
        "Sent": "bg-blue-100 text-blue-800",
        "Partially Paid": "bg-amber-100 text-amber-800",
        "Paid": "bg-emerald-100 text-emerald-800",
    };

    return (
        <div className="flex-1 flex flex-col items-stretch h-full overflow-hidden">
            <div className="flex-none p-6 pb-4 border-b border-hui-border bg-white flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-bold text-hui-textMain">{retainer.code}</h1>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColor[status] || "bg-slate-100 text-slate-700"}`}>
                            {status}
                        </span>
                    </div>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Created {new Date(retainer.createdAt).toLocaleDateString()}
                        {retainer.amountPaid > 0 && ` \u00b7 $${retainer.amountPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })} paid`}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {status === "Draft" && (
                        <button onClick={handleSend} disabled={saving} className="hui-btn hui-btn-secondary">
                            Send
                        </button>
                    )}
                    <button onClick={handleSave} disabled={saving} className="hui-btn hui-btn-primary">
                        {saving ? "Saving..." : "Save"}
                    </button>
                    <button onClick={handleDelete} disabled={deleting} className="hui-btn hui-btn-secondary text-red-600 hover:bg-red-50">
                        {deleting ? "Deleting..." : "Delete"}
                    </button>
                    <Link href={`/projects/${projectId}/retainers`} className="hui-btn hui-btn-secondary">
                        Back
                    </Link>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                <div className="hui-card p-6 max-w-lg space-y-5">
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Status</label>
                        <select value={status} onChange={(e) => setStatus(e.target.value)} className="hui-input w-full">
                            <option value="Draft">Draft</option>
                            <option value="Sent">Sent</option>
                            <option value="Partially Paid">Partially Paid</option>
                            <option value="Paid">Paid</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Amount</label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hui-textMuted">$</span>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                className="hui-input pl-7 w-full"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Due Date</label>
                        <input
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                            className="hui-input w-full"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Notes</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            className="hui-input w-full"
                            rows={4}
                            placeholder="Notes about this retainer..."
                        />
                    </div>

                    {retainer.amountPaid > 0 && (
                        <div className="border-t border-hui-border pt-4 space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-hui-textMuted">Total Amount</span>
                                <span className="font-medium">${Number(retainer.totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-hui-textMuted">Amount Paid</span>
                                <span className="font-medium text-emerald-600">${retainer.amountPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-hui-textMuted">Balance Due</span>
                                <span className="font-bold">${retainer.balanceDue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
