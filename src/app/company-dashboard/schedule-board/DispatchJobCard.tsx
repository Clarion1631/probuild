"use client";

import Link from "next/link";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DashboardProjectRow, DashboardTaskRow } from "@/lib/schedule-core";
import { getFallbackProjectColor } from "@/app/projects/[id]/schedule/schedule-utils";
import { classifyTaskEvidence, findContradiction, type EvidenceState } from "@/lib/task-evidence";

const STATUS_STYLES: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    Complete: "bg-green-100 text-green-700",
    Blocked: "bg-red-100 text-red-700",
};

function initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).map(part => part[0]).join("").toUpperCase().slice(0, 2) || "?";
}

// Evidence badge sits beside the materials badge — per-task indicators belong on
// the dispatch card, never on the calendar chips (board no-clutter contract, and
// it keeps drag geometry untouched).
function describeTaskEvidence(
    task: DashboardTaskRow,
    parentIds: ReadonlySet<string>,
    dayKey: string,
): { state: EvidenceState; label: string; tone: string; title: string } | null {
    const input = {
        id: task.id,
        startDate: task.startDate,
        endDate: task.endDate,
        status: task.status,
        type: task.type,
        parentId: task.parentId,
        lastDirectEvidenceAt: task.lastDirectEvidenceAt,
        lastIndirectEvidenceAt: task.lastIndirectEvidenceAt,
    };
    const state = classifyTaskEvidence(input, parentIds, dayKey);
    const seenOn = task.lastDirectEvidenceAt?.slice(0, 10);
    switch (state) {
        case "confirmed":
            return { state, label: "✓ confirmed", tone: "bg-green-100 text-green-700", title: `Field activity on ${seenOn}` };
        case "stale":
            return { state, label: "going stale", tone: "bg-amber-100 text-amber-800", title: `Last field activity ${seenOn}` };
        case "unknown":
            return { state, label: "no field update", tone: "bg-slate-100 text-slate-600", title: "No hours or punch-item activity has landed on this task" };
        case "needsReview":
            return { state, label: "needs review", tone: "bg-red-100 text-red-700", title: findContradiction(input) ?? "Evidence disagrees with the board" };
        default:
            return null;
    }
}

interface DispatchJobCardProps {
    project: DashboardProjectRow;
    tasks: DashboardTaskRow[];
    /** Local day the dispatch view is showing; drives evidence freshness. */
    dayKey: string;
    highlighted: boolean;
    canCreate: boolean;
    crewDrafts: Readonly<Record<string, { addUserIds: string[]; removeUserIds: string[] }>>;
    onActivate: (taskId: string) => void;
    onAddTask: () => void;
    onCrewPointerDown: (event: ReactPointerEvent<HTMLElement>, member: { id: string; name: string }) => void;
    onCrewKeyboardActivate: (event: ReactKeyboardEvent<HTMLElement>, member: { id: string; name: string }) => void;
    onDraftCrewRemove: (taskId: string, userId: string) => void;
}

