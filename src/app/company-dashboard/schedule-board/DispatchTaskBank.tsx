"use client";

import { useEffect, useState } from "react";
import { getTaskBank, type TaskBankResult } from "@/lib/actions";

export interface DispatchTaskBankItem {
    estimateItemId: string;
    name: string;
    estimatedHours: number | null;
}

interface DispatchTaskBankProps {
    projects: { id: string; name: string; taskCount: number }[];
    selectedProjectId: string;
    refreshKey: number;
    canSchedule: boolean;
    onProjectChange: (projectId: string) => void;
    onSchedule: (item: DispatchTaskBankItem) => void;
}

export function DispatchTaskBank({
    projects,
    selectedProjectId,
    refreshKey,
    canSchedule,
    onProjectChange,
    onSchedule,
}: DispatchTaskBankProps) {
    const [expanded, setExpanded] = useState(true);
    const [result, setResult] = useState<TaskBankResult | null>(null);
    const [resultProjectId, setResultProjectId] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<{ projectId: string; message: string } | null>(null);

    useEffect(() => {
        if (!selectedProjectId) return;
        let cancelled = false;
        Promise.resolve().then(async () => {
            if (cancelled) return;
            setLoading(true);
            setError(null);
            try {
                const next = await getTaskBank(selectedProjectId);
                if (!cancelled) {
                    setResult(next);
                    setResultProjectId(selectedProjectId);
                }
            } catch (cause) {
                if (!cancelled) {
                    setResult(null);
                    setResultProjectId(selectedProjectId);
                    setError({
                        projectId: selectedProjectId,
                        message: cause instanceof Error ? cause.message : "Could not load the task bank",
                    });
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        });
        return () => { cancelled = true; };
    }, [selectedProjectId, refreshKey]);

    if (!expanded) {
        return (
            <aside className="shrink-0 border-t border-hui-border bg-slate-50 p-2 xl:w-14 xl:border-l xl:border-t-0">
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="hui-btn hui-btn-secondary w-full justify-center px-2 text-xs xl:min-h-28 xl:[writing-mode:vertical-rl]"
                    aria-expanded={false}
                >
                    Task bank
                </button>
            </aside>
        );
    }

    const visibleResult = selectedProjectId && resultProjectId === selectedProjectId ? result : null;
    const visibleError = error?.projectId === selectedProjectId ? error.message : null;
    const waitingForSelection = Boolean(selectedProjectId) && resultProjectId !== selectedProjectId;
    const scheduledCount = visibleResult?.scheduledCount ?? 0;
    const totalCount = visibleResult?.totalCount ?? 0;
    const coverage = totalCount > 0 ? Math.round((scheduledCount / totalCount) * 100) : 0;

    return (
        <aside className="shrink-0 border-t border-hui-border bg-slate-50/80 xl:w-80 xl:border-l xl:border-t-0" aria-label="Task bank">
            <div className="flex items-start justify-between gap-3 border-b border-hui-border px-4 py-3">
                <div>
                    <h3 className="text-sm font-semibold text-hui-textMain">Task bank</h3>
                    <p className="mt-0.5 text-xs text-hui-textMuted">Unscheduled contract scope</p>
                </div>
                <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                    aria-label="Collapse Task bank"
                    aria-expanded={true}
                >
                    {"\u2192"}
                </button>
            </div>

            <div className="space-y-4 p-4">
                <div>
                    <label htmlFor="dispatch-task-bank-project" className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Project</label>
                    <select
                        id="dispatch-task-bank-project"
                        value={selectedProjectId}
                        onChange={event => onProjectChange(event.target.value)}
                        className="hui-input mt-1.5 w-full text-sm"
                        disabled={projects.length === 0}
                    >
                        {projects.length === 0
                            ? <option value="">No active projects</option>
                            : projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                </div>

                <div className="rounded-lg border border-hui-border bg-white p-3">
                    <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-semibold text-hui-textMain">Coverage</span>
                        <span className="text-xs font-semibold tabular-nums text-hui-textMuted">{scheduledCount} of {totalCount} items scheduled</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Contract items scheduled" aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage}>
                        <div className="h-full rounded-full bg-hui-primary transition-[width]" style={{ width: `${coverage}%` }} />
                    </div>
                    {visibleResult?.estimate && <p className="mt-2 text-[10px] text-slate-400">Contract estimate {visibleResult.estimate.code}</p>}
                </div>

                <div className="space-y-2">
                    {loading || waitingForSelection ? (
                        <p className="rounded-lg border border-dashed border-hui-border bg-white px-3 py-6 text-center text-xs text-hui-textMuted">Loading contract scope...</p>
                    ) : visibleError ? (
                        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">{visibleError}</p>
                    ) : !visibleResult?.estimate ? (
                        <p className="rounded-lg border border-dashed border-hui-border bg-white px-3 py-6 text-center text-xs text-hui-textMuted">No contract estimate for this project.</p>
                    ) : visibleResult.items.length === 0 ? (
                        <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-4 text-center text-xs font-medium text-green-700">All contract items are scheduled.</p>
                    ) : visibleResult.items.map(item => (
                        <div key={item.estimateItemId} className="rounded-lg border border-hui-border bg-white px-3 py-2.5">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-xs font-semibold leading-5 text-hui-textMain">{item.name}</p>
                                    {item.estimatedHours != null && <p className="mt-0.5 text-[10px] text-hui-textMuted">{item.estimatedHours} estimated hours</p>}
                                </div>
                                {canSchedule && (
                                    <button
                                        type="button"
                                        onClick={() => onSchedule(item)}
                                        className="hui-btn hui-btn-secondary shrink-0 px-2 py-1 text-xs"
                                    >
                                        Schedule
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </aside>
    );
}
