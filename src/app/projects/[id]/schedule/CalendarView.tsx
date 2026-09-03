"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Task, PunchItem, EstimateSummary } from "./schedule-types";
import ScheduleToolbar from "./ScheduleToolbar";
import { useScheduleActions } from "./useScheduleActions";
import {
    STATUS_OPTIONS,
    STATUS_COLORS,
    addDays,
    formatDate,
    getDaysBetween,
    isWeekend,
    getMonthGrid,
    getWeekDays,
    isSameUTCDay,
    parseUTCDate,
    todayUTC,
} from "./schedule-utils";
import ColorPicker from "./ColorPicker";
import {
    createScheduleTask, updateScheduleTask, deleteScheduleTask,
    addTaskPunchItem, togglePunchItem, deletePunchItem, getTaskPunchItems,
} from "@/lib/actions";

type ViewMode = "gantt" | "table" | "calendar";
type SubMode = "month" | "week";

type Props = {
    projectId: string;
    tasks: Task[];
    setTasks: Dispatch<SetStateAction<Task[]>>;
    estimates?: EstimateSummary[];
    initialPublished: boolean;
    viewMode?: ViewMode;
    onViewModeChange?: (m: ViewMode) => void;
    subMode: SubMode;
    onSubModeChange: (m: SubMode) => void;
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function formatHeader(d: Date) {
    return `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDayLabel(d: Date) {
    return `${WEEKDAY_LABELS[(d.getUTCDay() + 6) % 7]} ${MONTH_LABELS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
}

type DragMode = "move" | "resize";
type DragState = { taskId: string; mode: DragMode; offsetDays: number };

/**
 * One drawn piece of a task inside a single calendar week (Mon..Sun).
 * A task spanning several weeks becomes one segment per week; `startsHere`
 * and `endsHere` tell the bar whether to round/cap its edges and whether
 * to show the end-date drag handle.
 */
type Segment = {
    task: Task;
    startCol: number;
    spanDays: number;
    lane: number;
    startsHere: boolean;
    endsHere: boolean;
};

function taskRange(task: Task): { start: Date; end: Date } {
    const start = parseUTCDate(task.startDate);
    const endRaw = parseUTCDate(task.endDate);
    // Calendar treats endDate as the last day shown (inclusive). Guard against
    // legacy rows with end < start so they still draw as a one-day bar.
    return { start, end: endRaw.getTime() < start.getTime() ? start : endRaw };
}

function buildWeekSegments(tasks: Task[], weekStart: Date, maxLanes: number): { segments: Segment[]; hiddenByDay: number[] } {
    const weekEnd = addDays(weekStart, 6);
    const ranged = tasks
        .map(task => ({ task, ...taskRange(task) }))
        .filter(r => r.start.getTime() <= weekEnd.getTime() && r.end.getTime() >= weekStart.getTime())
        .sort((a, b) =>
            a.start.getTime() - b.start.getTime()
            || (b.end.getTime() - b.start.getTime()) - (a.end.getTime() - a.start.getTime())
            || a.task.order - b.task.order
            || a.task.name.localeCompare(b.task.name));
    const laneEnds: number[] = [];
    const segments: Segment[] = [];
    const hiddenByDay = Array.from({ length: 7 }, () => 0);
    for (const r of ranged) {
        const startCol = Math.max(0, getDaysBetween(weekStart, r.start));
        const endCol = Math.min(6, getDaysBetween(weekStart, r.end));
        let lane = laneEnds.findIndex(end => end < startCol);
        if (lane === -1) lane = laneEnds.length;
        if (lane >= maxLanes) {
            for (let c = startCol; c <= endCol; c++) hiddenByDay[c] += 1;
            continue;
        }
        laneEnds[lane] = endCol;
        segments.push({
            task: r.task,
            startCol,
            spanDays: endCol - startCol + 1,
            lane,
            startsHere: r.start.getTime() >= weekStart.getTime(),
            endsHere: r.end.getTime() <= weekEnd.getTime(),
        });
    }
    return { segments, hiddenByDay };
}

/** Which day column (0..6) of a 7-column row the pointer is over. */
function columnFromPointer(e: React.DragEvent | React.MouseEvent, rowEl: HTMLElement): number {
    const rect = rowEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = (e.clientX - rect.left) / rect.width;
    return Math.min(6, Math.max(0, Math.floor(ratio * 7)));
}

export default function CalendarView({ projectId, tasks, setTasks, estimates = [], initialPublished, viewMode, onViewModeChange, subMode, onSubModeChange }: Props) {
    const router = useRouter();
    const actions = useScheduleActions(projectId, tasks, setTasks);

    const [anchor, setAnchor] = useState<Date>(() => todayUTC());
    const [isPending, startTransition] = useTransition();

    const [quickAdd, setQuickAdd] = useState<{ date: Date; x: number; y: number; type: "task" | "milestone" } | null>(null);
    const [quickAddName, setQuickAddName] = useState("");
    const quickAddInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (quickAdd && quickAddInputRef.current) quickAddInputRef.current.focus(); }, [quickAdd]);

    const [editing, setEditing] = useState<{ taskId: string; x: number; y: number } | null>(null);
    const editingTask = useMemo(() => editing ? tasks.find(t => t.id === editing.taskId) ?? null : null, [editing, tasks]);

    const [drag, setDrag] = useState<DragState | null>(null);
    const [dragOverKey, setDragOverKey] = useState<string | null>(null);
    const [showToolsMenu, setShowToolsMenu] = useState(false);

    const today = todayUTC();
    const taskCount = tasks.length;
    const completedCount = tasks.filter(t => t.status === "Complete").length;

    function navPrev() {
        if (subMode === "week") setAnchor(prev => addDays(prev, -7));
        else setAnchor(prev => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)));
    }
    function navNext() {
        if (subMode === "week") setAnchor(prev => addDays(prev, 7));
        else setAnchor(prev => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)));
    }
    function navToday() { setAnchor(todayUTC()); }

    async function handleQuickAddSubmit() {
        const name = quickAddName.trim();
        const target = quickAdd?.date;
        const type = quickAdd?.type ?? "task";
        if (!name || !target) { setQuickAdd(null); setQuickAddName(""); return; }
        const dateStr = formatDate(target);
        try {
            await createScheduleTask(projectId, {
                name,
                startDate: dateStr,
                endDate: dateStr,
                color: "",
                status: "Not Started",
                type,
            });
            setQuickAdd(null);
            setQuickAddName("");
            toast.success(type === "milestone" ? "Milestone added" : "Task added");
            startTransition(() => router.refresh());
        } catch {
            // Server Action error messages are redacted in production builds, so a
            // generic message is the only honest one here.
            toast.error(type === "milestone" ? "Failed to add milestone" : "Failed to add task");
        }
    }

    function handleCellClick(day: Date, e: React.MouseEvent) {
        e.stopPropagation();
        if (editing) { setEditing(null); return; }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setQuickAdd({ date: day, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, type: "task" });
        setQuickAddName("");
    }

    /**
     * Toolbar "+ Task" / "+ Milestone": open the quick-add on today, navigating
     * the calendar to today if it is not on screen. The click that opens it
     * bubbles to the root "close popovers" handler, so that one bubble is skipped.
     */
    const skipNextRootClose = useRef(false);
    function openQuickAddFromToolbar(type: "task" | "milestone") {
        const date = todayUTC();
        const x = typeof window !== "undefined" ? window.innerWidth / 2 : 0;
        const y = typeof window !== "undefined" ? Math.min(220, window.innerHeight / 3) : 0;
        skipNextRootClose.current = true;
        setAnchor(date);
        setEditing(null);
        setQuickAdd({ date, x, y, type });
        setQuickAddName("");
    }
    function handleRootClick() {
        if (skipNextRootClose.current) { skipNextRootClose.current = false; return; }
        setQuickAdd(null);
        setEditing(null);
    }

    /** Gantt-only tools: take the user to the view where the feature actually lives. */
    function goToGanttFor(feature: string) {
        onViewModeChange?.("gantt");
        toast.info(`${feature} lives in the Gantt view`);
    }

    function handleTaskClick(task: Task, e: React.MouseEvent) {
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setEditing({ taskId: task.id, x: rect.left + rect.width / 2, y: rect.bottom + 6 });
        setQuickAdd(null);
    }

    async function patchTask(taskId: string, patch: Partial<Pick<Task, "name" | "status" | "color" | "startDate" | "endDate">>) {
        const before = tasks.find(t => t.id === taskId);
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...patch } : t));
        try {
            await updateScheduleTask(taskId, patch);
            startTransition(() => router.refresh());
        } catch {
            if (before) setTasks(prev => prev.map(t => t.id === taskId ? before : t));
            toast.error("Failed to save. The change was undone.");
        }
    }

    async function removeTask(taskId: string) {
        const before = tasks;
        setTasks(prev => prev.filter(t => t.id !== taskId));
        setEditing(null);
        try {
            await deleteScheduleTask(taskId);
            toast.success("Task deleted");
            startTransition(() => router.refresh());
        } catch {
            setTasks(before);
            toast.error("Failed to delete");
        }
    }

    /* ---- drag: move a bar (keeps the day you grabbed under the pointer) or drag its end date ---- */

    function handleBarDragStart(task: Task, grabbedDay: Date, e: React.DragEvent) {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        const { start } = taskRange(task);
        setDrag({ taskId: task.id, mode: "move", offsetDays: getDaysBetween(start, grabbedDay) });
        setQuickAdd(null);
        setEditing(null);
    }
    function handleHandleDragStart(task: Task, e: React.DragEvent) {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        setDrag({ taskId: task.id, mode: "resize", offsetDays: 0 });
        setQuickAdd(null);
        setEditing(null);
    }
    function handleDragEnd() {
        setDrag(null);
        setDragOverKey(null);
    }
    function handleRowDragOver(weekStart: Date, e: React.DragEvent) {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const day = addDays(weekStart, columnFromPointer(e, e.currentTarget as HTMLElement));
        const k = formatDate(day);
        if (k !== dragOverKey) setDragOverKey(k);
    }
    function handleRowDragLeave(e: React.DragEvent) {
        const next = e.relatedTarget as Node | null;
        if (next && (e.currentTarget as HTMLElement).contains(next)) return;
        setDragOverKey(null);
    }
    function handleRowDrop(weekStart: Date, e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        const day = addDays(weekStart, columnFromPointer(e, e.currentTarget as HTMLElement));
        const current = drag;
        setDrag(null);
        setDragOverKey(null);
        if (!current) return;
        const task = tasks.find(t => t.id === current.taskId);
        if (!task) return;
        const { start, end } = taskRange(task);
        if (current.mode === "resize") {
            const newEnd = day.getTime() < start.getTime() ? start : day;
            if (isSameUTCDay(newEnd, end)) return;
            patchTask(task.id, { endDate: formatDate(newEnd) });
            return;
        }
        const newStart = addDays(day, -current.offsetDays);
        if (isSameUTCDay(newStart, start)) return;
        const duration = Math.max(0, getDaysBetween(start, end));
        patchTask(task.id, { startDate: formatDate(newStart), endDate: formatDate(addDays(newStart, duration)) });
    }

    /** Days that would be covered if the drag were dropped where the pointer is now. */
    const dropPreview = useMemo<{ start: Date; end: Date } | null>(() => {
        if (!drag || !dragOverKey) return null;
        const task = tasks.find(t => t.id === drag.taskId);
        if (!task) return null;
        const { start, end } = taskRange(task);
        const day = parseUTCDate(dragOverKey);
        if (drag.mode === "resize") return { start, end: day.getTime() < start.getTime() ? start : day };
        const newStart = addDays(day, -drag.offsetDays);
        return { start: newStart, end: addDays(newStart, Math.max(0, getDaysBetween(start, end))) };
    }, [drag, dragOverKey, tasks]);

    const gridProps = {
        today,
        tasks,
        dragTaskId: drag?.taskId ?? null,
        dropPreview,
        onCellClick: handleCellClick,
        onTaskClick: handleTaskClick,
        onBarDragStart: handleBarDragStart,
        onHandleDragStart: handleHandleDragStart,
        onDragEnd: handleDragEnd,
        onRowDragOver: handleRowDragOver,
        onRowDragLeave: handleRowDragLeave,
        onRowDrop: handleRowDrop,
    };

    return (
        <div className="flex flex-col h-full bg-hui-background" onClick={handleRootClick}>
            <ScheduleToolbar
                projectId={projectId}
                initialPublished={initialPublished}
                taskCount={taskCount}
                completedCount={completedCount}
                estimates={estimates}
                viewMode={viewMode ?? "calendar"}
                onViewModeChange={onViewModeChange ?? (() => {})}
                isAdding={false}
                onAddTask={() => openQuickAddFromToolbar("task")}
                onAddMilestone={() => openQuickAddFromToolbar("milestone")}
                isAiGenerating={actions.isAiGenerating}
                showAiMenu={actions.showAiMenu}
                onToggleAiMenu={() => actions.setShowAiMenu(!actions.showAiMenu)}
                onAiSchedule={actions.handleAiSchedule}
                showToolsMenu={showToolsMenu}
                onToggleToolsMenu={() => setShowToolsMenu(v => !v)}
                showCriticalPath={false}
                onToggleCriticalPath={() => goToGanttFor("Critical path")}
                linkMode={null}
                onToggleLinkMode={() => goToGanttFor("Linking tasks")}
                onSyncCalendar={actions.handleSyncCalendar}
                isAiRisk={false}
                onAiRisk={() => goToGanttFor("AI risk analysis")}
                isImporting={actions.isImporting}
                onImportEstimate={actions.handleImportEstimate}
                onClearAll={actions.handleClearAll}
                secondaryContent={
                    <div className="bg-white border-b border-hui-border px-6 py-2 flex items-center gap-2 shrink-0">
                        <button onClick={navPrev} className="px-2 py-1.5 text-slate-600 hover:bg-slate-100 rounded-md transition" aria-label="Previous">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                        </button>
                        <button onClick={navToday} className="px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md transition border border-slate-200">Today</button>
                        <button onClick={navNext} className="px-2 py-1.5 text-slate-600 hover:bg-slate-100 rounded-md transition" aria-label="Next">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                        <span className="text-sm font-semibold text-hui-textMain px-2 min-w-[140px] text-center">{formatHeader(anchor)}</span>
                        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                            <button onClick={() => onSubModeChange("month")} className={`px-3 py-1 text-xs font-medium rounded-md transition ${subMode === "month" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Month</button>
                            <button onClick={() => onSubModeChange("week")} className={`px-3 py-1 text-xs font-medium rounded-md transition ${subMode === "week" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Week</button>
                        </div>
                        <span className="ml-auto text-[11px] text-slate-400 hidden md:inline">Drag a bar to move it · drag its right edge to change the end date · click a day to add</span>
                    </div>
                }
            />

            <div className="flex-1 overflow-auto">
                {subMode === "week" ? (
                    <WeekGrid anchor={anchor} {...gridProps} />
                ) : (
                    <MonthGrid anchor={anchor} onSwitchToWeek={(d) => { setAnchor(d); onSubModeChange("week"); }} {...gridProps} />
                )}
            </div>

            {/* Quick-add popover */}
            {quickAdd && (
                <div
                    className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-2xl p-3 w-72 animate-in fade-in"
                    style={{ left: clamp(quickAdd.x - 144, 8, typeof window !== "undefined" ? window.innerWidth - 296 : 0), top: clamp(quickAdd.y, 8, typeof window !== "undefined" ? window.innerHeight - 140 : 0) }}
                    onClick={e => e.stopPropagation()}
                >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{quickAdd.type === "milestone" ? "New milestone" : "New task"}</div>
                    <div className="text-xs text-hui-textMain mb-2">{formatDayLabel(quickAdd.date)}</div>
                    <input
                        ref={quickAddInputRef}
                        value={quickAddName}
                        onChange={e => setQuickAddName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter") { e.preventDefault(); handleQuickAddSubmit(); }
                            if (e.key === "Escape") { e.preventDefault(); setQuickAdd(null); setQuickAddName(""); }
                        }}
                        placeholder={quickAdd.type === "milestone" ? "Milestone name" : "Task name"}
                        className="hui-input w-full text-sm"
                    />
                    <div className="mt-2 flex items-center justify-between">
                        <span className="text-[10px] text-slate-400">Enter to save · Esc to cancel</span>
                        <button onClick={handleQuickAddSubmit} disabled={!quickAddName.trim()} className="hui-btn hui-btn-primary text-xs px-3 py-1 disabled:opacity-50">Add</button>
                    </div>
                </div>
            )}

            {/* Quick-edit popover */}
            {editing && editingTask && (
                <QuickEditPopover
                    task={editingTask}
                    x={editing.x}
                    y={editing.y}
                    onPatch={(patch) => patchTask(editingTask.id, patch)}
                    onDelete={() => removeTask(editingTask.id)}
                    onClose={() => setEditing(null)}
                />
            )}

            {isPending && (
                <div className="fixed bottom-4 right-4 bg-slate-900 text-white text-xs px-3 py-1.5 rounded-md shadow-lg z-50">Saving…</div>
            )}
        </div>
    );
}

