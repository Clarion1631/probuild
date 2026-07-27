"use client";

import { createContext, useContext, useRef, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type {
    DashboardProjectRow,
    OverlayChangeOrderItem,
    OverlayIncomeItem,
} from "@/lib/schedule-core";
import { addDays, formatDate, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { assignTaskLanes, getEffectiveProjectRange, type WeekSegment } from "./useBarLayout";
import { MilestoneMarker } from "./MilestoneMarker";
import { TaskBlockSegment, type ActiveTaskKeyboardEdit, type TaskEditCallbacks } from "./TaskBlockSegment";
import { ProjectTaskOverflow } from "./ProjectTaskOverflow";

// Mini-lane sizing for overlapping tasks inside one project bar (item 5, and
// the 2026-07-22 readability pass — 9px task labels were unreadable):
// single-lane strip 18->22px, 2-3 lanes pack into slightly shorter 14->18px
// rows. Callers (MonthBarsView's fixed-height grid rows) size their row
// budget for the MAX_TASK_LANES=3 case.
const TASK_STRIP_SINGLE_LANE_HEIGHT = 22;
const TASK_LANE_HEIGHT = 18;

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
    onProjectActivate: (_projectId: string) => void;
    onProjectPointerEditStart: (_project: DashboardProjectRow, _start: ProjectPointerEditStart) => void;
    onProjectKeyboardStart: (_project: DashboardProjectRow, _sourceElement: HTMLElement) => void;
    onProjectKeyboardAdjust: (_project: DashboardProjectRow, _deltaDays: number) => void;
    onProjectKeyboardCommit: (_project: DashboardProjectRow) => void;
    onProjectKeyboardCancel: (_project: DashboardProjectRow) => void;
    onProjectMoveCommit: (_project: DashboardProjectRow, _targetStart: string) => void;
    // Right-edge drag-to-resize the project's end date (item 2) — a SEPARATE
    // pointer-drag from the whole-bar move above; it never joins the draft
    // system, it commits immediately via updateProjectEndDateAction.
    onProjectEndResizeStart: (_project: DashboardProjectRow, _start: ProjectEndResizePointerStart) => void;
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
    // Threaded to TaskBlockSegment's retained task-crew quick menu.
    teamMembers: { id: string; name: string; email: string }[];
    // Suppresses every task's hover card while ANY schedule-board drag is
    // active (item 3) — threaded through to this bar's own task renders.
    isAnyDragActive: boolean;
    activeProjectKeyboardId: ProjectEditCallbacks["activeProjectKeyboardId"];
    onProjectActivate: ProjectEditCallbacks["onProjectActivate"];
    onProjectPointerEditStart: ProjectEditCallbacks["onProjectPointerEditStart"];
    onProjectKeyboardStart: ProjectEditCallbacks["onProjectKeyboardStart"];
    onProjectKeyboardAdjust: ProjectEditCallbacks["onProjectKeyboardAdjust"];
    onProjectKeyboardCommit: ProjectEditCallbacks["onProjectKeyboardCommit"];
    onProjectKeyboardCancel: ProjectEditCallbacks["onProjectKeyboardCancel"];
    onProjectEndResizeStart: ProjectEditCallbacks["onProjectEndResizeStart"];
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

// Right-edge resize drag (item 2) — deliberately separate from
// ProjectPointerEditStart: no fallbackGrabDate (px→day math only, never
// cell hit-testing), and it carries the project's CURRENT end so the drag
// can compute a delta without re-deriving it from segment geometry.
export interface ProjectEndResizePointerStart {
    pointerId: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    sourceElement: HTMLElement;
    originalStart: string;
    originalEnd: string;
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
    teamMembers,
    isAnyDragActive,
    activeProjectKeyboardId,
    onProjectActivate,
    onProjectPointerEditStart,
    onProjectKeyboardStart,
    onProjectKeyboardAdjust,
    onProjectKeyboardCommit,
    onProjectKeyboardCancel,
    onProjectEndResizeStart,
    onTaskPointerEditStart,
    onTaskKeyboardStart,
    onTaskKeyboardAdjust,
    onTaskKeyboardCommit,
    onTaskKeyboardCancel,
    onTaskDatesCommit,
    onTaskMoveBy,
    onActivate,
}: ProjectBarProps) {
    const gridStart = useContext(ProjectBarGridStartContext);
    const projectRange = getEffectiveProjectRange(project);
    const rootRef = useRef<HTMLDivElement>(null);
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

    // Right-edge grab handle (item 2): a SEPARATE pointer-drag from the
    // whole-bar move above — stopPropagation so it wins over handlePointerDown
    // within its own hit area instead of also starting a move-drag. Available
    // whenever the bar is editable, independent of
    // canMoveProject — a Substantial Completion project can't have its START
    // dragged, but its finish date is still editable, same as "Edit dates…".
    function handleEndResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        if (!canEdit || isPending || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        event.stopPropagation();
        onProjectEndResizeStart(project, {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            clientX: event.clientX,
            clientY: event.clientY,
            sourceElement: rootRef.current ?? event.currentTarget,
            originalStart: formatDate(projectRange!.start),
            originalEnd: formatDate(projectRange!.end),
            timelineDayWidth,
            timelineLeftInset,
            timelineScrollContainerRef,
        });
    }

    function handleKeyboard(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget || isPending) return;
        const editing = activeProjectKeyboardId === project.id;
        // ContextMenu key / Shift+F10: the keyboard equivalent of a right-click.
        if (!editing && canEdit && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
            event.preventDefault();
            onProjectActivate(project.id);
            return;
        }
        if (!editing && canMoveProject && event.altKey && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            onProjectKeyboardStart(project, event.currentTarget);
            return;
        }
        if (!editing && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            onProjectActivate(project.id);
            return;
        }
        if (!canMoveProject) return;
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

    // Right-click (item 1): canEdit-gated — read-only roles get the browser's
    // default context menu instead.
    function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
        if (!canEdit || isPending) return;
        if ((event.target as HTMLElement).closest("a,button,input,summary,form,details")) return;
        event.preventDefault();
        onProjectActivate(project.id);
    }

    // A bare click opens the project drawer. An active drag calls preventDefault
    // on pointermove once its threshold is crossed, suppressing the synthetic
    // click so this only fires for genuine clicks.
    function handleBarClick(event: ReactMouseEvent<HTMLDivElement>) {
        if (!canEdit || isPending) return;
        if ((event.target as HTMLElement).closest("a,button,input,summary,form,details")) return;
        onProjectActivate(project.id);
    }

    return (
        <div
            ref={rootRef}
            className={`group/project relative touch-pan-y select-none overflow-visible rounded-md border text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 ${canMoveProject && !isPending ? "cursor-move" : ""} ${isDraft ? "border-dashed border-2 border-white/90 saturate-[.55] brightness-95" : "border-black/10"}`}
            style={{ backgroundColor: projectColor, height: barHeight }}
            data-drag-visual-kind="project"
            data-drag-project-id={project.id}
            data-can-edit={canEdit ? "true" : "false"}
            role="group"
            aria-label={`${project.name} project bar${isDraft ? " (unsaved change)" : ""}`}
            aria-disabled={!canEdit || isPending}
            aria-busy={isPending}
            tabIndex={canEdit && !isPending ? 0 : undefined}
            onPointerDown={handlePointerDown}
            onClick={handleBarClick}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyboard}
        >
            <div data-drag-project-title="true" className="absolute inset-x-0 top-0 z-10 flex h-[18px] min-w-0 items-center gap-1 px-1 text-[10px] leading-none">
                {segment.continuesBefore && <span aria-hidden="true">‹</span>}
                <span title={projectTitle} className="min-w-0 flex-1 truncate font-semibold text-white">
                    {project.name}
                </span>
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
                {segment.continuesAfter && <span aria-hidden="true">›</span>}
            </div>
            {/* Right-edge resize handle (item 2) — confined to the title strip's
            own 18px band (top-0, h-[18px]) so it can NEVER vertically overlap a
            task block's own resize-right handle, which lives only inside the
            task strip below (18px..barHeight). Only rendered on the segment
            that actually ENDS the project (not a continuation into a future
            week/timeline clip) — canEdit-gated like every other end-date
            affordance (item 1), independent of canMoveProject. */}
            {canEdit && !isPending && !segment.continuesAfter && (
                <div
                    role="presentation"
                    aria-hidden="true"
                    title={`Drag to change ${project.name}'s end date`}
                    // 16px grab zone with a 4px overhang past the bar edge — a
                    // 6px sliver was practically unhittable next to the bar's
                    // own move/click cursor (owner couldn't find it).
                    className="absolute -right-1 top-0 z-20 h-[18px] w-4 touch-pan-y cursor-ew-resize opacity-0 transition group-hover/project:opacity-100 group-focus-within/project:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={handleEndResizePointerDown}
                >
                    <span className="absolute inset-y-1 left-[5px] w-px bg-white/90" />
                    <span className="absolute inset-y-1 left-[9px] w-px bg-white/90" />
                </div>
            )}
            <ProjectTaskOverflow projectName={project.name} tasks={hiddenTasks} />
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
                        teamMembers={teamMembers}
                        isAnyDragActive={isAnyDragActive}
                        onTaskPointerEditStart={onTaskPointerEditStart}
                        onTaskKeyboardStart={onTaskKeyboardStart}
                        onTaskKeyboardAdjust={onTaskKeyboardAdjust}
                        onTaskKeyboardCommit={onTaskKeyboardCommit}
                        onTaskKeyboardCancel={onTaskKeyboardCancel}
                        onTaskDatesCommit={onTaskDatesCommit}
                        onTaskMoveBy={onTaskMoveBy}
                        onActivate={onActivate}
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
