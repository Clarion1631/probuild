"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
    addTaskMaterial,
    deleteTaskMaterial,
    getTaskMaterials,
    importEstimateMaterials,
    setTaskMaterialStatus,
    updateTaskMaterial,
} from "@/lib/actions";
import type { TaskMaterialRow, TaskMaterialStatus } from "@/lib/task-materials-core";

type MaterialRow = TaskMaterialRow & { canDelete: boolean };

const STATUS_STYLES: Record<TaskMaterialStatus, string> = {
    pending: "bg-amber-100 text-amber-800",
    staged: "bg-green-100 text-green-700",
    missing: "bg-red-100 text-red-700",
    resolved: "bg-slate-100 text-slate-600",
};

const EMPTY_DRAFT = { text: "", quantity: "", unit: "", location: "" };

function quantityLabel(row: Pick<MaterialRow, "quantity" | "unit">): string | null {
    if (row.quantity === null && !row.unit) return null;
    return [row.quantity, row.unit].filter(value => value !== null && value !== "").join(" ");
}

function quantityValue(value: string): number | null {
    if (!value.trim()) return null;
    return Number(value);
}

export function TaskMaterialsSection({
    taskId,
    estimateItemId,
}: {
    taskId: string;
    estimateItemId: string | null;
}) {
    const [materials, setMaterials] = useState<MaterialRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [addDraft, setAddDraft] = useState(EMPTY_DRAFT);
    const [editId, setEditId] = useState<string | null>(null);
    const [editDraft, setEditDraft] = useState(EMPTY_DRAFT);
    const [noteTarget, setNoteTarget] = useState<{ id: string; status: "missing" | "resolved" } | null>(null);
    const [noteDraft, setNoteDraft] = useState("");

    async function refresh() {
        const rows = await getTaskMaterials(taskId);
        setMaterials(rows);
    }

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError("");
        getTaskMaterials(taskId)
            .then(rows => {
                if (!cancelled) setMaterials(rows);
            })
            .catch(reason => {
                if (!cancelled) setError(reason?.message || "Materials could not be loaded.");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [taskId]);

    async function run(key: string, action: () => Promise<unknown>, success: string) {
        setBusyKey(key);
        setError("");
        try {
            await action();
            await refresh();
            toast.success(success);
            return true;
        } catch (reason: any) {
            const message = reason?.message || "Material update failed.";
            setError(message);
            toast.error(message);
            return false;
        } finally {
            setBusyKey(null);
        }
    }

    async function handleAdd(event: FormEvent) {
        event.preventDefault();
        const saved = await run("add", () => addTaskMaterial(taskId, {
            text: addDraft.text,
            quantity: quantityValue(addDraft.quantity),
            unit: addDraft.unit || null,
            location: addDraft.location || null,
        }), "Material added");
        if (saved) setAddDraft(EMPTY_DRAFT);
    }

    function beginEdit(row: MaterialRow) {
        setEditId(row.id);
        setEditDraft({
            text: row.text,
            quantity: row.quantity?.toString() ?? "",
            unit: row.unit ?? "",
            location: row.location ?? "",
        });
    }

    async function saveEdit(event: FormEvent) {
        event.preventDefault();
        if (!editId) return;
        const saved = await run(`edit:${editId}`, () => updateTaskMaterial(editId, {
            text: editDraft.text,
            quantity: quantityValue(editDraft.quantity),
            unit: editDraft.unit || null,
            location: editDraft.location || null,
        }), "Material updated");
        if (saved) setEditId(null);
    }

    function requestNotedStatus(id: string, status: "missing" | "resolved", existingNote?: string | null) {
        setNoteTarget({ id, status });
        setNoteDraft(existingNote ?? "");
    }

    async function saveNotedStatus(event: FormEvent) {
        event.preventDefault();
        if (!noteTarget) return;
        if (noteTarget.status === "resolved" && !noteDraft.trim()) {
            setError("Resolved materials require a resolution note.");
            return;
        }
        const saved = await run(
            `status:${noteTarget.id}`,
            () => setTaskMaterialStatus(noteTarget.id, noteTarget.status, noteDraft || null),
            noteTarget.status === "missing" ? "Material marked missing" : "Material resolved",
        );
        if (saved) {
            setNoteTarget(null);
            setNoteDraft("");
        }
    }

    async function handleImport() {
        setBusyKey("import");
        setError("");
        try {
            const result = await importEstimateMaterials(taskId);
            await refresh();
            if (result.created === 0) {
                toast.info("Estimate materials are already on this task.");
            } else {
                toast.success(`${result.created} estimate material${result.created === 1 ? "" : "s"} imported`);
            }
        } catch (reason: any) {
            const message = reason?.message || "Estimate materials could not be imported.";
            setError(message);
            toast.error(message);
        } finally {
            setBusyKey(null);
        }
    }

    return (
        <details open className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-2 select-none [&::-webkit-details-marker]:hidden">
                <svg className="h-3.5 w-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
                <span className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted">Materials</span>
                {!loading && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                        {materials.length}
                    </span>
                )}
            </summary>

            <div className="space-y-3 pb-4 pl-5.5">
                {error && (
                    <p className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700" role="alert">
                        {error}
                    </p>
                )}

                {loading ? (
                    <p className="py-3 text-xs text-slate-400">Loading materials...</p>
                ) : materials.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 px-3 py-4">
                        <p className="text-xs font-semibold text-slate-600">No staging list yet</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-400">
                            Add the first jobsite item{estimateItemId ? " or pull material lines from the linked estimate" : ""}.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {materials.map(row => (
                            <div key={row.id} className="group/material rounded-lg border border-slate-200 bg-white p-2.5">
                                {editId === row.id ? (
                                    <form onSubmit={saveEdit} className="space-y-2">
                                        <input
                                            value={editDraft.text}
                                            onChange={event => setEditDraft(current => ({ ...current, text: event.target.value }))}
                                            className="hui-input w-full text-xs"
                                            aria-label="Material text"
                                            autoFocus
                                        />
                                        <div className="grid grid-cols-2 gap-2">
                                            <input type="number" min="0" step="any" value={editDraft.quantity} onChange={event => setEditDraft(current => ({ ...current, quantity: event.target.value }))} className="hui-input text-xs" placeholder="Qty" aria-label="Quantity" />
                                            <input value={editDraft.unit} onChange={event => setEditDraft(current => ({ ...current, unit: event.target.value }))} className="hui-input text-xs" placeholder="Unit" aria-label="Unit" />
                                        </div>
                                        <input value={editDraft.location} onChange={event => setEditDraft(current => ({ ...current, location: event.target.value }))} className="hui-input w-full text-xs" placeholder="Location" aria-label="Location" />
                                        <div className="flex gap-2">
                                            <button type="submit" disabled={busyKey !== null} className="hui-btn hui-btn-green text-xs">Save changes</button>
                                            <button type="button" onClick={() => setEditId(null)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                                        </div>
                                    </form>
                                ) : (
                                    <>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="text-xs font-semibold leading-relaxed text-hui-textMain">
                                                    {row.text}
                                                    {quantityLabel(row) && <span className="font-normal text-slate-500"> {"\u00B7"} {quantityLabel(row)}</span>}
                                                </p>
                                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                                    {row.location && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">{row.location}</span>}
                                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLES[row.status]}`}>{row.status}</span>
                                                    {row.sourceKind !== "manual" && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{row.sourceKind}</span>}
                                                </div>
                                                {row.resolutionNote && <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{row.resolutionNote}</p>}
                                            </div>
                                            <div className="flex shrink-0 gap-1 opacity-0 pointer-events-none transition group-hover/material:opacity-100 group-hover/material:pointer-events-auto group-focus-within/material:opacity-100 group-focus-within/material:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                                <button type="button" onClick={() => beginEdit(row)} className="rounded px-1.5 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50">Edit</button>
                                                {row.canDelete && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            if (window.confirm(`Delete "${row.text}"?`)) {
                                                                void run(`delete:${row.id}`, () => deleteTaskMaterial(row.id), "Material deleted");
                                                            }
                                                        }}
                                                        className="rounded px-1.5 py-1 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                                                    >
                                                        Delete
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            {(["pending", "staged"] as const).map(status => (
                                                <button
                                                    key={status}
                                                    type="button"
                                                    disabled={busyKey !== null || row.status === status}
                                                    onClick={() => void run(`status:${row.id}`, () => setTaskMaterialStatus(row.id, status), `Material marked ${status}`)}
                                                    className="rounded border border-slate-200 px-2 py-1 text-[10px] font-semibold capitalize text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                                                >
                                                    {status}
                                                </button>
                                            ))}
                                            <button type="button" disabled={busyKey !== null || row.status === "missing"} onClick={() => requestNotedStatus(row.id, "missing", row.resolutionNote)} className="rounded border border-red-200 px-2 py-1 text-[10px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-40">Missing</button>
                                            <button type="button" disabled={busyKey !== null || row.status === "resolved"} onClick={() => requestNotedStatus(row.id, "resolved", row.resolutionNote)} className="rounded border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">Resolved</button>
                                        </div>
                                        {noteTarget?.id === row.id && (
                                            <form onSubmit={saveNotedStatus} className="mt-2 flex gap-2">
                                                <input
                                                    value={noteDraft}
                                                    onChange={event => setNoteDraft(event.target.value)}
                                                    className="hui-input min-w-0 flex-1 text-xs"
                                                    placeholder={noteTarget.status === "missing" ? "What is missing?" : "How was it resolved?"}
                                                    aria-label="Material status note"
                                                    autoFocus
                                                />
                                                <button type="submit" className="hui-btn hui-btn-green text-xs">Set {noteTarget.status}</button>
                                                <button type="button" onClick={() => setNoteTarget(null)} className="hui-btn hui-btn-secondary px-2 text-xs" aria-label="Cancel status note">{"\u00D7"}</button>
                                            </form>
                                        )}
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                <form onSubmit={handleAdd} className="space-y-2 rounded-lg bg-slate-50 p-2.5">
                    <input value={addDraft.text} onChange={event => setAddDraft(current => ({ ...current, text: event.target.value }))} className="hui-input w-full text-xs" placeholder="Add material or supply" aria-label="New material text" />
                    <div className="grid grid-cols-3 gap-2">
                        <input type="number" min="0" step="any" value={addDraft.quantity} onChange={event => setAddDraft(current => ({ ...current, quantity: event.target.value }))} className="hui-input text-xs" placeholder="Qty" aria-label="New material quantity" />
                        <input value={addDraft.unit} onChange={event => setAddDraft(current => ({ ...current, unit: event.target.value }))} className="hui-input text-xs" placeholder="Unit" aria-label="New material unit" />
                        <input value={addDraft.location} onChange={event => setAddDraft(current => ({ ...current, location: event.target.value }))} className="hui-input text-xs" placeholder="Location" aria-label="New material location" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busyKey !== null || !addDraft.text.trim()} className="hui-btn hui-btn-green text-xs disabled:opacity-50">Add material</button>
                        {estimateItemId && (
                            <button
                                type="button"
                                disabled={busyKey !== null}
                                onClick={() => void handleImport()}
                                className="hui-btn hui-btn-secondary text-xs disabled:opacity-50"
                            >
                                Import estimate
                            </button>
                        )}
                    </div>
                </form>
            </div>
        </details>
    );
}
