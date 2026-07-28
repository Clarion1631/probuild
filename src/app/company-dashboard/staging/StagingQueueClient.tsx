"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { getStagingQueue, setTaskMaterialStatus } from "@/lib/actions";
import type { StagingQueue, TaskMaterialStatus } from "@/lib/task-materials-core";

const STATUS_STYLES: Record<TaskMaterialStatus, string> = {
    pending: "bg-amber-100 text-amber-800",
    staged: "bg-green-100 text-green-700",
    missing: "bg-red-100 text-red-700",
    resolved: "bg-slate-100 text-slate-600",
};

function localDayISO(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function todayISO(): string {
    return localDayISO(new Date());
}

function tomorrowISO(): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return localDayISO(tomorrow);
}

function readableDay(dayISO: string): string {
    return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
    }).format(new Date(`${dayISO}T00:00:00.000Z`));
}

function materialQuantity(quantity: number | null, unit: string | null): string | null {
    if (quantity === null && !unit) return null;
    return [quantity, unit].filter(value => value !== null && value !== "").join(" ");
}

export function StagingQueueClient() {
    const [dayISO, setDayISO] = useState(tomorrowISO);
    const [queue, setQueue] = useState<StagingQueue | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [busyId, setBusyId] = useState<string | null>(null);
    const [missingId, setMissingId] = useState<string | null>(null);
    const [missingNote, setMissingNote] = useState("");

    async function load(day: string) {
        const next = await getStagingQueue(day);
        setQueue(next);
    }

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError("");
        getStagingQueue(dayISO)
            .then(next => {
                if (!cancelled) setQueue(next);
            })
            .catch(reason => {
                if (!cancelled) setError(reason?.message || "The staging queue could not be loaded.");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [dayISO]);

    async function changeStatus(
        materialId: string,
        status: TaskMaterialStatus,
        note?: string | null,
    ) {
        setBusyId(materialId);
        setError("");
        try {
            await setTaskMaterialStatus(materialId, status, note);
            await load(dayISO);
            toast.success(status === "staged" ? "Material staged" : status === "missing" ? "Material marked missing" : "Material returned to pending");
        } catch (reason: any) {
            const message = reason?.message || "Material status could not be updated.";
            setError(message);
            toast.error(message);
        } finally {
            setBusyId(null);
        }
    }

    async function submitMissing(event: FormEvent) {
        event.preventDefault();
        if (!missingId || !missingNote.trim()) {
            setError("Add a short note so the office knows what is missing.");
            return;
        }
        await changeStatus(missingId, "missing", missingNote);
        setMissingId(null);
        setMissingNote("");
    }

    const today = todayISO();
    const total = queue
        ? queue.counts.pending + queue.counts.staged + queue.counts.missing
        : 0;

    return (
        <main className="min-h-screen bg-slate-50">
            <div className="mx-auto max-w-3xl px-3 py-4 sm:px-5 sm:py-6">
                <header className="rounded-xl border border-hui-border bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <Link href="/company-dashboard" className="text-xs font-semibold text-hui-primary hover:underline">
                                {"\u2190"} Dispatch
                            </Link>
                            <h1 className="mt-2 text-xl font-bold tracking-tight text-hui-textMain">Staging queue</h1>
                            <p className="mt-1 text-sm text-hui-textMuted">Load the truck and jobsite before the crew arrives.</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-right">
                            <p className="text-lg font-bold tabular-nums text-hui-textMain">
                                {queue?.counts.staged ?? 0} of {total} staged
                            </p>
                            <p className={`text-xs font-semibold ${(queue?.counts.missing ?? 0) > 0 ? "text-red-600" : "text-slate-500"}`}>
                                {queue?.counts.missing ?? 0} missing
                            </p>
                        </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
                        <label className="min-w-44 flex-1 text-xs font-semibold uppercase tracking-wider text-hui-textMuted">
                            Staging day
                            <input
                                type="date"
                                value={dayISO}
                                onChange={event => setDayISO(event.target.value)}
                                className="hui-input mt-1.5 w-full text-sm"
                            />
                        </label>
                        <button type="button" onClick={() => setDayISO(today)} className="hui-btn hui-btn-secondary min-h-10 text-sm">
                            Today
                        </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">{readableDay(dayISO)}{dayISO === tomorrowISO() ? " \u00B7 tomorrow's default run" : ""}</p>
                </header>

                {error && (
                    <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
                        {error}
                    </p>
                )}

                {loading ? (
                    <div className="mt-4 rounded-xl border border-hui-border bg-white px-4 py-12 text-center text-sm text-hui-textMuted">
                        Loading the staging run...
                    </div>
                ) : !queue || queue.projects.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-dashed border-hui-border bg-white px-4 py-12 text-center">
                        <p className="text-sm font-semibold text-hui-textMain">Nothing to stage for this day</p>
                        <p className="mt-1 text-sm text-hui-textMuted">Choose another day or add materials from a task’s Details panel.</p>
                    </div>
                ) : (
                    <div className="mt-4 space-y-4">
                        {queue.projects.map(project => (
                            <section key={project.projectId} className="overflow-hidden rounded-xl border border-hui-border bg-white shadow-sm">
                                <div className="flex items-start gap-3 border-b border-hui-border px-4 py-3">
                                    <span
                                        className="mt-1 h-4 w-1.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: project.projectColor || "#64748b" }}
                                        aria-hidden="true"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <Link href={`/projects/${project.projectId}`} className="font-bold text-hui-textMain hover:text-hui-primary hover:underline">
                                            {project.projectName}
                                        </Link>
                                        {project.projectLocation && <p className="mt-0.5 text-xs text-hui-textMuted">{project.projectLocation}</p>}
                                    </div>
                                    <div className="shrink-0 text-right text-[11px] font-semibold tabular-nums text-slate-500">
                                        <p>{project.counts.staged} staged</p>
                                        {project.counts.missing > 0 && <p className="text-red-600">{project.counts.missing} missing</p>}
                                    </div>
                                </div>

                                <div className="divide-y divide-slate-100">
                                    {project.materials.map(material => {
                                        const quantity = materialQuantity(material.quantity, material.unit);
                                        return (
                                            <article key={material.id} className={`px-4 py-3 ${material.status === "missing" ? "bg-red-50/40" : ""}`}>
                                                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{material.taskName}</p>
                                                <div className="mt-1 flex items-start gap-3">
                                                    <label className="flex min-h-12 min-w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl border-2 border-green-200 bg-green-50 focus-within:ring-2 focus-within:ring-green-500">
                                                        <input
                                                            type="checkbox"
                                                            checked={material.status === "staged"}
                                                            disabled={busyId !== null}
                                                            onChange={event => void changeStatus(material.id, event.target.checked ? "staged" : "pending")}
                                                            className="h-6 w-6 accent-green-600"
                                                            aria-label={`Mark ${material.text} staged`}
                                                        />
                                                    </label>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-semibold leading-snug text-hui-textMain">
                                                            {material.text}
                                                            {quantity && <span className="font-normal text-slate-500"> {"\u00B7"} {quantity}</span>}
                                                        </p>
                                                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                                            {material.location && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">{material.location}</span>}
                                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLES[material.status]}`}>{material.status}</span>
                                                        </div>
                                                        {material.resolutionNote && <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{material.resolutionNote}</p>}
                                                    </div>
                                                    <button
                                                        type="button"
                                                        disabled={busyId !== null}
                                                        onClick={() => {
                                                            setMissingId(material.id);
                                                            setMissingNote(material.status === "missing" ? material.resolutionNote ?? "" : "");
                                                        }}
                                                        className="min-h-11 shrink-0 rounded-lg border border-red-200 px-3 text-xs font-bold text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                                                    >
                                                        Missing
                                                    </button>
                                                </div>

                                                {missingId === material.id && (
                                                    <form onSubmit={submitMissing} className="mt-3 flex flex-col gap-2 rounded-lg border border-red-100 bg-red-50 p-2.5 sm:flex-row">
                                                        <input
                                                            value={missingNote}
                                                            onChange={event => setMissingNote(event.target.value)}
                                                            className="hui-input min-h-11 min-w-0 flex-1 text-sm"
                                                            placeholder="What is missing or delayed?"
                                                            aria-label="Missing material note"
                                                            autoFocus
                                                        />
                                                        <button type="submit" disabled={busyId !== null} className="hui-btn min-h-11 bg-red-600 text-sm text-white hover:bg-red-700 disabled:opacity-50">Mark missing</button>
                                                        <button type="button" onClick={() => setMissingId(null)} className="hui-btn hui-btn-secondary min-h-11 text-sm">Cancel</button>
                                                    </form>
                                                )}
                                            </article>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
