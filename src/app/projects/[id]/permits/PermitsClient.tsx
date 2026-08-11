"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPermit, updatePermit, deletePermit } from "@/lib/actions";
import { toast } from "sonner";

const STATUS_OPTIONS: { value: string; label: string }[] = [
    { value: "applied", label: "Applied" },
    { value: "issued", label: "Issued" },
    { value: "inspections", label: "In Inspections" },
    { value: "closed", label: "Closed" },
    { value: "expired", label: "Expired" },
];

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
    applied: { bg: "bg-amber-50", text: "text-amber-800", dot: "bg-amber-500" },
    issued: { bg: "bg-green-50", text: "text-green-800", dot: "bg-green-500" },
    inspections: { bg: "bg-blue-50", text: "text-blue-800", dot: "bg-blue-500" },
    closed: { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" },
    expired: { bg: "bg-red-50", text: "text-red-800", dot: "bg-red-500" },
};

const TYPE_SUGGESTIONS = ["Building", "Electrical", "Plumbing", "Mechanical", "Demolition", "Grading"];

function statusLabel(status: string) {
    return STATUS_OPTIONS.find(s => s.value === status)?.label || status;
}

function formatDate(dateStr: string | null) {
    if (!dateStr) return "—";
    // Dates are stored as date-only values at midnight UTC — format in UTC or they render a day early
    return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function toDateInputValue(dateStr: string | null) {
    if (!dateStr) return "";
    return new Date(dateStr).toISOString().split("T")[0];
}

type Permit = {
    id: string;
    projectId: string;
    permitNumber: string;
    type: string | null;
    status: string;
    issuingAuthority: string | null;
    issueDate: string | null;
    expirationDate: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
};

interface Props {
    projectId: string;
    projectName: string;
    initialPermits: Permit[];
}

const emptyForm = {
    permitNumber: "",
    type: "",
    status: "applied",
    issuingAuthority: "",
    issueDate: "",
    expirationDate: "",
    notes: "",
};

export default function PermitsClient({ projectId, projectName, initialPermits }: Props) {
    const router = useRouter();
    const permits = initialPermits;
    const [isPending, startTransition] = useTransition();
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [form, setForm] = useState(emptyForm);

    const openAddModal = () => {
        setEditingId(null);
        setForm(emptyForm);
        setShowForm(true);
    };

    const openEditModal = (permit: Permit) => {
        setEditingId(permit.id);
        setForm({
            permitNumber: permit.permitNumber,
            type: permit.type || "",
            status: permit.status,
            issuingAuthority: permit.issuingAuthority || "",
            issueDate: toDateInputValue(permit.issueDate),
            expirationDate: toDateInputValue(permit.expirationDate),
            notes: permit.notes || "",
        });
        setShowForm(true);
    };

    const closeModal = () => {
        setShowForm(false);
        setEditingId(null);
        setForm(emptyForm);
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.permitNumber.trim()) {
            toast.error("Permit number is required");
            return;
        }

        const payload = {
            permitNumber: form.permitNumber,
            type: form.type || undefined,
            status: form.status || undefined,
            issuingAuthority: form.issuingAuthority || undefined,
            issueDate: form.issueDate || undefined,
            expirationDate: form.expirationDate || undefined,
            notes: form.notes || undefined,
        };

        startTransition(async () => {
            try {
                if (editingId) {
                    await updatePermit(editingId, payload);
                    toast.success("Permit updated");
                } else {
                    await createPermit(projectId, payload);
                    toast.success("Permit added");
                }
                closeModal();
                router.refresh();
            } catch (err: any) {
                toast.error(err.message || "Failed to save permit");
            }
        });
    };

    const handleDelete = async (permitId: string) => {
        if (!confirm("Delete this permit? This cannot be undone.")) return;
        setDeletingId(permitId);
        try {
            await deletePermit(permitId);
            toast.success("Permit deleted");
            router.refresh();
        } catch (err: any) {
            toast.error(err.message || "Failed to delete permit");
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <div className="flex-1 flex flex-col items-stretch h-full overflow-hidden">
            {/* Header */}
            <div className="flex-none p-6 pb-4 border-b border-hui-border bg-white flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Permits</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Track permit numbers, status, and dates for this job.
                    </p>
                </div>
                <button onClick={openAddModal} className="hui-btn hui-btn-primary flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Permit
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                {permits.length === 0 ? (
                    <div className="hui-card p-12 text-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-semibold text-hui-textMain mb-1">No permits yet</h3>
                        <p className="text-sm text-hui-textMuted mb-4">
                            Track building, electrical, and other permits for {projectName} here.
                        </p>
                        <button onClick={openAddModal} className="hui-btn hui-btn-green">
                            Add Permit
                        </button>
                    </div>
                ) : (
                    <div className="hui-card overflow-hidden overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50 border-b border-hui-border text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                    <th className="px-6 py-4 font-medium">Permit #</th>
                                    <th className="px-6 py-4 font-medium">Type</th>
                                    <th className="px-6 py-4 font-medium">Status</th>
                                    <th className="px-6 py-4 font-medium">Authority</th>
                                    <th className="px-6 py-4 font-medium">Issued</th>
                                    <th className="px-6 py-4 font-medium">Expires</th>
                                    <th className="px-6 py-4 font-medium">Notes</th>
                                    <th className="px-6 py-4 font-medium text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border text-sm">
                                {permits.map(permit => {
                                    const styles = STATUS_STYLES[permit.status] || STATUS_STYLES.applied;
                                    return (
                                        <tr key={permit.id} className="hover:bg-slate-50 transition-colors group">
                                            <td className="px-6 py-4 font-mono font-bold text-hui-textMain whitespace-nowrap">
                                                {permit.permitNumber}
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMain">{permit.type || "—"}</td>
                                            <td className="px-6 py-4">
                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${styles.bg} ${styles.text}`}>
                                                    <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`}></span>
                                                    {statusLabel(permit.status)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMain">{permit.issuingAuthority || "—"}</td>
                                            <td className="px-6 py-4 text-hui-textMuted whitespace-nowrap">{formatDate(permit.issueDate)}</td>
                                            <td className="px-6 py-4 text-hui-textMuted whitespace-nowrap">{formatDate(permit.expirationDate)}</td>
                                            <td className="px-6 py-4 text-hui-textMuted max-w-xs truncate" title={permit.notes || undefined}>
                                                {permit.notes || "—"}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <div className="flex justify-end gap-3 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition">
                                                    <button onClick={() => openEditModal(permit)} className="text-blue-600 hover:text-blue-800 font-medium text-sm">
                                                        Edit
                                                    </button>
                                                    <button
                                                        onClick={() => handleDelete(permit.id)}
                                                        disabled={deletingId === permit.id}
                                                        className="text-red-500 hover:text-red-700 font-medium text-sm disabled:opacity-60"
                                                    >
                                                        {deletingId === permit.id ? "Deleting..." : "Delete"}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add/Edit Modal */}
            {showForm && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeModal}>
                    <div
                        className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between p-5 border-b border-hui-border">
                            <h2 className="text-lg font-bold text-hui-textMain">
                                {editingId ? "Edit Permit" : "New Permit"}
                            </h2>
                            <button onClick={closeModal} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                        </div>

                        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">
                                    Permit Number <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={form.permitNumber}
                                    onChange={e => setForm(f => ({ ...f, permitNumber: e.target.value }))}
                                    className="hui-input w-full"
                                    required
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">Type</label>
                                    <input
                                        type="text"
                                        list="permit-type-suggestions"
                                        value={form.type}
                                        onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                                        className="hui-input w-full"
                                        placeholder="Building"
                                    />
                                    <datalist id="permit-type-suggestions">
                                        {TYPE_SUGGESTIONS.map(t => <option key={t} value={t} />)}
                                    </datalist>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">Status</label>
                                    <select
                                        value={form.status}
                                        onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                                        className="hui-input w-full"
                                    >
                                        {STATUS_OPTIONS.map(s => (
                                            <option key={s.value} value={s.value}>{s.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Issuing Authority</label>
                                <input
                                    type="text"
                                    value={form.issuingAuthority}
                                    onChange={e => setForm(f => ({ ...f, issuingAuthority: e.target.value }))}
                                    className="hui-input w-full"
                                    placeholder="e.g. City of Vancouver"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">Issue Date</label>
                                    <input
                                        type="date"
                                        value={form.issueDate}
                                        onChange={e => setForm(f => ({ ...f, issueDate: e.target.value }))}
                                        className="hui-input w-full"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">Expiration Date</label>
                                    <input
                                        type="date"
                                        value={form.expirationDate}
                                        onChange={e => setForm(f => ({ ...f, expirationDate: e.target.value }))}
                                        className="hui-input w-full"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Notes</label>
                                <textarea
                                    value={form.notes}
                                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                                    className="hui-input w-full"
                                    rows={3}
                                />
                            </div>

                            <div className="flex items-center justify-end gap-3 pt-4 border-t border-hui-border">
                                <button type="button" onClick={closeModal} className="hui-btn hui-btn-secondary">
                                    Cancel
                                </button>
                                <button type="submit" disabled={isPending} className="hui-btn hui-btn-primary">
                                    {isPending ? "Saving..." : editingId ? "Save Changes" : "Add Permit"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
