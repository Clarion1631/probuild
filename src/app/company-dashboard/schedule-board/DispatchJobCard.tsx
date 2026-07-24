"use client";

import Link from "next/link";
import type { DashboardProjectRow, DashboardTaskRow } from "@/lib/schedule-core";
import { getFallbackProjectColor } from "@/app/projects/[id]/schedule/schedule-utils";

const STATUS_STYLES: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    Complete: "bg-green-100 text-green-700",
    Blocked: "bg-red-100 text-red-700",
};

function initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).map(part => part[0]).join("").toUpperCase().slice(0, 2) || "?";
}

interface DispatchJobCardProps {
    project: DashboardProjectRow;
    tasks: DashboardTaskRow[];
    highlighted: boolean;
    canCreate: boolean;
    onActivate: (taskId: string) => void;
    onAddTask: () => void;
}

export function DispatchJobCard({ project, tasks, highlighted, canCreate, onActivate, onAddTask }: DispatchJobCardProps) {
    const projectColor = project.color || getFallbackProjectColor(project.id);

    return (
        <article
            id={`dispatch-project-${project.id}`}
            className={`hui-card overflow-hidden border-l-4 transition-shadow ${highlighted ? "ring-2 ring-amber-400 ring-offset-2" : ""} ${tasks.length === 0 ? "bg-slate-50/70" : ""}`}
            style={{ borderLeftColor: projectColor }}
        >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hui-border px-4 py-3">
                <div className="min-w-0">
                    <Link href={`/projects/${project.id}`} className="truncate text-sm font-bold text-hui-textMain hover:text-hui-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                        {project.name}
                    </Link>
                    {project.location && <p className="mt-0.5 truncate text-xs text-hui-textMuted">{project.location}</p>}
                </div>
                {canCreate && (
                    <button type="button" onClick={onAddTask} className="hui-btn hui-btn-secondary shrink-0 text-xs">
                        + Task
                    </button>
                )}
            </div>

            {tasks.length === 0 ? (
                <div className="px-4 py-5">
                    <p className="text-sm font-medium text-slate-500">No task planned today</p>
                    <p className="mt-1 text-xs text-slate-400">This in-progress job has field crew but no active work item.</p>
                </div>
            ) : (
                <div className="divide-y divide-slate-100">
                    {tasks.map(task => {
                        const solidAssignments = task.assignments.filter(assignment => assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW");
                        const assignedIds = new Set(solidAssignments.map(assignment => assignment.userId));
                        const outlinedCrew = project.crew.filter(member => member.status === "ACTIVATED" && member.role === "FIELD_CREW" && !assignedIds.has(member.id));
                        const statusTitle = task.status === "Blocked" && task.blockedReason ? `Blocked \u2014 ${task.blockedReason}` : task.status;
                        const progress = Math.max(0, Math.min(100, task.progress));
                        return (
                            <section key={task.id} className="px-4 py-3">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-xs text-slate-500" aria-hidden="true">
                                                {task.type === "milestone" ? "\u25C6" : task.type === "appointment" ? `\u{1F550}${task.scheduledTime ? ` ${task.scheduledTime}` : ""}` : "\u25A0"}
                                            </span>
                                            <h3 className="truncate text-sm font-semibold text-hui-textMain">{task.name}</h3>
                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[task.status] ?? STATUS_STYLES["Not Started"]}`} title={statusTitle}>
                                                {task.status}
                                            </span>
                                        </div>
                                        <div className="mt-2 flex items-center gap-2">
                                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`${task.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                                                <div className="h-full rounded-full bg-hui-primary" style={{ width: `${progress}%` }} />
                                            </div>
                                            <span className="text-[10px] font-semibold text-slate-500">{progress}%</span>
                                        </div>
                                        {task.doneWhen && <p className="mt-2 text-xs text-hui-textMuted"><span className="font-semibold text-slate-600">Done when:</span> {task.doneWhen}</p>}
                                        <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={`${task.name} crew`}>
                                            {solidAssignments.map(assignment => (
                                                <span
                                                    key={assignment.id}
                                                    className="inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white shadow-sm"
                                                    style={{ backgroundColor: projectColor }}
                                                    title={`${assignment.name}${assignment.assignmentRole === "lead" ? " \u2014 lead" : " \u2014 task assigned"}`}
                                                >
                                                    {assignment.assignmentRole === "lead" && <span aria-hidden="true">{"\u2605"}</span>}{initials(assignment.name)}
                                                </span>
                                            ))}
                                            {outlinedCrew.map(member => (
                                                <span
                                                    key={member.id}
                                                    className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border-2 bg-white px-1.5 text-[10px] font-bold"
                                                    style={{ borderColor: projectColor, color: projectColor }}
                                                    title={`${member.name} \u2014 project crew only`}
                                                >
                                                    {initials(member.name)}
                                                </span>
                                            ))}
                                            {solidAssignments.length === 0 && outlinedCrew.length === 0 && <span className="text-[10px] text-slate-400">No crew</span>}
                                        </div>
                                    </div>
                                    <button type="button" onClick={() => onActivate(task.id)} className="hui-btn hui-btn-secondary shrink-0 text-xs">
                                        {"\u{1F4CB} Details"}
                                    </button>
                                </div>
                            </section>
                        );
                    })}
                </div>
            )}
        </article>
    );
}