function clamp(v: number, min: number, max: number) { return Math.min(Math.max(v, min), Math.max(min, max)); }

/* ---------------- shared grid pieces ---------------- */

type GridProps = {
    today: Date;
    tasks: Task[];
    dragTaskId: string | null;
    dropPreview: { start: Date; end: Date } | null;
    onCellClick: (d: Date, e: React.MouseEvent) => void;
    onTaskClick: (t: Task, e: React.MouseEvent) => void;
    onBarDragStart: (t: Task, grabbedDay: Date, e: React.DragEvent) => void;
    onHandleDragStart: (t: Task, e: React.DragEvent) => void;
    onDragEnd: () => void;
    onRowDragOver: (weekStart: Date, e: React.DragEvent) => void;
    onRowDragLeave: (e: React.DragEvent) => void;
    onRowDrop: (weekStart: Date, e: React.DragEvent) => void;
};

function inPreview(day: Date, preview: { start: Date; end: Date } | null) {
    return !!preview && day.getTime() >= preview.start.getTime() && day.getTime() <= preview.end.getTime();
}

function shortDate(yyyyMmDd: string) {
    const [, m, d] = yyyyMmDd.split("-");
    return `${Number(m)}/${Number(d)}`;
}

function barTitle(t: Task) {
    return t.startDate === t.endDate ? `${t.name} (${shortDate(t.startDate)})` : `${t.name} (${shortDate(t.startDate)} to ${shortDate(t.endDate)})`;
}

