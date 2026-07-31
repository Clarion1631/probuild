"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DashboardProjectRow } from "@/lib/schedule-core";
import {
    updateProjectColor,
    updateProjectEndDateAction,
    updateProjectStartDateAction,
} from "@/lib/actions";
import {
    formatDate,
    getFallbackProjectColor,
    PRESET_COLORS,
} from "@/app/projects/[id]/schedule/schedule-utils";
import ColorWheel from "@/app/projects/[id]/schedule/ColorWheel";
import { getEffectiveProjectRange } from "./useBarLayout";
import { BoardDrawerShell } from "./BoardDrawerShell";
import { CrewPicker } from "./CrewPickers";

interface BoardProjectDrawerProps {
    project: DashboardProjectRow | null;
    teamMembers: { id: string; name: string; email: string }[];
    isPending: boolean;
    onMoveCommit: (project: DashboardProjectRow, targetStart: string) => void;
    onClose: () => void;
}

const STATUS_STYLES: Record<string, string> = {
    "Waiting to Start": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    "Substantial Completion": "bg-green-100 text-green-700",
    "Complete": "bg-green-100 text-green-700",
};

function ProjectDrawerContent({
    project,
    teamMembers,
    isPending,
    onMoveCommit,
    onClose,
}: Omit<BoardProjectDrawerProps, "project"> & { project: DashboardProjectRow }) {
    const router = useRouter();
    const projectRange = getEffectiveProjectRange(project);
    const projectStart = projectRange ? formatDate(projectRange.start) : "";
    const projectEndDate = project.endDate ? project.endDate.slice(0, 10) : "";
    const canMoveProject = project.status === "Waiting to Start" || project.status === "In Progress";
    const actionResetKey = `${project.id}:${isPending ? "pending" : "ready"}:${projectStart}:${projectEndDate}`;
    const [targetStartDraft, setTargetStartDraft] = useState(() => ({ resetKey: actionResetKey, value: projectStart }));
    const targetStart = targetStartDraft.resetKey === actionResetKey ? targetStartDraft.value : projectStart;
    if (targetStartDraft.resetKey !== actionResetKey) {
        setTargetStartDraft({ resetKey: actionResetKey, value: projectStart });
    }
    const [endDateDraft, setEndDateDraft] = useState(() => ({ resetKey: actionResetKey, value: projectEndDate }));
    const endDateValue = endDateDraft.resetKey === actionResetKey ? endDateDraft.value : projectEndDate;
    if (endDateDraft.resetKey !== actionResetKey) {
        setEndDateDraft({ resetKey: actionResetKey, value: projectEndDate });
    }
    const [isColorPending, startColorTransition] = useTransition();
    const [isEndDatePending, startEndDateTransition] = useTransition();
    const [isRemovePending, startRemoveTransition] = useTransition();
    const isDrawerActionPending = isColorPending || isEndDatePending || isRemovePending;
    const projectColor = project.color || getFallbackProjectColor(project.id);

    function handleDateSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (canMoveProject && targetStart && !isPending) {
            onMoveCommit(project, targetStart);
        }
        if (endDateValue !== projectEndDate) {
            submitEndDate(endDateValue || null);
        }
    }

    function submitEndDate(value: string | null) {
        startEndDateTransition(async () => {
            try {
                await updateProjectEndDateAction(project.id, value);
                router.refresh();
                toast.success(value ? "End date set" : "End date cleared");
            } catch (err: any) {
                toast.error(err?.message || "Failed to update end date");
            }
        });
    }

    function submitColor(color: string) {
        startColorTransition(async () => {
            try {
                await updateProjectColor(project.id, color);
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Failed to update color");
            }
        });
    }

    function handleRemoveFromSchedule() {
        if (!window.confirm(`Remove "${project.name}" from the schedule? This clears its start date — the project moves back to Unscheduled.`)) return;
        startRemoveTransition(async () => {
            try {
                await updateProjectStartDateAction(project.id, null, false);
                router.refresh();
                toast.success("Removed from schedule");
                onClose();
            } catch (err: any) {
                toast.error(err?.message || "Failed to remove from schedule");
            }
        });
    }

    return (
        <div className="flex h-full flex-col bg-white" aria-busy={isPending || isDrawerActionPending}>
            <div className="flex items-start justify-between gap-4 border-b border-hui-border bg-slate-50 px-5 py-4">
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10" style={{ backgroundColor: projectColor }} aria-hidden="true" />
                        <h1 className="min-w-0 truncate text-base font-bold text-hui-textMain">{project.name}</h1>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[project.status] ?? "bg-slate-100 text-slate-700"}`}>
                            {project.status}
                        </span>
                        <Link href={`/projects/${project.id}`} className="text-xs font-semibold text-hui-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                            Open project →
                        </Link>
                    </div>
                    {project.distanceMilesFromShop != null && (
                        <p className="mt-1.5 text-xs text-hui-textMuted">≈{project.distanceMilesFromShop} mi from shop</p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close project details"
                    className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <section className="border-b border-hui-border px-5 py-5">
                    <h2 className="mb-4 text-sm font-semibold text-hui-textMain">Dates</h2>
                    <form onSubmit={handleDateSubmit} className="space-y-4">
                        {canMoveProject && (
                            <div>
                                <label className="block text-xs font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`drawer-project-start-${project.id}`}>Start date</label>
                                <input
                                    id={`drawer-project-start-${project.id}`}
                                    type="date"
                                    value={targetStart}
                                    onChange={event => setTargetStartDraft({ resetKey: actionResetKey, value: event.target.value })}
                                    disabled={isPending || isDrawerActionPending}
                                    className="hui-input mt-1 w-full"
                                />
                                <p className="mt-1 text-xs text-hui-textMuted">Joins unsaved changes — Save to commit.</p>
                            </div>
                        )}
                        <div>
                            <label className="block text-xs font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`drawer-project-end-${project.id}`}>End date</label>
                            <input
                                id={`drawer-project-end-${project.id}`}
                                type="date"
                                value={endDateValue}
                                onChange={event => setEndDateDraft({ resetKey: actionResetKey, value: event.target.value })}
                                disabled={isDrawerActionPending}
                                className="hui-input mt-1 w-full"
                            />
                            <p className="mt-1 text-xs text-hui-textMuted">Saves immediately.</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <button type="button" disabled={isDrawerActionPending || !project.endDate} onClick={() => submitEndDate(null)} className="hui-btn hui-btn-secondary justify-center text-xs disabled:opacity-60">
                                Clear end date
                            </button>
                            <button type="submit" disabled={isDrawerActionPending || (canMoveProject && (isPending || !targetStart))} className="hui-btn hui-btn-primary justify-center text-xs disabled:cursor-wait disabled:opacity-60">
                                {isEndDatePending ? "Saving..." : "Save"}
                            </button>
                        </div>
                        {project.status === "Waiting to Start" && (
                            <div className="border-t border-hui-border pt-4">
                                <button
                                    type="button"
                                    disabled={isDrawerActionPending || isPending}
                                    onClick={handleRemoveFromSchedule}
                                    className="w-full rounded-md px-3 py-2 text-left text-xs font-semibold text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60"
                                >
                                    {isRemovePending ? "Removing..." : "Remove from schedule"}
                                </button>
                            </div>
                        )}
                    </form>
                </section>

                <section className="border-b border-hui-border px-5 py-5">
                    <h2 className="mb-3 text-sm font-semibold text-hui-textMain">Project crew</h2>
                    <CrewPicker
                        projectId={project.id}
                        crew={project.crew}
                        teamMembers={teamMembers}
                        variant="inline"
                        layout="list"
                    />
                </section>

                <section className="px-5 py-5">
                    <h2 className="mb-3 text-sm font-semibold text-hui-textMain">Color</h2>
                    <div className="grid grid-cols-8 gap-2">
                        {PRESET_COLORS.map(swatch => {
                            const isSelected = project.color?.toLowerCase() === swatch.toLowerCase();
                            return (
                                <button
                                    key={swatch}
                                    type="button"
                                    disabled={isDrawerActionPending}
                                    onClick={() => submitColor(swatch)}
                                    className={`h-7 w-7 rounded-full transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary focus-visible:ring-offset-2 disabled:opacity-60 ${isSelected ? "ring-2 ring-slate-700 ring-offset-2" : `ring-1 ${swatch.toLowerCase() === "#ffffff" ? "ring-slate-400" : "ring-slate-200"}`}`}
                                    style={{ backgroundColor: swatch }}
                                    title={swatch}
                                    aria-label={`Set project color to ${swatch}`}
                                    aria-pressed={isSelected}
                                />
                            );
                        })}
                    </div>
                    <div className="mt-4 border-t border-hui-border pt-4">
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Custom</p>
                        <ColorWheel
                            value={projectColor}
                            onCommit={submitColor}
                            disabled={isDrawerActionPending}
                        />
                    </div>
                </section>
            </div>
        </div>
    );
}

export function BoardProjectDrawer(props: BoardProjectDrawerProps) {
    return (
        <BoardDrawerShell open={Boolean(props.project)} ariaLabel="Project details" onClose={props.onClose}>
            {props.project && <ProjectDrawerContent {...props} project={props.project} />}
        </BoardDrawerShell>
    );
}
