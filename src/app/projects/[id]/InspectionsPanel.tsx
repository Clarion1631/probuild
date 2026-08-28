"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInspection, updateInspection } from "@/lib/actions";
import { toast } from "sonner";

const RESULTS = [
    { value: "SCHEDULED", label: "Scheduled" },
    { value: "PASSED", label: "Passed" },
    { value: "FAILED", label: "Failed" },
    { value: "PARTIAL", label: "Partial" },
] as const;

const RESULT_STYLES: Record<string, string> = {
    SCHEDULED: "bg-blue-50 text-blue-800 border-blue-200",
    PASSED: "bg-emerald-50 text-emerald-800 border-emerald-200",
    FAILED: "bg-amber-50 text-amber-900 border-amber-200",
    PARTIAL: "bg-slate-100 text-slate-700 border-slate-200",
};

type Inspection = {
    id: string;
    type: string;
    result: string;
    scheduledDate: Date | string | null;
    performedDate: Date | string | null;
    inspector: string | null;
    notes: string | null;
    customerNote: string | null;
    sharedToPortal: boolean;
};

type FormState = {
    type: string;
    result: string;
    scheduledDate: string;
    performedDate: string;
    inspector: string;
    notes: string;
    customerNote: string;
    sharedToPortal: boolean;
};

const emptyForm: FormState = {
    type: "",
    result: "SCHEDULED",
    scheduledDate: "",
    performedDate: "",
    inspector: "",
    notes: "",
    customerNote: "",
    sharedToPortal: false,
};

function dateInputValue(value: Date | string | null): string {
    if (!value) return "";
    return new Date(value).toISOString().slice(0, 10);
}

function formatDate(value: Date | string | null): string {
    if (!value) return "—";
    return new Date(value).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
}

function resultLabel(result: string): string {
    return RESULTS.find(item => item.value === result)?.label ?? result;
}

