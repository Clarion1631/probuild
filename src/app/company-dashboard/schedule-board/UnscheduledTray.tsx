"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import type { CompanyDashboardData, DashboardProjectRow } from "@/lib/schedule-core";

export const PROJECT_DRAG_MIME = "application/x-gtr-project-id";

interface UnscheduledTrayProps {
    estimating: CompanyDashboardData["pipeline"]["estimating"];
    projects: DashboardProjectRow[];
    canEdit: boolean;
    pendingProjectIds: ReadonlySet<string>;
    onMoveProject: (_project: DashboardProjectRow, _targetStart: string) => void;
}

function ProjectActions({
    project,
    disabled,
    onMoveProject,
}: {
    project: DashboardProjectRow;
    disabled: boolean;
    onMoveProject: (_project: DashboardProjectRow, _targetStart: string) => void;
}) {
    const [targetStart, setTargetStart] = useState("");

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!targetStart || disabled) return;
        onMoveProject(project, targetStart);
    }

    return (
        <details className="relative shrink-0 opacity-0 pointer-events-none transition group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
            <summary className="cursor-pointer list-none rounded px-2 py-1 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                Project actions
            </summary>
            <form onSubmit={handleSubmit} className="absolute right-0 top-full z-50 mt-1 w-56 space-y-2 rounded-md border border-hui-border bg-white p-3 text-left shadow-lg">
                <label className="block text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`tray-project-date-${project.id}`}>Start date</label>
                <input
                    id={`tray-project-date-${project.id}`}
                    type="date"
                    value={targetStart}
                    onChange={event => setTargetStart(event.target.value)}
                    disabled={disabled}
                    className="hui-input w-full px-2 py-1 text-xs"
                />
                <button type="submit" disabled={disabled || !targetStart} className="hui-btn hui-btn-primary w-full text-xs disabled:cursor-wait disabled:opacity-60">
                    Move project
                </button>
            </form>
        </details>
    );
}

export function UnscheduledTray({ estimating, projects, canEdit, pendingProjectIds, onMoveProject }: UnscheduledTrayProps) {
    function handleDragStart(project: DashboardProjectRow, event: DragEvent<HTMLElement>) {
        if (!canEdit || pendingProjectIds.has(project.id)) {
            event.preventDefault();
            return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(PROJECT_DRAG_MIME, project.id);
    }

    if (projects.length === 0 && estimating.length === 0) return null;

    return (
        <section className="border-b border-hui-border bg-slate-50/70 px-4 py-3" aria-labelledby="unscheduled-projects-heading">
            <div className="mb-2 flex items-center justify-between gap-3">
                <h3 id="unscheduled-projects-heading" className="text-xs font-semibold uppercase tracking-wide text-hui-textMuted">Unscheduled</h3>
                <p className="text-[10px] text-hui-textMuted">
                    {canEdit ? "Drag a Waiting-to-Start project onto a day or use Project actions." : "Unscheduled projects are read-only for your role."}
                </p>
            </div>
            <div className="flex flex-wrap gap-2">
                {projects.map(project => {
                    const pending = pendingProjectIds.has(project.id);
                    return (
                        <article
                            key={project.id}
                            draggable={canEdit && !pending ? true : undefined}
                            onDragStart={event => handleDragStart(project, event)}
                            aria-busy={pending}
                            className={`group flex min-w-52 items-center gap-2 rounded-md border border-indigo-200 bg-white px-3 py-2 shadow-sm ${canEdit && !pending ? "cursor-grab active:cursor-grabbing" : "opacity-60"}`}
                        >
                            <div className="min-w-0 flex-1">
                                <Link href={`/projects/${project.id}`} className="block truncate text-xs font-semibold text-hui-textMain hover:text-hui-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                                    {project.name}
                                </Link>
                                <span className="block truncate text-[10px] text-hui-textMuted">{project.client ?? "No client"} · Waiting to Start</span>
                            </div>
                            {canEdit && <ProjectActions project={project} disabled={pending} onMoveProject={onMoveProject} />}
                        </article>
                    );
                })}
                {estimating.map(lead => (
                    <div key={lead.id} aria-disabled="true" className="min-w-44 rounded-md border border-dashed border-slate-300 bg-slate-100 px-3 py-2 opacity-60">
                        <span className="block truncate text-xs font-semibold text-slate-600">{lead.name}</span>
                        <span className="block truncate text-[10px] text-slate-500">{lead.client ?? "Lead"} · Estimating</span>
                    </div>
                ))}
            </div>
        </section>
    );
}
