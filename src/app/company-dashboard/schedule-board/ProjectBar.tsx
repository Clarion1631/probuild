"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
    DashboardProjectRow,
    OverlayChangeOrderItem,
    OverlayIncomeItem,
} from "@/lib/schedule-core";
import { updateProjectColor, updateProjectEndDateAction, updateProjectStartDateAction } from "@/lib/actions";
import { addDays, formatDate, parseUTCDate, PRESET_COLORS } from "@/app/projects/[id]/schedule/schedule-utils";
import { assignTaskLanes, getEffectiveProjectRange, type WeekSegment } from "./useBarLayout";
import { MilestoneMarker } from "./MilestoneMarker";
import { TaskBlockSegment, type ActiveTaskKeyboardEdit, type TaskEditCallbacks } from "./TaskBlockSegment";
import { FloatingPopover } from "./FloatingPopover";
import { CrewPicker } from "./CrewPickers";
import { activateExclusiveMenu, deactivateExclusiveMenu } from "./menuCoordinator";

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
    // Context-menu "Project crew…" / TaskBlockSegment's "Task crew…" (item 1)
    // reuse the exact CrewPicker/TaskCrewPicker the Schedule & crew table uses.
    teamMembers: { id: string; name: string; email: string }[];
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

// The bar's Actions/context menu is a single FloatingPopover instance whose
// CONTENT switches between a top-level list and each item's own sub-view
// (item 1) — simpler and more robust than nesting flyout panels, and keeps
// every item reachable by keyboard from the same panel.
type BarMenuView = "main" | "dates" | "crew" | "color" | "end-date";

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
    const router = useRouter();
    const gridStart = useContext(ProjectBarGridStartContext);
    const projectRange = getEffectiveProjectRange(project);
    const projectStart = projectRange ? formatDate(projectRange.start) : "";
    const actionTriggerRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number } | null>(null);
    const [menuView, setMenuView] = useState<BarMenuView>("main");
    const overflowTriggerRef = useRef<HTMLButtonElement>(null);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const actionResetKey = `${isPending ? "pending" : "ready"}:${projectStart}`;
    const [targetStartDraft, setTargetStartDraft] = useState(() => ({ resetKey: actionResetKey, value: projectStart }));
    const targetStart = targetStartDraft.resetKey === actionResetKey ? targetStartDraft.value : projectStart;
    if (targetStartDraft.resetKey !== actionResetKey) {
        setTargetStartDraft({ resetKey: actionResetKey, value: projectStart });
    }
    const projectEndDate = project.endDate ? project.endDate.slice(0, 10) : "";
    const [endDateDraft, setEndDateDraft] = useState(() => ({ resetKey: actionResetKey, value: projectEndDate }));
    const endDateValue = endDateDraft.resetKey === actionResetKey ? endDateDraft.value : projectEndDate;
    if (endDateDraft.resetKey !== actionResetKey) {
        setEndDateDraft({ resetKey: actionResetKey, value: projectEndDate });
    }
    const [isColorPending, startColorTransition] = useTransition();
    const [isEndDatePending, startEndDateTransition] = useTransition();
    const [isRemovePending, startRemoveTransition] = useTransition();
    useEffect(() => {
        setMenuOpen(false);
    }, [actionResetKey]);
    // Only one schedule-board menu open at a time (item 1) — including across
    // a right-click/context menu vs the click-triggered Actions menu.
    useEffect(() => {
        if (!menuOpen) {
            setMenuView("main");
            setMenuAnchorPoint(null);
            return;
        }
        const close = () => setMenuOpen(false);
        activateExclusiveMenu(close);
        return () => deactivateExclusiveMenu(close);
    }, [menuOpen]);
    // The "+N" overflow popover is a menu too — register it so opening any
    // other menu (mouse OR keyboard) closes it, preserving one-menu-at-a-time.
    useEffect(() => {
        if (!overflowOpen) return;
        const close = () => setOverflowOpen(false);
        activateExclusiveMenu(close);
        return () => deactivateExclusiveMenu(close);
    }, [overflowOpen]);
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

    function openMenu(anchorPoint: { x: number; y: number } | null) {
        setMenuAnchorPoint(anchorPoint);
        setMenuView("main");
        setMenuOpen(true);
    }

    function handleKeyboard(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget || isPending) return;
        const editing = activeProjectKeyboardId === project.id;
        // ContextMenu key / Shift+F10: the keyboard equivalent of a right-click
        // (item 1) — opens the same menu the Actions button opens, ref-anchored
        // since there is no cursor position to anchor to.
        if (!editing && canEdit && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
            event.preventDefault();
            openMenu(null);
            return;
        }
        if (!canMoveProject) return;
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

    // Right-click (item 1): canEdit-gated — read-only roles get the browser's
    // default context menu instead.
    function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
        if (!canEdit || isPending) return;
        if ((event.target as HTMLElement).closest("a,button,input,summary,form,details")) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
    }

    function handleDateSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!targetStart || isPending) return;
        onMoveCommit(project, targetStart);
        setMenuOpen(false);
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
        setMenuOpen(false);
    }

    // Immediate action (item 3) — NOT part of the board's draft-mode system;
    // takes effect right away, unlike task/project START dates which route
    // through Save.
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
        setMenuOpen(false);
    }

    // Waiting-to-Start projects only (item 1) — immediate action through the
    // EXISTING updateProjectStartDateAction(projectId, null, false) path,
    // never offered for In Progress or any other status.
    function handleRemoveFromSchedule() {
        if (!window.confirm(`Remove "${project.name}" from the schedule? This clears its start date — the project moves back to Unscheduled.`)) return;
        startRemoveTransition(async () => {
            try {
                await updateProjectStartDateAction(project.id, null, false);
                router.refresh();
                toast.success("Removed from schedule");
            } catch (err: any) {
                toast.error(err?.message || "Failed to remove from schedule");
            }
        });
        setMenuOpen(false);
    }

    // A bare click on the bar (not a drag, and not on an interactive
    // descendant like the name link or the Actions menu itself) toggles the
    // Actions dropdown instead of doing nothing — the bar itself never
    // navigates. An active drag calls preventDefault on pointermove once the
    // threshold is crossed, which suppresses the browser's synthetic click,
    // so this only fires for genuine clicks.
    function handleBarClick(event: ReactMouseEvent<HTMLDivElement>) {
        if (!canEdit || isPending) return;
        if ((event.target as HTMLElement).closest("a,button,input,summary,form,details")) return;
        if (menuOpen) {
            setMenuOpen(false);
        } else {
            openMenu(null);
        }
    }

    const menuBusy = isColorPending || isEndDatePending || isRemovePending;

    return (
        <div
            className={`group/project relative touch-pan-y select-none overflow-visible rounded-md border text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 ${canMoveProject && !isPending ? "cursor-move" : ""} ${isDraft ? "border-dashed border-2 border-white/90 saturate-[.55] brightness-95" : "border-black/10"}`}
            style={{ backgroundColor: projectColor, height: barHeight }}
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
                {canEdit && (
                    <>
                        <button
                            ref={actionTriggerRef}
                            type="button"
                            onClick={event => { event.stopPropagation(); if (menuOpen) setMenuOpen(false); else openMenu(null); }}
                            aria-expanded={menuOpen}
                            className="shrink-0 cursor-pointer rounded bg-white/20 px-1 py-0.5 text-[9px] font-bold text-white opacity-0 transition hover:bg-white/30 group-hover/project:opacity-100 group-focus-within/project:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            aria-label={`Project actions for ${project.name}`}
                        >
                            Actions
                        </button>
                        <FloatingPopover open={menuOpen} anchorRef={actionTriggerRef} anchorPoint={menuAnchorPoint} onClose={() => setMenuOpen(false)} width={240}>
                            {menuView === "main" && (
                                <div className="space-y-1">
                                    <Link
                                        href={`/projects/${project.id}`}
                                        className="block w-full rounded px-2 py-1.5 text-xs font-semibold text-hui-primary hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                    >
                                        Open project
                                    </Link>
                                    {project.distanceMilesFromShop != null && (
                                        <p className="px-2 text-[10px] text-hui-textMuted">≈{project.distanceMilesFromShop} mi from shop</p>
                                    )}
                                    {canMoveProject && (
                                        <button type="button" onClick={() => setMenuView("dates")} className="block w-full rounded px-2 py-1.5 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                            Edit dates…
                                        </button>
                                    )}
                                    <button type="button" onClick={() => setMenuView("crew")} className="block w-full rounded px-2 py-1.5 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                        Project crew…
                                    </button>
                                    <button type="button" onClick={() => setMenuView("color")} className="block w-full rounded px-2 py-1.5 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                        Color…
                                    </button>
                                    <button type="button" onClick={() => setMenuView("end-date")} className="block w-full rounded px-2 py-1.5 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                        Set end date…
                                    </button>
                                    {project.status === "Waiting to Start" && (
                                        <button
                                            type="button"
                                            disabled={menuBusy}
                                            onClick={handleRemoveFromSchedule}
                                            className="block w-full rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60"
                                        >
                                            Remove from schedule
                                        </button>
                                    )}
                                </div>
                            )}
                            {menuView === "dates" && canMoveProject && (
                                <form onSubmit={handleDateSubmit} className="space-y-2">
                                    <button type="button" onClick={() => setMenuView("main")} className="text-[10px] font-semibold text-hui-textMuted hover:text-hui-primary">← Back</button>
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
                            )}
                            {menuView === "crew" && (
                                <div className="space-y-2">
                                    <button type="button" onClick={() => setMenuView("main")} className="text-[10px] font-semibold text-hui-textMuted hover:text-hui-primary">← Back</button>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">Project crew</p>
                                    <CrewPicker projectId={project.id} crew={project.crew} teamMembers={teamMembers} />
                                </div>
                            )}
                            {menuView === "color" && (
                                <div className="space-y-2">
                                    <button type="button" onClick={() => setMenuView("main")} className="text-[10px] font-semibold text-hui-textMuted hover:text-hui-primary">← Back</button>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">Color</p>
                                    <div className="grid grid-cols-8 gap-1.5">
                                        {PRESET_COLORS.map(swatch => {
                                            const isSelected = !!project.color && project.color.toLowerCase() === swatch.toLowerCase();
                                            return (
                                                <button
                                                    key={swatch}
                                                    type="button"
                                                    disabled={isColorPending}
                                                    onClick={() => submitColor(swatch)}
                                                    className={`h-5 w-5 rounded-full transition hover:scale-110 disabled:opacity-60 ${isSelected ? "ring-2 ring-offset-1 ring-slate-700" : `ring-1 ${swatch.toLowerCase() === "#ffffff" ? "ring-slate-400" : "ring-slate-200"}`}`}
                                                    style={{ backgroundColor: swatch }}
                                                    title={swatch}
                                                    aria-label={`Set project color to ${swatch}`}
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {menuView === "end-date" && (
                                <div className="space-y-2">
                                    <button type="button" onClick={() => setMenuView("main")} className="text-[10px] font-semibold text-hui-textMuted hover:text-hui-primary">← Back</button>
                                    <p className="text-[10px] text-hui-textMuted">Immediate — not part of unsaved changes.</p>
                                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`bar-project-enddate-${project.id}`}>End date</label>
                                    <input
                                        id={`bar-project-enddate-${project.id}`}
                                        type="date"
                                        value={endDateValue}
                                        onChange={event => setEndDateDraft({ resetKey: actionResetKey, value: event.target.value })}
                                        disabled={isEndDatePending}
                                        className="hui-input w-full px-2 py-1 text-xs"
                                    />
                                    <div className="grid grid-cols-2 gap-2">
                                        <button type="button" disabled={isEndDatePending || !project.endDate} onClick={() => submitEndDate(null)} className="hui-btn hui-btn-secondary text-[10px] disabled:opacity-60">
                                            Clear
                                        </button>
                                        <button type="button" disabled={isEndDatePending || !endDateValue} onClick={() => submitEndDate(endDateValue)} className="hui-btn hui-btn-primary text-[10px] disabled:opacity-60">
                                            {isEndDatePending ? "Saving..." : "Save"}
                                        </button>
                                    </div>
                                </div>
                            )}
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
                        teamMembers={teamMembers}
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