export default function InspectionsPanel({ projectId, initialInspections }: {
    projectId: string;
    initialInspections: Inspection[];
}) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [editing, setEditing] = useState<Inspection | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState<FormState>(emptyForm);

    const openNew = () => {
        setEditing(null);
        setForm(emptyForm);
        setShowForm(true);
    };

    const openEdit = (inspection: Inspection) => {
        setEditing(inspection);
        setForm({
            type: inspection.type,
            result: inspection.result,
            scheduledDate: dateInputValue(inspection.scheduledDate),
            performedDate: dateInputValue(inspection.performedDate),
            inspector: inspection.inspector ?? "",
            notes: inspection.notes ?? "",
            customerNote: inspection.customerNote ?? "",
            sharedToPortal: inspection.sharedToPortal,
        });
        setShowForm(true);
    };

    const closeForm = () => {
        setShowForm(false);
        setEditing(null);
        setForm(emptyForm);
    };

    const save = (event: React.FormEvent) => {
        event.preventDefault();
        if (!form.type.trim()) {
            toast.error("Inspection type is required");
            return;
        }
        const date = form.result === "SCHEDULED" ? form.scheduledDate : form.performedDate;
        if (!date) {
            toast.error(form.result === "SCHEDULED" ? "Choose the scheduled date" : "Choose the performed date");
            return;
        }
        startTransition(async () => {
            try {
                if (editing) {
                    await updateInspection(editing.id, form);
                    toast.success("Inspection updated");
                } else {
                    await createInspection(projectId, form);
                    toast.success("Inspection added");
                }
                closeForm();
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not save inspection");
            }
        });
    };

    const toggleShare = (inspection: Inspection, sharedToPortal: boolean) => {
        startTransition(async () => {
            try {
                await updateInspection(inspection.id, { sharedToPortal });
                toast.success(sharedToPortal ? "Shared to client portal" : "Removed from client portal");
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not update portal sharing");
            }
        });
    };

    return (
        <section className="hui-card p-5 mb-8" aria-labelledby="inspections-heading">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                <div>
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center" aria-hidden>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.6-2.6a9 9 0 11-13.2 0 9 9 0 0113.2 0z" /></svg>
                        </div>
                        <h2 id="inspections-heading" className="font-semibold text-hui-textMain">Inspections</h2>
                    </div>
                    <p className="text-sm text-hui-textMuted mt-1">Record field results. You control each row shared with the client.</p>
                </div>
                <button type="button" onClick={openNew} className="hui-btn hui-btn-primary self-start sm:self-auto">Add inspection</button>
            </div>

            {initialInspections.length === 0 ? (
                <div className="rounded-lg border border-dashed border-hui-border px-4 py-6 text-sm text-hui-textMuted text-center">
                    No inspections recorded. Add the next scheduled inspection or a completed result.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-hui-border">
                    <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-hui-textMuted">
                            <tr>
                                <th className="px-4 py-3 font-semibold">Inspection</th>
                                <th className="px-4 py-3 font-semibold">Result</th>
                                <th className="px-4 py-3 font-semibold">Date</th>
                                <th className="px-4 py-3 font-semibold">Client portal</th>
                                <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hui-border bg-white">
                            {initialInspections.map(inspection => (
                                <tr key={inspection.id}>
                                    <td className="px-4 py-3">
                                        <p className="font-medium text-hui-textMain">{inspection.type}</p>
                                        {inspection.inspector && <p className="text-xs text-hui-textMuted mt-0.5">{inspection.inspector}</p>}
                                    </td>
                                    <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${RESULT_STYLES[inspection.result] ?? RESULT_STYLES.PARTIAL}`}>{resultLabel(inspection.result)}</span></td>
                                    <td className="px-4 py-3 text-hui-textMuted">{formatDate(inspection.result === "SCHEDULED" ? inspection.scheduledDate : inspection.performedDate)}</td>
                                    <td className="px-4 py-3">
                                        <label className="inline-flex items-center gap-2 cursor-pointer">
                                            <input type="checkbox" checked={inspection.sharedToPortal} disabled={isPending} onChange={event => toggleShare(inspection, event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                                            <span className="text-xs text-hui-textMuted">{inspection.sharedToPortal ? "Shared" : "Private"}</span>
                                        </label>
                                    </td>
                                    <td className="px-4 py-3 text-right"><button type="button" onClick={() => openEdit(inspection)} className="text-sm font-medium text-blue-700 hover:text-blue-900">Record result</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {showForm && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/45 p-0 sm:p-4">
                    <form onSubmit={save} className="w-full max-w-xl rounded-t-2xl sm:rounded-2xl bg-white shadow-xl max-h-[92vh] overflow-y-auto">
                        <div className="p-5 border-b border-hui-border flex items-start justify-between gap-4">
                            <div><h3 className="font-semibold text-hui-textMain">{editing ? "Record inspection result" : "Add inspection"}</h3><p className="text-sm text-hui-textMuted mt-1">Internal notes stay private. Client text is a separate field.</p></div>
                            <button type="button" onClick={closeForm} className="text-hui-textMuted hover:text-hui-textMain" aria-label="Close inspection form">×</button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className="text-sm font-medium text-hui-textMain">Type<input autoFocus value={form.type} onChange={event => setForm(current => ({ ...current, type: event.target.value }))} className="hui-input w-full mt-1" placeholder="Electrical rough-in" /></label>
                                <label className="text-sm font-medium text-hui-textMain">Result<select value={form.result} onChange={event => setForm(current => ({ ...current, result: event.target.value, sharedToPortal: event.target.value === "PASSED" }))} className="hui-input w-full mt-1">{RESULTS.map(result => <option key={result.value} value={result.value}>{result.label}</option>)}</select></label>
                            </div>
                            {form.result === "SCHEDULED" ? (
                                <label className="block text-sm font-medium text-hui-textMain">Scheduled date<input type="date" value={form.scheduledDate} onChange={event => setForm(current => ({ ...current, scheduledDate: event.target.value }))} className="hui-input w-full mt-1" required /></label>
                            ) : (
                                <label className="block text-sm font-medium text-hui-textMain">Performed date<input type="date" value={form.performedDate} onChange={event => setForm(current => ({ ...current, performedDate: event.target.value }))} className="hui-input w-full mt-1" required /></label>
                            )}
                            <label className="block text-sm font-medium text-hui-textMain">Inspector<input value={form.inspector} onChange={event => setForm(current => ({ ...current, inspector: event.target.value }))} className="hui-input w-full mt-1" placeholder="Name or agency" /></label>
                            <label className="block text-sm font-medium text-hui-textMain">Internal notes<textarea value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} className="hui-input w-full mt-1" rows={3} /></label>
                            <label className="block text-sm font-medium text-hui-textMain">Client note <span className="font-normal text-hui-textMuted">(optional)</span><textarea value={form.customerNote} onChange={event => setForm(current => ({ ...current, customerNote: event.target.value }))} className="hui-input w-full mt-1" rows={2} placeholder="What the client should know" /></label>
                            <label className="flex items-start gap-3 rounded-lg bg-slate-50 border border-hui-border p-3 cursor-pointer"><input type="checkbox" checked={form.sharedToPortal} onChange={event => setForm(current => ({ ...current, sharedToPortal: event.target.checked }))} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" /><span><span className="block text-sm font-medium text-hui-textMain">Share to client portal</span><span className="block text-xs text-hui-textMuted mt-0.5">Passed inspections share by default. Failed and partial results remain private unless you choose to share them.</span></span></label>
                        </div>
                        <div className="p-5 border-t border-hui-border flex justify-end gap-3"><button type="button" onClick={closeForm} className="hui-btn hui-btn-secondary">Cancel</button><button type="submit" disabled={isPending} className="hui-btn hui-btn-primary">{isPending ? "Saving…" : editing ? "Save result" : "Add inspection"}</button></div>
                    </form>
                </div>
            )}
        </section>
    );
}
