"use client";

import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import Link from "next/link";
import type {
    DashboardProjectRow,
    OverlayChangeOrderItem,
    OverlayIncomeItem,
} from "@/lib/schedule-core";
import { addDays, formatDate, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { assignTaskLanes, getEffectiveProjectRange, type WeekSegment } from "./useBarLayout";
import { MilestoneMarker } from "./MilestoneMarker";
import { TaskBlockSegment, type ActiveTaskKeyboardEdit, type TaskEditCallbacks } from "./TaskBlockSegment";
import { FloatingPopover } from "./FloatingPopover";

// Mini-lane sizing for overlapping tasks inside one project bar (item 5): the
// common single-lane case keeps the original 18px strip untouched; 2-3 lanes
// pack into slightly shorter rows. Callers (MonthBarsView's fixed-height grid
// rows) size their row budget for the MAX_TASK_LANES=3 case.
const TASK_STRIP_SINGLE_LANE_HEIGHT = 18;
const TASK_LANE_HEIGHT = 14;

// One source of truth for a bar's mini-lane geometry: used by the bar itself
// AND by row-height calculations in the views (Timeline rows must grow with
// lane count or a 3-lane bar overflows into the row below).
export function computeTaskLaneLayout(tasks: { id: string; startDate: string; endDate: string; type: string }[]) {
    const taskLaneInput = tasks.map(task => {
        const start = parseUTCDate(task.startDate.slice(0, 10));
        const end = task.type === "milestone" ? addDays(start, 1) : parseUTCDate(task.endDate.slice(0, 10));
        return { id: task.id, start, end };
    });
    const { laneByTaskId, hiddenTaskIds, laneCount: rawLaneCount } = assignTaskLanes(taskLaneInput);
    const laneCount = Math.max(1, rawLaneCount);
    const laneHeight = laneCount <= 1 ? TASK_STRIP_SINGLE_LANE_HEIGHT : TASK_LANE_HEIGHT;
    const taskStripHeight = laneCount * laneHeight;
    return { laneByTaskId, hiddenTaskIds, laneCount, laneHeight, taskStripHeight, barHeight: 18 + taskStripHeight };
}

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
    // Drafted (unsaved project-start move) — dashed ring + desaturated, but
    // still fully draggable (draft mode never locks a drafted item).
    isDraft?: boolean;
    pendingTaskIds: ReadonlySet<string>;
    draftTaskIds: ReadonlySet<string>;
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
    isDraft = false,
    pendingTaskIds,
    draftTaskIds,
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
    const actionTriggerRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const overflowTriggerRef = useRef<HTMLButtonElement>(null);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const actionResetKey = `${isPending ? "pending" : "ready"}:${projectStart}`;
    const [targetStartDraft, setTargetStartDraft] = useState(() => ({ resetKey: actionResetKey, value: projectStart }));
    const targetStart = targetStartDraft.resetKey === actionResetKey ? targetStartDraft.value : projectStart;
    if (targetStartDraft.resetKey !== actionResetKey) {
        setTargetStartDraft({ resetKey: actionResetKey, value: projectStart });
    }
    useEffect(() => {
        setMenuOpen(false);
    }, [actionResetKey]);
    if (!gridStart || !projectRange) return null;

    const visibleStart = addDays(gridStart, segment.weekIndex * 7 + segment.startColumn);
    const visibleRange = { start: visibleStart, end: addDays(visibleStart, segment.spanDays) };
    const crewLabel = project.crew.length > 0 ? project.crew.map(member => member.name).join(", ") : "No project crew";
    const projectTitle = `${project.name}${project.client ? ` — ${project.client}` : ""} — ${crewLabel}`;

    // Mini-lane layout for tasks that overlap inside this bar (e.g. concrete
    // + deck running concurrently) — capped at 3 lanes with a "+N" chip.
    const { laneByTaskId, hiddenTaskIds, laneCount, laneHeight, taskStripHeight, barHeight } = computeTaskLaneLayout(project.tasks);
    const hiddenTasks = hiddenTaskIds
        .map(id => project.tasks.find(task => task.id === id))
        .filter((task): task is DashboardProjectRow["tasks"][number] => Boolean(task));
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

    // A bare click on the bar (not a drag, and not on an interactive
    // descendant like the name link or the Actions menu itself) toggles the
    // Actions dropdown instead of doing nothing — the bar itself never
    // navigates. An active drag calls preventDefault on pointermove once the
    // threshold is crossed, which suppresses the browser's synthetic click,
    // so this only fires for genuine clicks.
    function handleBarClick(event: ReactMouseEvent<HTMLDivElement>) {
        if (!canMoveProject || isPending) return;
        if ((event.target as HTMLElement).closest("a,button,input,summary,form,details")) return;
        setMenuOpen(value => !value);
    }

    return (
        <div
            className={`group/project relative touch-pan-y select-none overflow-visible rounded-md border text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 ${canMoveProject && !isPending ? "cursor-move" : ""} ${isDraft ? "border-dashed border-2 border-white/90 saturate-[.55] brightness-95" : "border-black/10"}`}
            style={{ backgroundColor: projectColor, height: barHeight }}
            data-can-edit={canEdit ? "true" : "false"}
            role="group"
            aria-label={`${project.name} project bar${isDraft ? " (unsaved change)" : ""}`}
            aria-disabled={!canMoveProject || isPending}
            aria-busy={isPending}
            tabIndex={canMoveProject && !isPending ? 0 : undefined}
            onPointerDown={handlePointerDown}
            onClick={handleBarClick}
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
                    <>
                        <button
                            ref={actionTriggerRef}
                            type="button"
                            onClick={event => { event.stopPropagation(); setMenuOpen(value => !value); }}
                            aria-expanded={menuOpen}
                            className="shrink-0 cursor-pointer rounded bg-white/20 px-1 py-0.5 text-[9px] font-bold text-white opacity-0 transition hover:bg-white/30 group-hover/project:opacity-100 group-focus-within/project:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            aria-label={`Project actions for ${project.name}`}
                        >
                            Actions
                        </button>
                        <FloatingPopover open={menuOpen} anchorRef={actionTriggerRef} onClose={() => setMenuOpen(false)}>
                            <form onSubmit={handleDateSubmit} className="space-y-2">
                                <Link
                                    href={`/projects/${project.id}`}
                                    className="block w-full rounded px-2 py-1.5 text-xs font-semibold text-hui-primary hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                >
                                    Open project
                                </Link>
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
                        </FloatingPopover>
                    </>
                )}
                {segment.continuesAfter && <span aria-hidden="true">›</span>}
            </div>
            {hiddenTasks.length > 0 && (
                <>
                    <button
                        ref={overflowTriggerRef}
                        type="button"
                        onClick={event => { event.stopPropagation(); setOverflowOpen(value => !value); }}
                        aria-expanded={overflowOpen}
                        className="absolute bottom-0 right-0 z-20 rounded-tl bg-black/40 px-1 text-[8px] font-bold text-white hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        aria-label={`${hiddenTasks.length} more overlapping task${hiddenTasks.length === 1 ? "" : "s"} on ${project.name}`}
                    >
                        +{hiddenTasks.length}
                    </button>
                    <FloatingPopover open={overflowOpen} anchorRef={overflowTriggerRef} onClose={() => setOverflowOpen(false)} width={200}>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">Also running</p>
                        <ul className="space-y-1">
                            {hiddenTasks.map(task => (
                                <li key={task.id} className="truncate text-xs text-hui-textMain" title={task.name}>{task.name}</li>
                            ))}
                        </ul>
                    </FloatingPopover>
                </>
            )}
            <div className="absolute inset-x-0 bottom-0 overflow-visible rounded-b-md" style={{ height: taskStripHeight }}>
                {project.tasks.filter(task => laneByTaskId.has(task.id)).map(task => (
                    <TaskBlockSegment
                        key={task.id}
                        task={task}
                        projectRange={projectRange}
                        visibleRange={visibleRange}
                        projectColor={projectColor}
                        canEdit={canEdit}
                        laneTop={laneByTaskId.get(task.id)! * laneHeight}
                        laneHeight={laneHeight}
                        isPending={isPending || pendingTaskIds.has(task.id)}
                        isDraft={isDraft || draftTaskIds.has(task.id)}
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
