"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DashboardTaskRow } from "@/lib/schedule-core";
import { deleteScheduleTask } from "@/lib/actions";
import { addDays, formatDate, getDaysBetween, getDefaultColorForTaskName, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { clipRange, type DateRange, type TaskDateOverride, type TaskEditMode } from "./useBarLayout";
import { FloatingPopover } from "./FloatingPopover";
import { TaskCrewPicker } from "./CrewPickers";
import { activateExclusiveMenu, deactivateExclusiveMenu } from "./menuCoordinator";

export interface TaskPointerEditStart {
    pointerId: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    sourceElement: HTMLElement;
    timelineDayWidth?: number;
    timelineLeftInset?: number;
    timelineScrollContainerRef?: RefObject<HTMLDivElement | null>;
}

export interface ActiveTaskKeyboardEdit {
    taskId: string;
    mode: TaskEditMode;
}

export interface TaskEditCallbacks {
    onTaskPointerEditStart: (_task: DashboardTaskRow, _mode: TaskEditMode, _start: TaskPointerEditStart) => void;
    onTaskKeyboardStart: (_task: DashboardTaskRow, _mode: TaskEditMode, _sourceElement: HTMLElement) => void;
    onTaskKeyboardAdjust: (_task: DashboardTaskRow, _mode: TaskEditMode, _deltaDays: number) => void;
    onTaskKeyboardCommit: (_task: DashboardTaskRow, _mode: TaskEditMode) => void;
    onTaskKeyboardCancel: (_task: DashboardTaskRow) => void;
    onTaskDatesCommit: (_task: DashboardTaskRow, _dates: TaskDateOverride) => void;
    onTaskMoveBy: (_task: DashboardTaskRow, _deltaDays: number) => void;
}

export interface TaskBlockSegmentProps extends TaskEditCallbacks {
    task: DashboardTaskRow;
    projectRange: DateRange;
    visibleRange: DateRange;
    projectColor: string;
    canEdit: boolean;
    isPending: boolean;
    // Drafted (unsaved) — dashed ring + desaturated, but still fully
    // draggable/editable (draft mode never locks a drafted item).
    isDraft?: boolean;
    activeTaskKeyboardEdit: ActiveTaskKeyboardEdit | null;
    timelineDayWidth?: number;
    timelineLeftInset?: number;
    timelineScrollContainerRef?: RefObject<HTMLDivElement | null>;
    // Mini-lane placement within a project bar carrying overlapping tasks.
    // Omitted (default) fills the parent's full height, as before.
    laneTop?: number;
    laneHeight?: number;
    // Context-menu "Task crew…" (item 1) reuses the exact TaskCrewPicker the
    // Schedule & crew table uses.
    teamMembers: { id: string; name: string; email: string }[];
}

function readableText(color: string): string {
    const normalized = color.replace("#", "");
    if (normalized.length !== 6) return "#ffffff";
    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);
    return red * 299 + green * 587 + blue * 114 > 155_000 ? "#0f172a" : "#ffffff";
}

function initials(name: string): string {
    return name.trim().split(/\s+/).map(part => part[0]).join("").toUpperCase().slice(0, 2) || "?";
}

// Readability pass (2026-07-22): a task chip only shows its text label once
// it's wide enough for roughly 3 characters at the bumped 11px label font —
// narrower than that, the label is dropped in favor of the milestone's own
// diamond icon (or, for a plain task, the existing title tooltip alone).
const MIN_LABEL_WIDTH_PX = 28;

// Same single-popover, view-switching pattern as ProjectBar (item 1): one
// FloatingPopover instance whose content swaps between the top-level menu
// list and each item's own sub-view.
type TaskMenuView = "main" | "dates" | "crew";