export function DispatchJobCard({
    project,
    tasks,
    dayKey,
    highlighted,
    canCreate,
    crewDrafts,
    onActivate,
    onAddTask,
    onCrewPointerDown,
    onCrewKeyboardActivate,
    onDraftCrewRemove,
}: DispatchJobCardProps) {
    const projectColor = project.color || getFallbackProjectColor(project.id);
    // Parents come from the FULL project task list, not today's filtered subset —
    // a phase parent whose children are elsewhere in the week must still be excluded.
    const taskParentIds = new Set(project.tasks.map(task => task.parentId).filter((id): id is string => !!id));

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
                        const materialCount = task.pendingMaterials + task.stagedMaterials + task.missingMaterials;
                        const materialBadgeStyle = task.missingMaterials > 0
                            ? "bg-red-100 text-red-700"
                            : task.pendingMaterials > 0
                                ? "bg-amber-100 text-amber-800"
                                : "bg-green-100 text-green-700";
                        const evidenceBadge = describeTaskEvidence(task, taskParentIds, dayKey);
                        return (
                            <section key={task.id} data-dispatch-task-id={task.id} className="px-4 py-3">
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
                                            {materialCount > 0 && (
                                                <span
                                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${materialBadgeStyle}`}
                                                    title={`${task.stagedMaterials} staged, ${task.pendingMaterials} pending, ${task.missingMaterials} missing`}
                                                >
                                                    {"\u{1F4E6}"} {materialCount} {"\u00B7"} {task.missingMaterials} missing
                                                </span>
                                            )}
                                            {evidenceBadge && (
                                                <span
                                                    data-evidence-state={evidenceBadge.state}
                                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${evidenceBadge.tone}`}
                                                    title={evidenceBadge.title}
                                                >
                                                    {evidenceBadge.label}
                                                </span>
                                            )}
                                        </div>
                                        <div className="mt-2 flex items-center gap-2">
                                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`${task.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                                                <div className="h-full rounded-full bg-hui-primary" style={{ width: `${progress}%` }} />
                                            </div>
                                            <span className="text-[10px] font-semibold text-slate-500">{progress}%</span>
                                        </div>
                                        {task.doneWhen && <p className="mt-2 text-xs text-hui-textMuted"><span className="font-semibold text-slate-600">Done when:</span> {task.doneWhen}</p>}
                                        <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={`${task.name} crew`}>
                                            {solidAssignments.map(assignment => {
                                                const draftedAddition = crewDrafts[task.id]?.addUserIds.includes(assignment.userId) ?? false;
                                                return (
                                                    <span key={assignment.id} className="group relative inline-flex">
                                                        <button
                                                            type="button"
                                                            data-dispatch-crew-chip="true"
                                                            data-dispatch-user-id={assignment.userId}
                                                            onPointerDown={event => onCrewPointerDown(event, { id: assignment.userId, name: assignment.name })}
                                                            onKeyDown={event => onCrewKeyboardActivate(event, { id: assignment.userId, name: assignment.name })}
                                                            className={`inline-flex h-7 min-w-7 touch-none items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary focus-visible:ring-offset-2 ${draftedAddition ? "border-2 border-dashed border-white ring-2 ring-indigo-400 ring-offset-1" : ""}`}
                                                            style={{ backgroundColor: projectColor }}
                                                            title={`${assignment.name}${assignment.assignmentRole === "lead" ? " \u2014 lead" : draftedAddition ? " \u2014 drafted assignment" : " \u2014 task assigned"}`}
                                                            aria-label={`${assignment.name}. Press Enter to choose another task, or drag onto a task.`}
                                                        >
                                                            {assignment.assignmentRole === "lead" && <span aria-hidden="true">{"\u2605"}</span>}{initials(assignment.name)}
                                                        </button>
                                                        {canCreate && (
                                                            <button
                                                                type="button"
                                                                onPointerDown={event => event.stopPropagation()}
                                                                onClick={() => onDraftCrewRemove(task.id, assignment.userId)}
                                                                className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-[10px] font-bold leading-none text-white opacity-0 shadow transition hover:bg-red-600 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                                                                aria-label={`Remove ${assignment.name} from ${task.name}`}
                                                            >
                                                                {"\u00D7"}
                                                            </button>
                                                        )}
                                                    </span>
                                                );
                                            })}
                                            {outlinedCrew.map(member => (
                                                <button
                                                    key={member.id}
                                                    type="button"
                                                    data-dispatch-crew-chip="true"
                                                    data-dispatch-user-id={member.id}
                                                    onPointerDown={event => onCrewPointerDown(event, member)}
                                                    onKeyDown={event => onCrewKeyboardActivate(event, member)}
                                                    className="inline-flex h-7 min-w-7 touch-none items-center justify-center rounded-full border-2 bg-white px-1.5 text-[10px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary focus-visible:ring-offset-2"
                                                    style={{ borderColor: projectColor, color: projectColor }}
                                                    title={`${member.name} \u2014 project crew only`}
                                                    aria-label={`${member.name}. Press Enter to choose a task, or drag onto a task.`}
                                                >
                                                    {initials(member.name)}
                                                </button>
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