/**
 * A task bar inside one week row. Placed on a CSS grid overlay so it can span
 * several day columns; the overlay itself ignores pointer events so clicks on
 * empty space still reach the day cell underneath.
 */
function TaskBar({
    segment, weekStart, dense, dragTaskId, onTaskClick, onBarDragStart, onHandleDragStart, onDragEnd,
}: {
    segment: Segment;
    weekStart: Date;
    dense: boolean;
    dragTaskId: string | null;
    onTaskClick: GridProps["onTaskClick"];
    onBarDragStart: GridProps["onBarDragStart"];
    onHandleDragStart: GridProps["onHandleDragStart"];
    onDragEnd: () => void;
}) {
    const { task: t, startCol, spanDays, lane, startsHere, endsHere } = segment;
    const isMilestone = t.type === "milestone";
    const isDragging = dragTaskId === t.id;
    const rounded = `${startsHere ? "rounded-l-md" : "rounded-l-none"} ${endsHere ? "rounded-r-md" : "rounded-r-none"}`;
    return (
        <div
            className="pointer-events-auto relative min-w-0"
            style={{ gridColumn: `${startCol + 1} / span ${spanDays}`, gridRow: lane + 1 }}
        >
            <button
                type="button"
                draggable
                title={barTitle(t)}
                onDragStart={e => {
                    // Which day of the bar was grabbed, so a drop keeps that day under the pointer.
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
                    const col = startCol + Math.min(spanDays - 1, Math.max(0, Math.floor(ratio * spanDays)));
                    onBarDragStart(t, addDays(weekStart, col), e);
                }}
                onDragEnd={onDragEnd}
                onClick={e => onTaskClick(t, e)}
                className={`w-full h-full text-left overflow-hidden transition cursor-grab active:cursor-grabbing hover:brightness-95 ${rounded} ${dense ? "px-1.5 text-[11px] leading-[22px]" : "px-2 py-1 text-xs shadow-sm border border-black/5"} ${isDragging ? "opacity-40" : ""}`}
                style={{
                    backgroundColor: hexWithAlpha(t.color, 0.18),
                    borderLeft: startsHere ? `3px solid ${t.color || "#4c9a2a"}` : undefined,
                    paddingRight: endsHere && !isMilestone ? 14 : undefined,
                }}
            >
                <span className="block truncate font-medium text-slate-800">
                    {!startsHere && <span className="text-slate-400 mr-1">&lsaquo;</span>}
                    {isMilestone && <span className="mr-1">&#9670;</span>}
                    {t.name}
                </span>
                {!dense && (
                    <span className="mt-0.5 flex items-center gap-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_COLORS[t.status] ?? "bg-slate-100 text-slate-600"}`}>{t.status}</span>
                        {t.startDate !== t.endDate && <span className="text-[9px] text-slate-500">{shortDate(t.startDate)} to {shortDate(t.endDate)}</span>}
                    </span>
                )}
            </button>
            {endsHere && !isMilestone && (
                <div
                    draggable
                    role="separator"
                    aria-label={`Drag to change end date of ${t.name}`}
                    title="Drag to change end date"
                    onDragStart={e => onHandleDragStart(t, e)}
                    onDragEnd={onDragEnd}
                    onClick={e => e.stopPropagation()}
                    className="absolute top-0 right-0 h-full w-3.5 cursor-ew-resize flex items-center justify-center group"
                >
                    <span className="h-3/5 w-[3px] rounded-full bg-slate-400/40 group-hover:bg-slate-600/70 transition" />
                </div>
            )}
        </div>
    );
}

/* ---------------- Week grid ---------------- */

const WEEK_LANE_PX = 46;
const WEEK_LANE_GAP_PX = 4;

function WeekGrid({
    anchor, today, tasks, dragTaskId, dropPreview, onCellClick, onTaskClick,
    onBarDragStart, onHandleDragStart, onDragEnd, onRowDragOver, onRowDragLeave, onRowDrop,
}: GridProps & { anchor: Date }) {
    const days = useMemo(() => getWeekDays(anchor), [anchor]);
    const weekStart = days[0];
    // Week view never hides tasks: every lane renders and the row grows to fit them.
    const { segments } = useMemo(() => buildWeekSegments(tasks, weekStart, Number.POSITIVE_INFINITY), [tasks, weekStart]);
    const laneCount = segments.reduce((m, s) => Math.max(m, s.lane + 1), 0);
    const rowMinHeight = Math.max(420, 16 + laneCount * (WEEK_LANE_PX + WEEK_LANE_GAP_PX) + 24);
    return (
        <div className="flex flex-col min-h-full">
            <div className="grid grid-cols-7 bg-white/95 backdrop-blur border-b border-hui-border sticky top-0 z-10">
                {days.map((day, idx) => {
                    const isToday = isSameUTCDay(day, today);
                    return (
                        <div key={idx} className={`px-3 py-2 border-r last:border-r-0 border-hui-border ${isToday ? "text-indigo-700" : "text-hui-textMain"}`}>
                            <div className={`text-[10px] font-semibold uppercase tracking-wide ${isToday ? "text-indigo-600" : "text-slate-400"}`}>{WEEKDAY_LABELS[idx]}</div>
                            <div className="flex items-baseline gap-1">
                                <span className={`text-2xl font-bold leading-none ${isToday ? "text-indigo-700" : "text-hui-textMain"}`}>{day.getUTCDate()}</span>
                                <span className="text-[10px] text-slate-400">{MONTH_LABELS[day.getUTCMonth()].slice(0, 3)}</span>
                            </div>
                        </div>
                    );
                })}
            </div>
            <div
                className="relative grid grid-cols-7 flex-1"
                style={{ minHeight: rowMinHeight }}
                onDragOver={e => onRowDragOver(weekStart, e)}
                onDragLeave={onRowDragLeave}
                onDrop={e => onRowDrop(weekStart, e)}
            >
                {days.map((day, idx) => {
                    const isToday = isSameUTCDay(day, today);
                    const weekend = isWeekend(day);
                    const previewing = inPreview(day, dropPreview);
                    return (
                        <div
                            key={idx}
                            onClick={e => onCellClick(day, e)}
                            className={`border-r last:border-r-0 border-hui-border cursor-pointer ${weekend ? "bg-slate-50/60" : "bg-white"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""} ${previewing ? "bg-indigo-50 ring-2 ring-inset ring-indigo-400" : ""}`}
                        >
                            {laneCount === 0 && idx === 0 && !dropPreview && (
                                <div className="p-3 text-[10px] text-slate-300 italic select-none">Click a day to add a task</div>
                            )}
                        </div>
                    );
                })}
                <div
                    className="absolute inset-x-0 top-2 grid grid-cols-7 px-1 pointer-events-none"
                    style={{ gridAutoRows: `${WEEK_LANE_PX}px`, rowGap: WEEK_LANE_GAP_PX }}
                >
                    {segments.map(seg => (
                        <TaskBar
                            key={seg.task.id}
                            segment={seg}
                            weekStart={weekStart}
                            dense={false}
                            dragTaskId={dragTaskId}
                            onTaskClick={onTaskClick}
                            onBarDragStart={onBarDragStart}
                            onHandleDragStart={onHandleDragStart}
                            onDragEnd={onDragEnd}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

/* ---------------- Month grid ---------------- */

const MONTH_MAX_LANES = 4;
const MONTH_LANE_PX = 22;

function MonthGrid({
    anchor, today, tasks, dragTaskId, dropPreview, onCellClick, onTaskClick, onSwitchToWeek,
    onBarDragStart, onHandleDragStart, onDragEnd, onRowDragOver, onRowDragLeave, onRowDrop,
}: GridProps & { anchor: Date; onSwitchToWeek: (d: Date) => void }) {
    const currentMonth = anchor.getUTCMonth();
    const weeks = useMemo(() => {
        const days = getMonthGrid(anchor);
        return Array.from({ length: 6 }, (_, w) => {
            const weekDays = days.slice(w * 7, w * 7 + 7);
            return { weekDays, ...buildWeekSegments(tasks, weekDays[0], MONTH_MAX_LANES) };
        });
    }, [anchor, tasks]);
    return (
        <div className="flex flex-col h-full">
            <div className="grid grid-cols-7 bg-white border-b border-hui-border sticky top-0 z-10">
                {WEEKDAY_LABELS.map((w, i) => (
                    <div key={i} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{w}</div>
                ))}
            </div>
            {/* Row height = day number strip (28px) + 4 lanes + the "+N more" footer, so the footer never sits under a bar. */}
            <div className="grid grid-rows-6 flex-1 min-h-[900px]">
                {weeks.map(({ weekDays, segments, hiddenByDay }, w) => {
                    const weekStart = weekDays[0];
                    return (
                        <div
                            key={w}
                            className="relative grid grid-cols-7 border-b border-hui-border last:border-b-0 min-h-[150px]"
                            onDragOver={e => onRowDragOver(weekStart, e)}
                            onDragLeave={onRowDragLeave}
                            onDrop={e => onRowDrop(weekStart, e)}
                        >
                            {weekDays.map((day, idx) => {
                                const isToday = isSameUTCDay(day, today);
                                const weekend = isWeekend(day);
                                const isCurrentMonth = day.getUTCMonth() === currentMonth;
                                const previewing = inPreview(day, dropPreview);
                                const hidden = hiddenByDay[idx];
                                return (
                                    <div
                                        key={idx}
                                        onClick={e => onCellClick(day, e)}
                                        className={`relative border-r last:border-r-0 border-hui-border p-1.5 cursor-pointer ${isCurrentMonth ? (weekend ? "bg-slate-50/60" : "bg-white") : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""} ${previewing ? "bg-indigo-50 ring-2 ring-inset ring-indigo-400" : ""}`}
                                    >
                                        <span className={`text-xs font-semibold ${isToday ? "inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white" : isCurrentMonth ? "text-hui-textMain" : "text-slate-400"}`}>
                                            {day.getUTCDate()}
                                        </span>
                                        {hidden > 0 && (
                                            <button
                                                type="button"
                                                onClick={e => { e.stopPropagation(); onSwitchToWeek(day); }}
                                                className="absolute bottom-1 left-1.5 text-[10px] text-indigo-600 hover:underline"
                                            >+{hidden} more</button>
                                        )}
                                    </div>
                                );
                            })}
                            <div
                                className="absolute inset-x-0 top-7 grid grid-cols-7 gap-y-0.5 px-0.5 pointer-events-none"
                                style={{ gridAutoRows: `${MONTH_LANE_PX}px` }}
                            >
                                {segments.map(seg => (
                                    <TaskBar
                                        key={seg.task.id}
                                        segment={seg}
                                        weekStart={weekStart}
                                        dense
                                        dragTaskId={dragTaskId}
                                        onTaskClick={onTaskClick}
                                        onBarDragStart={onBarDragStart}
                                        onHandleDragStart={onHandleDragStart}
                                        onDragEnd={onDragEnd}
                                    />
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/* ---------------- Quick-edit popover ---------------- */

function QuickEditPopover({
    task, x, y, onPatch, onDelete, onClose,
}: {
    task: Task;
    x: number; y: number;
    onPatch: (patch: Partial<Pick<Task, "name" | "status" | "color" | "startDate" | "endDate">>) => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    const [nameDraft, setNameDraft] = useState(task.name);
    useEffect(() => { setNameDraft(task.name); }, [task.id, task.name]);

    const [showColorPicker, setShowColorPicker] = useState(false);
    const colorAnchorRef = useRef<HTMLButtonElement | null>(null);
    const [punchItems, setPunchItems] = useState<PunchItem[]>([]);
    const [punchLoading, setPunchLoading] = useState(true);
    const [newPunch, setNewPunch] = useState("");

    useEffect(() => {
        let cancelled = false;
        setPunchItems([]);
        setNewPunch("");
        setPunchLoading(true);
        getTaskPunchItems(task.id)
            .then(items => { if (!cancelled) { setPunchItems(items as PunchItem[]); setPunchLoading(false); } })
            .catch(() => { if (!cancelled) setPunchLoading(false); });
        return () => { cancelled = true; };
    }, [task.id]);

    async function handleAddPunch() {
        const name = newPunch.trim();
        if (!name) return;
        const tempId = `temp-${Date.now()}`;
        const optimistic: PunchItem = { id: tempId, name, completed: false, order: punchItems.length };
        setPunchItems(prev => [...prev, optimistic]);
        setNewPunch("");
        try {
            const created = await addTaskPunchItem(task.id, name);
            setPunchItems(prev => prev.map(p => p.id === tempId ? (created as PunchItem) : p));
        } catch {
            setPunchItems(prev => prev.filter(p => p.id !== tempId));
            toast.error("Failed to add item");
        }
    }

    async function handleTogglePunch(id: string) {
        if (id.startsWith("temp-")) return;
        setPunchItems(prev => prev.map(p => p.id === id ? { ...p, completed: !p.completed } : p));
        try {
            await togglePunchItem(id);
        } catch {
            setPunchItems(prev => prev.map(p => p.id === id ? { ...p, completed: !p.completed } : p));
            toast.error("Failed to update item");
        }
    }

    async function handleDeletePunch(id: string) {
        if (id.startsWith("temp-")) return;
        const removed = punchItems.find(p => p.id === id);
        setPunchItems(prev => prev.filter(p => p.id !== id));
        try {
            await deletePunchItem(id);
        } catch {
            if (removed) setPunchItems(prev => [...prev, removed].sort((a, b) => a.order - b.order));
            toast.error("Failed to delete item");
        }
    }

    const left = clamp(x - 160, 8, typeof window !== "undefined" ? window.innerWidth - 328 : 0);
    const top = clamp(y, 8, typeof window !== "undefined" ? window.innerHeight - 480 : 0);

    return (
        <div
            className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-2xl p-3 w-80 animate-in fade-in"
            style={{ left, top }}
            onClick={e => e.stopPropagation()}
        >
            <div className="flex items-start justify-between gap-2 mb-2">
                <input
                    value={nameDraft}
                    onChange={e => setNameDraft(e.target.value)}
                    onBlur={() => { const v = nameDraft.trim(); if (v && v !== task.name) onPatch({ name: v }); else setNameDraft(task.name); }}
                    onKeyDown={e => {
                        if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
                        if (e.key === "Escape") { setNameDraft(task.name); onClose(); }
                    }}
                    className="flex-1 text-sm font-semibold bg-transparent border-b border-transparent focus:border-indigo-400 outline-none px-0 py-1"
                />
                <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1" aria-label="Close">×</button>
            </div>

            <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                    <label className="text-slate-500 w-16">Status</label>
                    <select
                        value={task.status}
                        onChange={e => onPatch({ status: e.target.value })}
                        className="flex-1 hui-input text-xs py-1"
                    >
                        {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-slate-500 w-16">Start</label>
                    <input
                        type="date"
                        value={task.startDate}
                        onChange={e => {
                            const v = e.target.value;
                            if (!v) return;
                            const patch: any = { startDate: v };
                            if (v > task.endDate) patch.endDate = v;
                            onPatch(patch);
                        }}
                        className="flex-1 hui-input text-xs py-1"
                    />
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-slate-500 w-16">End</label>
                    <input
                        type="date"
                        value={task.endDate}
                        min={task.startDate}
                        onChange={e => { const v = e.target.value; if (!v) return; onPatch({ endDate: v }); }}
                        className="flex-1 hui-input text-xs py-1"
                    />
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-slate-500 w-16">Color</label>
                    <div className="relative">
                        <button
                            type="button"
                            ref={colorAnchorRef}
                            onClick={() => setShowColorPicker(v => !v)}
                            className={`w-5 h-5 rounded-full border border-white shadow-sm ring-1 ${task.color?.toLowerCase() === "#ffffff" ? "ring-slate-400" : "ring-slate-200"} hover:scale-110 transition`}
                            style={{ backgroundColor: task.color }}
                            aria-label="Change color"
                        />
                        {showColorPicker && (
                            <ColorPicker
                                selected={task.color}
                                onPick={c => onPatch({ color: c })}
                                onClose={() => setShowColorPicker(false)}
                                anchorRef={colorAnchorRef}
                                align="left"
                            />
                        )}
                    </div>
                </div>
            </div>

            <div className="mt-3 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Punch list</span>
                    {punchItems.length > 0 && (
                        <span className="text-[10px] text-slate-400">
                            {punchItems.filter(p => p.completed).length} / {punchItems.length} done
                        </span>
                    )}
                </div>
                <div className="max-h-32 overflow-y-auto -mx-1 px-1">
                    {punchLoading && punchItems.length === 0 ? (
                        <div className="text-[11px] text-slate-400 italic py-1">Loading…</div>
                    ) : punchItems.length === 0 ? (
                        <div className="text-[11px] text-slate-400 italic py-1">No items yet</div>
                    ) : (
                        <ul className="space-y-0.5">
                            {punchItems.map(item => {
                                const isTemp = item.id.startsWith("temp-");
                                return (
                                    <li key={item.id} className={`group flex items-center gap-2 py-0.5 ${isTemp ? "opacity-60" : ""}`}>
                                        <input
                                            type="checkbox"
                                            checked={item.completed}
                                            onChange={() => handleTogglePunch(item.id)}
                                            disabled={isTemp}
                                            className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-400 disabled:cursor-wait"
                                        />
                                        <span className={`flex-1 text-xs ${item.completed ? "line-through text-slate-400" : "text-slate-700"}`}>
                                            {item.name}
                                        </span>
                                        <button
                                            onClick={() => handleDeletePunch(item.id)}
                                            disabled={isTemp}
                                            aria-label="Delete item"
                                            className="text-slate-400 hover:text-red-600 text-xs leading-none px-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition disabled:cursor-wait"
                                        >×</button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
                <div className="mt-1.5 flex items-center gap-1">
                    <input
                        value={newPunch}
                        onChange={e => setNewPunch(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddPunch(); } }}
                        placeholder="Add item…"
                        className="flex-1 hui-input text-xs py-1"
                    />
                    <button
                        onClick={handleAddPunch}
                        disabled={!newPunch.trim()}
                        className="text-xs px-2 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >Add</button>
                </div>
            </div>

            <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between">
                <button onClick={onDelete} className="text-xs text-red-600 hover:text-red-700">Delete</button>
                <span className="text-[10px] text-slate-400">For dependencies and comments, switch to Gantt or Table</span>
            </div>
        </div>
    );
}

/* ---------------- helpers ---------------- */

function hexWithAlpha(hex: string, alpha: number): string {
    if (!hex) return `rgba(76, 154, 42, ${alpha})`;
    const m = hex.replace("#", "");
    if (m.length !== 6) return hex;
    const r = parseInt(m.slice(0, 2), 16);
    const g = parseInt(m.slice(2, 4), 16);
    const b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