export function TaskBlockSegment({
    task,
    projectRange,
    visibleRange,
    projectColor,
    canEdit,
    isPending,
    isDraft = false,
    activeTaskKeyboardEdit,
    timelineDayWidth,
    timelineLeftInset,
    timelineScrollContainerRef,
    laneTop,
    laneHeight,
    teamMembers,
    onTaskPointerEditStart,
    onTaskKeyboardStart,
    onTaskKeyboardAdjust,
    onTaskKeyboardCommit,
    onTaskKeyboardCancel,
    onTaskDatesCommit,
    onTaskMoveBy,
}: TaskBlockSegmentProps) {
    const router = useRouter();
    const observerRef = useRef<ResizeObserver | null>(null);
    const fragmentId = useId().replace(/:/g, "");
    const [allocatedWidth, setAllocatedWidth] = useState(0);
    const actionTriggerRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number } | null>(null);
    const [menuView, setMenuView] = useState<TaskMenuView>("main");
    const [isDeletePending, startDeleteTransition] = useTransition();
    const actionResetKey = `${isPending ? "pending" : "ready"}:${task.startDate}:${task.endDate}`;
    const [menuDraft, setMenuDraft] = useState<{ resetKey: string; dates: TaskDateOverride | null }>(() => ({
        resetKey: actionResetKey,
        dates: null,
    }));
    const menuDates = menuDraft.resetKey === actionResetKey ? menuDraft.dates : null;
    if (menuDraft.resetKey !== actionResetKey) {
        setMenuDraft({ resetKey: actionResetKey, dates: null });
    }
    const isMilestone = task.type === "milestone";
    const menuStartDate = menuDates?.startDate ?? task.startDate.slice(0, 10);
    const menuEndDate = menuDates?.endDate ?? (isMilestone ? task.startDate.slice(0, 10) : task.endDate.slice(0, 10));
    const taskStart = parseUTCDate(task.startDate.slice(0, 10));
    const taskEnd = parseUTCDate(task.endDate.slice(0, 10));
    const visualEnd = isMilestone ? addDays(taskStart, 1) : taskEnd;
    const taskRange = { start: taskStart, end: visualEnd };
    const clipped = clipRange(taskRange, visibleRange);
    const activeMode = activeTaskKeyboardEdit?.taskId === task.id ? activeTaskKeyboardEdit.mode : null;

    const setMeasuredElement = useCallback((element: HTMLDivElement | null) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        if (!element) return;

        setAllocatedWidth(element.getBoundingClientRect().width);
        if (typeof ResizeObserver === "undefined") return;
        observerRef.current = new ResizeObserver(entries => setAllocatedWidth(entries[0]?.contentRect.width ?? 0));
        observerRef.current.observe(element);
    }, []);

    useEffect(() => () => observerRef.current?.disconnect(), []);
    useEffect(() => {
        setMenuOpen(false);
    }, [actionResetKey]);
    // Only one schedule-board menu open at a time (item 1) — including across
    // a right-click/context menu vs the click-triggered "⋯" menu.
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

    if (!clipped || (!isMilestone && taskEnd <= taskStart)) return null;

    const visibleDays = getDaysBetween(visibleRange.start, visibleRange.end);
    const left = getDaysBetween(visibleRange.start, clipped.start) / visibleDays * 100;
    const width = getDaysBetween(clipped.start, clipped.end) / visibleDays * 100;
    const color = task.color || getDefaultColorForTaskName(task.name) || projectColor;
    const progress = Math.max(0, Math.min(100, task.progress));
    const crew = task.assignments.length > 0 ? task.assignments.map(assignment => assignment.name).join(", ") : "Unassigned";
    const assignmentInitials = task.assignments.slice(0, 2).map(assignment => initials(assignment.name)).join(" ");
    const title = `${task.name} — ${task.status} — UTC ${formatDate(taskStart)} → ${formatDate(isMilestone ? taskStart : taskEnd)} — ${progress}% — Crew: ${crew}`;
    const mutationDisabled = !canEdit || isPending;

    function beginPointerEdit(event: ReactPointerEvent<HTMLElement>, mode: TaskEditMode) {
        event.stopPropagation();
        if (!canEdit || isPending || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        if (mode === "move" && (event.target as HTMLElement).closest("button,input,summary,form,details")) return;
        onTaskPointerEditStart(task, mode, {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            clientX: event.clientX,
            clientY: event.clientY,
            sourceElement: event.currentTarget,
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

    function handleKeyboard(event: KeyboardEvent<HTMLElement>, mode: TaskEditMode) {
        if (event.target !== event.currentTarget) return;
        if (!canEdit || isPending) return;
        const editing = activeMode === mode;
        // ContextMenu key / Shift+F10 (item 1) on the block itself (move
        // target) — the keyboard equivalent of a right-click.
        if (mode === "move" && !editing && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
            event.preventDefault();
            event.stopPropagation();
            openMenu(null);
            return;
        }
        if (!editing && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            event.stopPropagation();
            onTaskKeyboardStart(task, mode, event.currentTarget);
            return;
        }
        if (!editing) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onTaskKeyboardCancel(task);
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            onTaskKeyboardCommit(task, mode);
            return;
        }
        const step = event.shiftKey ? 7 : 1;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            onTaskKeyboardAdjust(task, mode, -step);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            onTaskKeyboardAdjust(task, mode, step);
        }
    }

    // Right-click (item 1): canEdit-gated — read-only roles get the browser's
    // default context menu instead.
    function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
        if (!canEdit || isPending) return;
        if ((event.target as HTMLElement).closest("input,summary,form,details")) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu({ x: event.clientX, y: event.clientY });
    }

    function handleDateSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        event.stopPropagation();
        if (mutationDisabled || !menuStartDate || (!isMilestone && !menuEndDate)) return;
        onTaskDatesCommit(task, {
            startDate: menuStartDate,
            endDate: isMilestone ? menuStartDate : menuEndDate,
        });
        setMenuDraft({ resetKey: actionResetKey, dates: null });
        setMenuOpen(false);
    }

    // Delete is an IMMEDIATE action (item 1) — goes through the existing
    // deleteScheduleTask action right away, NOT part of the board's
    // draft-mode/Save system (unlike a date drag, which drafts until Save).
    function handleDeleteTask() {
        if (!window.confirm(`Delete "${task.name}"? Deletes now — not part of unsaved changes. This can't be undone.`)) return;
        startDeleteTransition(async () => {
            try {
                await deleteScheduleTask(task.id);
                router.refresh();
                toast.success(`Deleted "${task.name}"`);
            } catch (err: any) {
                toast.error(err?.message || "Failed to delete task");
            }
        });
        setMenuOpen(false);
    }

    const laneStyle = laneTop != null && laneHeight != null
        ? { top: laneTop, height: laneHeight }
        : undefined;

    return (
        <div
            ref={setMeasuredElement}
            className={`group/task absolute ${laneStyle ? "" : "inset-y-0"} touch-pan-y select-none overflow-visible rounded-sm border text-[11px] font-semibold leading-[20px] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${canEdit && !isPending ? "cursor-move" : ""} ${isDraft ? "border-dashed border-2 border-white/90 saturate-[.55] brightness-95" : "border-black/10"}`}
            style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color, color: readableText(color), ...laneStyle }}
            title={title}
            role="group"
            tabIndex={0}
            aria-label={`${title}. ${canEdit ? "Press Space or Enter to move with the keyboard." : "Read only."}${isDraft ? " Unsaved change." : ""}`}
            aria-disabled={!canEdit || isPending}
            aria-busy={isPending}
            data-task-edit-block="true"
            data-project-start={formatDate(projectRange.start)}
            data-can-edit={canEdit ? "true" : "false"}
            onPointerDown={event => beginPointerEdit(event, "move")}
            onKeyDown={event => handleKeyboard(event, "move")}
            onContextMenu={handleContextMenu}
        >
            <div className="absolute inset-0 overflow-hidden rounded-sm">
                <span className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${progress}%` }} aria-hidden="true" />
                <span className="relative z-10 flex min-w-0 items-center justify-between gap-0.5 px-1">
                    {allocatedWidth >= MIN_LABEL_WIDTH_PX
                        ? <span className="min-w-0 truncate">{isMilestone ? `◆ ${task.name}` : task.name}</span>
                        : isMilestone && <span className="min-w-0 truncate" aria-hidden="true">◆</span>}
                    {assignmentInitials && <span className="ml-auto shrink-0 text-[8px] opacity-90" title={`Task crew: ${crew}`}>{assignmentInitials}</span>}
                </span>
            </div>

            {task.type !== "milestone" && (
                <button
                    type="button"
                    className="absolute inset-y-0 left-0 z-20 w-2 touch-pan-y cursor-ew-resize rounded-l-sm bg-black/10 opacity-0 transition group-hover/task:opacity-100 group-focus-within/task:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    aria-label={`Resize start of ${task.name}`}
                    aria-disabled={!canEdit || isPending}
                    aria-pressed={activeMode === "resize-left"}
                    disabled={mutationDisabled}
                    onPointerDown={event => beginPointerEdit(event, "resize-left")}
                    onKeyDown={event => handleKeyboard(event, "resize-left")}
                />
            )}
            {task.type !== "milestone" && (
                <button
                    type="button"
                    className="absolute inset-y-0 right-0 z-20 w-2 touch-pan-y cursor-ew-resize rounded-r-sm bg-black/10 opacity-0 transition group-hover/task:opacity-100 group-focus-within/task:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    aria-label={`Resize end of ${task.name}`}
                    aria-disabled={!canEdit || isPending}
                    aria-pressed={activeMode === "resize-right"}
                    disabled={mutationDisabled}
                    onPointerDown={event => beginPointerEdit(event, "resize-right")}
                    onKeyDown={event => handleKeyboard(event, "resize-right")}
                />
            )}

            {!mutationDisabled && (
            <>
                <button
                    ref={actionTriggerRef}
                    type="button"
                    onClick={event => { event.stopPropagation(); if (menuOpen) setMenuOpen(false); else openMenu(null); }}
                    onPointerDown={event => event.stopPropagation()}
                    aria-expanded={menuOpen}
                    className="absolute right-0 top-0 z-30 cursor-pointer rounded bg-white/85 px-1 text-[8px] font-bold text-slate-800 opacity-0 shadow transition group-hover/task:opacity-100 group-focus-within/task:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label={`Task actions for ${task.name}`}
                >
                    ⋯
                </button>
                <FloatingPopover open={menuOpen} anchorRef={actionTriggerRef} anchorPoint={menuAnchorPoint} onClose={() => setMenuOpen(false)} width={240}>
                    {menuView === "main" && (
                        <div className="space-y-1" onPointerDown={event => event.stopPropagation()}>
                            <button type="button" onClick={() => setMenuView("dates")} className="block w-full rounded px-2 py-1.5 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                Edit dates…
                            </button>
                            <button type="button" onClick={() => setMenuView("crew")} className="block w-full rounded px-2 py-1.5 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                Task crew…
                            </button>
                            <button
                                type="button"
                                disabled={isDeletePending}
                                onClick={handleDeleteTask}
                                className="block w-full rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60"
                            >
                                Delete task
                            </button>
                            <p className="px-2 text-[9px] text-hui-textMuted">Deletes now — not part of unsaved changes.</p>
                        </div>
                    )}
                    {menuView === "dates" && (
                        <form onSubmit={handleDateSubmit} onPointerDown={event => event.stopPropagation()} className="space-y-2">
                            <button type="button" onClick={() => setMenuView("main")} className="text-[10px] font-semibold text-hui-textMuted hover:text-hui-primary">← Back</button>
                            <label className="block text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`task-start-${task.id}-${fragmentId}`}>Start date</label>
                            <input
                                id={`task-start-${task.id}-${fragmentId}`}
                                type="date"
                                value={menuStartDate}
                                max={!isMilestone && menuEndDate ? formatDate(addDays(parseUTCDate(menuEndDate), -1)) : undefined}
                                onChange={event => {
                                    const nextStartDate = event.target.value;
                                    setMenuDraft({
                                        resetKey: actionResetKey,
                                        dates: { startDate: nextStartDate, endDate: isMilestone ? nextStartDate : menuEndDate },
                                    });
                                }}
                                disabled={mutationDisabled}
                                className="hui-input w-full px-2 py-1 text-xs"
                            />
                            <label className="block text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted" htmlFor={`task-end-${task.id}-${fragmentId}`}>End date</label>
                            <input
                                id={`task-end-${task.id}-${fragmentId}`}
                                type="date"
                                value={isMilestone ? menuStartDate : menuEndDate}
                                min={!isMilestone && menuStartDate ? formatDate(addDays(parseUTCDate(menuStartDate), 1)) : undefined}
                                onChange={event => setMenuDraft({
                                    resetKey: actionResetKey,
                                    dates: { startDate: menuStartDate, endDate: event.target.value },
                                })}
                                disabled={mutationDisabled || isMilestone}
                                className="hui-input w-full px-2 py-1 text-xs"
                            />
                            <div className="grid grid-cols-2 gap-2">
                                <button type="button" disabled={mutationDisabled} onClick={() => onTaskMoveBy(task, -1)} className="hui-btn hui-btn-secondary text-[10px] disabled:opacity-60">Move Earlier</button>
                                <button type="button" disabled={mutationDisabled} onClick={() => onTaskMoveBy(task, 1)} className="hui-btn hui-btn-secondary text-[10px] disabled:opacity-60">Move Later</button>
                            </div>
                            <button type="submit" disabled={mutationDisabled || !menuStartDate || (!isMilestone && !menuEndDate)} className="hui-btn hui-btn-primary w-full text-xs disabled:opacity-60">
                                Save task dates
                            </button>
                        </form>
                    )}
                    {menuView === "crew" && (
                        <div className="space-y-2" onPointerDown={event => event.stopPropagation()}>
                            <button type="button" onClick={() => setMenuView("main")} className="text-[10px] font-semibold text-hui-textMuted hover:text-hui-primary">← Back</button>
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">Task crew</p>
                            <TaskCrewPicker task={task} teamMembers={teamMembers} />
                        </div>
                    )}
                </FloatingPopover>
            </>
            )}
        </div>
    );
}
