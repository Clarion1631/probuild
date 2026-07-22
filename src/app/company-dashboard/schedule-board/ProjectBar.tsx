"use client";

import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import Link from "next/link";
import type {
    DashboardProjectRow,
    OverlayChangeOrderItem,
    OverlayIncomeItem,
} from "@/lib/schedule-core";
import { addDays, formatDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { getEffectiveProjectRange, type WeekSegment } from "./useBarLayout";
import { MilestoneMarker } from "./MilestoneMarker";
import { TaskBlockSegment, type ActiveTaskKeyboardEdit, type TaskEditCallbacks } from "./TaskBlockSegment";

export interface ProjectEditCallbacks {
    activeProjectKeyboardId: string | null;
    onProjectPointerEditStart: (_project: DashboardProjectRow, _start: ProjectPointerEditStart) => void;
    onProjectKeyboardStart: (_project: DashboardProjectRow, _sourceElement: HTMLElement) => void;
    onProjectKeyboardAdjust: (_project: DashboardProjectRow, _deltaDays: number) => void;
    onProjectKeyboardCommit: (_project: DashboardProjectRow) => void;
    onProjectKeyboardCancel: (_project: DashboardProjectRow) => void;
    onProjectMoveCommit: (_project: DashboardProjectRow, _targetStart: string) => void;
}

export interface ProjectBarProps extends TaskEditCallbacks {
    project: DashboardProjectRow;
    segment: WeekSegment;
    projectColor: string;
    conflictNames: string[];
    incomeMilestones: OverlayIncomeItem[];
    changeOrderMilestones: OverlayChangeOrderItem[];
    canEdit: boolean;
    canMoveProject: boolean;
    isPending: boolean;
    pendingTaskIds: ReadonlySet<string>;
    activeTaskKeyboardEdit: ActiveTaskKeyboardEdit | null;
    timelineDayWidth?: number;
    timelineLeftInset?: number;
    timelineScrollContainerRef?: RefObject<HTMLDivElement | null>;
    activeProjectKeyboardId: ProjectEditCallbacks["activeProjectKeyboardId"];
    onProjectPointerEditStart: ProjectEditCallbacks["onProjectPointerEditStart"];
    onProjectKeyboardStart: ProjectEditCallbacks["onProjectKeyboardStart"];
    onProjectKeyboardAdjust: ProjectEditCallbacks["onProjectKeyboardAdjust"];
    onProjectKeyboardCommit: ProjectEditCallbacks["onProjectKeyboardCommit"];
    onProjectKeyboardCancel: ProjectEditCallbacks["onProjectKeyboardCancel"];
    onMoveCommit: ProjectEditCallbacks["onProjectMoveCommit"];
}

export const ProjectBarGridStartContext = createContext<Date | null>(null);
export interface ProjectPointerEditStart {
    pointerId: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    sourceElement: HTMLElement;
    originalStart: string;
    fallbackGrabDate: string;
    timelineDayWidth?: number;
    timelineLeftInset?: number;
    timelineScrollContainerRef?: RefObject<HTMLDivElement | null>;
}

function initials(name: string): string {
    return name.trim().split(/\s+/).map(part => part[0]).join("").toUpperCase().slice(0, 2) || "?";
}

export function ProjectBar({
    project,
    segment,
    projectColor,
    conflictNames,
    incomeMilestones,
    changeOrderMilestones,
    canEdit,
    canMoveProject,
    isPending,
    pendingTaskIds,
    activeTaskKeyboardEdit,
    timelineDayWidth,
    timelineLeftInset,
    timelineScrollContainerRef,
    activeProjectKeyboardId,
    onProjectPointerEditStart,
    onProjectKeyboardStart,
    onProjectKeyboardAdjust,
    onProjectKeyboardCommit,
    onProjectKeyboardCancel,
    onMoveCommit,
    onTaskPointerEditStart,
    onTaskKeyboardStart,
    onTaskKeyboardAdjust,
    onTaskKeyboardCommit,
    onTaskKeyboardCancel,
    onTaskDatesCommit,
    onTaskMoveBy,
}: ProjectBarProps) {
    const gridStart = useContext(ProjectBarGridStartContext);
    const projectRange = getEffectiveProjectRange(project);
    const projectStart = projectRange ? formatDate(projectRange.start) : "";
    const actionDetailsRef = useRef<HTMLDetailsElement>(null);
    const actionResetKey = `${isPending ? "pending" : "ready"}:${projectStart}`;
    const [targetStartDraft, setTargetStartDraft] = useState(() => ({ resetKey: actionResetKey, value: projectStart }));
    const targetStart = targetStartDraft.resetKey === actionResetKey ? targetStartDraft.value : projectStart;
    if (targetStartDraft.resetKey !== actionResetKey) {
        setTargetStartDraft({ resetKey: actionResetKey, value: projectStart });
    }
    useEffect(() => {
        if (actionDetailsRef.current) actionDetailsRef.current.open = false;
    }, [actionResetKey]);
    if (!gridStart || !projectRange) return null;

    const visibleStart = addDays(gridStart, segment.weekIndex * 7 + segment.startColumn);
    const visibleRange = { start: visibleStart, end: addDays(visibleStart, segment.spanDays) };
    const crewLabel = project.crew.length > 0 ? project.crew.map(member => member.name).join(", ") : "No project crew";
    const projectTitle = `${project.name}${project.client ? ` — ${project.client}` : ""} — ${crewLabel}`;
    const milestoneMarkers = [
        ...incomeMilestones.map(item => ({
            key: `income-${item.id}`,
            name: item.name,
            amount: item.amount,
            effectiveDueDate: item.effectiveDueDate,
            kind: "income" as const,
        })),
        ...changeOrderMilestones.map(item => ({
            key: `co-${item.paymentScheduleId}`,
            name: item.name,
            amount: item.amount,
            effectiveDueDate: item.effectiveDueDate,
            kind: "change-order" as const,
        })),
    ];

    function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        if (!canMoveProject || isPending || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        if ((event.target as HTMLElement).closest("a,button,input,summary,form,details")) return;
        onProjectPointerEditStart(project, {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            clientX: event.clientX,
            clientY: event.clientY,
            sourceElement: event.currentTarget,
            originalStart: formatDate(projectRange!.start),
            fallbackGrabDate: formatDate(visibleStart),
            timelineDayWidth,
            timelineLeftInset,
            timelineScrollContainerRef,
        });
    }

    function handleKeyboard(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget || !canMoveProject || isPending) return;
        const editing = activeProjectKeyboardId === project.id;
        if (!editing && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            onProjectKeyboardStart(project, event.currentTarget);
            return;
        }
        if (!editing) return;
        const step = event.shiftKey ? 7 : 1;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            onProjectKeyboardAdjust(project, -step);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            onProjectKeyboardAdjust(project, step);
        } else if (event.key === "Enter") {
            event.preventDefault();
            onProjectKeyboardCommit(project);
        } else if (event.key === "Escape") {
            event.preventDefault();
            onProjectKeyboardCancel(project);
        }
    }

    function handleDateSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!targetStart || isPending) return;
        onMoveCommit(project, targetStart);
    }

    return (
        <div
            className={`group/project relative h-9 touch-pan-y select-none overflow-visible rounded-md border border-black/10 text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 ${canMoveProject && !isPending ? "cursor-move" : ""}`}
            style={{ backgroundColor: projectColor }}
            data-can-edit={canEdit ? "true" : "false"}
            role="group"
            aria-label={`${project.name} project bar`}
            aria-disabled={!canMoveProject || isPending}
            aria-busy={isPending}
            tabIndex={canMoveProject && !isPending ? 0 : undefined}
            onPointerDown={handlePointerDown}
            onKeyDown={handleKeyboard}
        >
            <div className="absolute inset-x-0 top-0 z-10 flex h-[18px] min-w-0 items-center gap-1 px-1 text-[10px] leading-none">
                {segment.continuesBefore && <span aria-hidden="true">‹</span>}
                <Link href={`/projects/${project.id}`} title={projectTitle} className="min-w-0 flex-1 truncate font-semibold text-white outline-none hover:underline focus-visible:ring-2 focus-visible:ring-white">
                    {project.name}
                </Link>
                {project.crew.length > 0 && (
                    <span className="shrink-0 text-[9px] font-medium text-white/90" title={`Crew: ${crewLabel}`}>
                        {project.crew.slice(0, 3).map(member => initials(member.name)).join(" ")}{project.crew.length > 3 ? ` +${project.crew.length - 3}` : ""}
                    </span>
                )}
                {conflictNames.length > 0 && (
                    <span className="inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-red-600 px-1 py-0.5 text-[9px] font-bold text-white" title={`Crew conflicts: ${conflictNames.join(", ")}`} aria-label={`${conflictNames.length} crew conflict${conflictNames.length === 1 ? "" : "s"}`}>
                        !{conflictNames.length}
                    </span>
                )}
                {canMoveProject && (
                    <details ref={actionDetailsRef} className="relative shrink-0 opacity-0 pointer-events-none transition group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                        <summary className="cursor-pointer list-none rounded bg-white/20 px-1 py-0.5 text-[9px] font-bold text-white hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label={`Project actions for ${project.name}`}>
                            Actions
                        </summary>
                        <form onSubmit={handleDateSubmit} className="absolute right-0 top-full z-[80] mt-1 w-56 space-y-2 rounded-md border border-hui-border bg-white p-3 text-left text-hui-textMain shadow-xl">
                            <label className="block text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`bar-project-date-${project.id}-${segment.weekIndex}`}>Start date</label>
                            <input
                                id={`bar-project-date-${project.id}-${segment.weekIndex}`}
                                type="date"
                                value={targetStart}
                                onChange={event => setTargetStartDraft({ resetKey: actionResetKey, value: event.target.value })}
                                disabled={isPending}
                                className="hui-input w-full px-2 py-1 text-xs"
                            />
                            <button type="submit" disabled={isPending || !targetStart} className="hui-btn hui-btn-primary w-full text-xs disabled:cursor-wait disabled:opacity-60">
                                Move project
                            </button>
                        </form>
                    </details>
                )}
                {segment.continuesAfter && <span aria-hidden="true">›</span>}
            </div>
            <div className="absolute inset-x-0 bottom-0 h-[18px] overflow-visible rounded-b-md">
                {project.tasks.map(task => (
                    <TaskBlockSegment
                        key={task.id}
                        task={task}
                        projectRange={projectRange}
                        visibleRange={visibleRange}
                        projectColor={projectColor}
                        canEdit={canEdit}
                        isPending={isPending || pendingTaskIds.has(task.id)}
                        activeTaskKeyboardEdit={activeTaskKeyboardEdit}
                        timelineDayWidth={timelineDayWidth}
                        timelineLeftInset={timelineLeftInset}
                        timelineScrollContainerRef={timelineScrollContainerRef}
                        onTaskPointerEditStart={onTaskPointerEditStart}
                        onTaskKeyboardStart={onTaskKeyboardStart}
                        onTaskKeyboardAdjust={onTaskKeyboardAdjust}
                        onTaskKeyboardCommit={onTaskKeyboardCommit}
                        onTaskKeyboardCancel={onTaskKeyboardCancel}
                        onTaskDatesCommit={onTaskDatesCommit}
                        onTaskMoveBy={onTaskMoveBy}
                    />
                ))}
            </div>
            {milestoneMarkers.map(marker => {
                const sameDayMarkers = milestoneMarkers.filter(item => item.effectiveDueDate.slice(0, 10) === marker.effectiveDueDate.slice(0, 10));
                const sameDayIndex = sameDayMarkers.findIndex(item => item.key === marker.key);
                return (
                    <MilestoneMarker
                        key={marker.key}
                        name={marker.name}
                        amount={marker.amount}
                        effectiveDueDate={marker.effectiveDueDate}
                        visibleRange={visibleRange}
                        kind={marker.kind}
                        offsetPixels={(sameDayIndex - (sameDayMarkers.length - 1) / 2) * 8}
                    />
                );
            })}
        </div>
    );
}
