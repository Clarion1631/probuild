"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Task, PunchItem, EstimateSummary } from "./schedule-types";
import ScheduleToolbar from "./ScheduleToolbar";
import {
    STATUS_OPTIONS,
    STATUS_COLORS,
    PRESET_COLORS,
    addDays,
    formatDate,
    getDaysBetween,
    getMonday,
    isWeekend,
    getWeekDays,
    getMonthGrid,
    isSameUTCDay,
    parseUTCDate,
    todayUTC,
} from "./schedule-utils";
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

function dayBucket(task: Task, day: Date): boolean {
    const start = parseUTCDate(task.startDate);
    const end = parseUTCDate(task.endDate);
    return day.getTime() >= start.getTime() && day.getTime() <= end.getTime();
}

export default function CalendarView({ projectId, tasks, setTasks, estimates = [], initialPublished, viewMode, onViewModeChange, subMode, onSubModeChange }: Props) {
    const router = useRouter();

    const [anchor, setAnchor] = useState<Date>(() => todayUTC());
    const [isPending, startTransition] = useTransition();

    const [quickAdd, setQuickAdd] = useState<{ date: Date; x: number; y: number } | null>(null);
    const [quickAddName, setQuickAddName] = useState("");
    const quickAddInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (quickAdd && quickAddInputRef.current) quickAddInputRef.current.focus(); }, [quickAdd]);

    const [editing, setEditing] = useState<{ taskId: string; x: number; y: number } | null>(null);
    const editingTask = useMemo(() => editing ? tasks.find(t => t.id === editing.taskId) ?? null : null, [editing, tasks]);

    const [dragTaskId, setDragTaskId] = useState<string | null>(null);
    const [dragOverKey, setDragOverKey] = useState<string | null>(null);

    const today = todayUTC();

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
        if (!name || !target) { setQuickAdd(null); setQuickAddName(""); return; }
        const dateStr = formatDate(target);
        try {
            await createScheduleTask(projectId, {
                name,
                startDate: dateStr,
                endDate: dateStr,
                color: PRESET_COLORS[0],
                status: "Not Started",
            });
            setQuickAdd(null);
            setQuickAddName("");
            toast.success("Task added");
            startTransition(() => router.refresh());
        } catch {
            toast.error("Failed to add task");
        }
    }

    function handleCellClick(day: Date, e: React.MouseEvent) {
        e.stopPropagation();
        if (editing) { setEditing(null); return; }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setQuickAdd({ date: day, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        setQuickAddName("");
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
            toast.error("Failed to save");
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

    const tasksForDay = (day: Date) => tasks.filter(t => dayBucket(t, day));

    function handleTaskDragStart(task: Task, e: React.DragEvent) {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        setDragTaskId(task.id);
        setQuickAdd(null);
        setEditing(null);
    }
    function handleTaskDragEnd() {
        setDragTaskId(null);
        setDragOverKey(null);
    }
    function handleDayDragOver(day: Date, e: React.DragEvent) {
        if (!dragTaskId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const k = formatDate(day);
        if (k !== dragOverKey) setDragOverKey(k);
    }
    function handleDayDragLeave(day: Date) {
        const k = formatDate(day);
        setDragOverKey(prev => prev === k ? null : prev);
    }
    function handleDayDrop(day: Date, e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        const taskId = e.dataTransfer.getData("text/plain") || dragTaskId;
        setDragTaskId(null);
        setDragOverKey(null);
        if (!taskId) return;
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        const oldStart = parseUTCDate(task.startDate);
        if (isSameUTCDay(oldStart, day)) return;
        const duration = Math.max(0, getDaysBetween(oldStart, parseUTCDate(task.endDate)));
        const newStart = day;
        const newEnd = addDays(day, duration);
        patchTask(task.id, { startDate: formatDate(newStart), endDate: formatDate(newEnd) });
    }

    return (
        <div className="flex flex-col h-full bg-hui-background" onClick={() => { setQuickAdd(null); setEditing(null); }}>
            <ScheduleToolbar
                projectId={projectId}
                tasks={tasks}
                setTasks={setTasks}
                estimates={estimates}
                initialPublished={initialPublished}
                viewMode={viewMode ?? "calendar"}
                onViewModeChange={onViewModeChange ?? (() => {})}
                showCriticalPath={false}
                onToggleCriticalPath={() => {}}
                linkMode={null}
                onToggleLinkMode={() => {}}
                viewControls={
                    <>
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
                    </>
                }
            />

            <div className="flex-1 overflow-auto">
                {subMode === "week" ? (
                    <WeekGrid
                        anchor={anchor}
                        today={today}
                        tasksForDay={tasksForDay}
                        onCellClick={handleCellClick}
                        onTaskClick={handleTaskClick}
                        onTaskDragStart={handleTaskDragStart}
                        onTaskDragEnd={handleTaskDragEnd}
                        onDayDragOver={handleDayDragOver}
                        onDayDragLeave={handleDayDragLeave}
                        onDayDrop={handleDayDrop}
                        dragTaskId={dragTaskId}
                        dragOverKey={dragOverKey}
                    />
                ) : (
                    <MonthGrid
                        anchor={anchor}
                        today={today}
                        tasksForDay={tasksForDay}
                        onCellClick={handleCellClick}
                        onTaskClick={handleTaskClick}
                        onSwitchToWeek={(d) => { setAnchor(d); onSubModeChange("week"); }}
                        onTaskDragStart={handleTaskDragStart}
                        onTaskDragEnd={handleTaskDragEnd}
                        onDayDragOver={handleDayDragOver}
                        onDayDragLeave={handleDayDragLeave}
                        onDayDrop={handleDayDrop}
                        dragTaskId={dragTaskId}
                        dragOverKey={dragOverKey}
                    />
                )}
            </div>

            {/* Quick-add popover */}
            {quickAdd && (
                <div
                    className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-2xl p-3 w-72 animate-in fade-in"
                    style={{ left: clamp(quickAdd.x - 144, 8, typeof window !== "undefined" ? window.innerWidth - 296 : 0), top: clamp(quickAdd.y, 8, typeof window !== "undefined" ? window.innerHeight - 140 : 0) }}
                    onClick={e => e.stopPropagation()}
                >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">New task</div>
                    <div className="text-xs text-hui-textMain mb-2">{formatDayLabel(quickAdd.date)}</div>
                    <input
                        ref={quickAddInputRef}
                        value={quickAddName}
                        onChange={e => setQuickAddName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter") { e.preventDefault(); handleQuickAddSubmit(); }
                            if (e.key === "Escape") { e.preventDefault(); setQuickAdd(null); setQuickAddName(""); }
                        }}
                        placeholder="Task name"
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

/* ---------------- Week grid ---------------- */

function WeekGrid({
    anchor, today, tasksForDay, onCellClick, onTaskClick,
    onTaskDragStart, onTaskDragEnd, onDayDragOver, onDayDragLeave, onDayDrop,
    dragTaskId, dragOverKey,
}: {
    anchor: Date;
    today: Date;
    tasksForDay: (d: Date) => Task[];
    onCellClick: (d: Date, e: React.MouseEvent) => void;
    onTaskClick: (t: Task, e: React.MouseEvent) => void;
    onTaskDragStart: (t: Task, e: React.DragEvent) => void;
    onTaskDragEnd: () => void;
    onDayDragOver: (d: Date, e: React.DragEvent) => void;
    onDayDragLeave: (d: Date) => void;
    onDayDrop: (d: Date, e: React.DragEvent) => void;
    dragTaskId: string | null;
    dragOverKey: string | null;
}) {
    const days = getWeekDays(anchor);
    return (
        <div className="grid grid-cols-7 min-h-full">
            {days.map((day, idx) => {
                const isToday = isSameUTCDay(day, today);
                const weekend = isWeekend(day);
                const dayTasks = tasksForDay(day);
                const dayKey = formatDate(day);
                const isDropTarget = dragOverKey === dayKey;
                return (
                    <div
                        key={idx}
                        className={`flex flex-col border-r last:border-r-0 border-hui-border ${weekend ? "bg-slate-50/60" : "bg-white"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""} ${isDropTarget ? "ring-2 ring-inset ring-indigo-500 bg-indigo-50/40" : ""}`}
                    >
                        <div className={`sticky top-0 px-3 py-2 border-b border-hui-border bg-white/95 backdrop-blur z-10 ${isToday ? "text-indigo-700" : "text-hui-textMain"}`}>
                            <div className={`text-[10px] font-semibold uppercase tracking-wide ${isToday ? "text-indigo-600" : "text-slate-400"}`}>{WEEKDAY_LABELS[idx]}</div>
                            <div className="flex items-baseline gap-1">
                                <span className={`text-2xl font-bold leading-none ${isToday ? "text-indigo-700" : "text-hui-textMain"}`}>{day.getUTCDate()}</span>
                                <span className="text-[10px] text-slate-400">{MONTH_LABELS[day.getUTCMonth()].slice(0, 3)}</span>
                            </div>
                        </div>
                        <div
                            className="flex-1 min-h-[420px] p-2 cursor-pointer"
                            onClick={e => onCellClick(day, e)}
                            onDragOver={e => onDayDragOver(day, e)}
                            onDragLeave={() => onDayDragLeave(day)}
                            onDrop={e => onDayDrop(day, e)}
                        >
                            <div className="flex flex-col gap-1.5">
                                {dayTasks.map(t => (
                                    <button
                                        key={t.id}
                                        draggable
                                        onDragStart={e => onTaskDragStart(t, e)}
                                        onDragEnd={onTaskDragEnd}
                                        onClick={e => onTaskClick(t, e)}
                                        className={`text-left px-2 py-1.5 rounded-md text-xs font-medium shadow-sm hover:shadow transition border border-black/5 cursor-grab active:cursor-grabbing ${dragTaskId === t.id ? "opacity-40" : ""}`}
                                        style={{ backgroundColor: hexWithAlpha(t.color, 0.15), color: t.color, borderLeftColor: t.color, borderLeftWidth: 3 }}
                                    >
                                        <div className="truncate text-slate-800">{t.name}</div>
                                        <div className="flex items-center gap-1 mt-0.5">
                                            <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_COLORS[t.status] ?? "bg-slate-100 text-slate-600"}`}>{t.status}</span>
                                            {t.startDate !== t.endDate && <span className="text-[9px] text-slate-500">multi-day</span>}
                                        </div>
                                    </button>
                                ))}
                                {dayTasks.length === 0 && (
                                    <div className="text-[10px] text-slate-300 italic select-none">{isDropTarget ? "Drop to move here" : "Click to add"}</div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/* ---------------- Month grid ---------------- */

function MonthGrid({
    anchor, today, tasksForDay, onCellClick, onTaskClick, onSwitchToWeek,
    onTaskDragStart, onTaskDragEnd, onDayDragOver, onDayDragLeave, onDayDrop,
    dragTaskId, dragOverKey,
}: {
    anchor: Date;
    today: Date;
    tasksForDay: (d: Date) => Task[];
    onCellClick: (d: Date, e: React.MouseEvent) => void;
    onTaskClick: (t: Task, e: React.MouseEvent) => void;
    onSwitchToWeek: (d: Date) => void;
    onTaskDragStart: (t: Task, e: React.DragEvent) => void;
    onTaskDragEnd: () => void;
    onDayDragOver: (d: Date, e: React.DragEvent) => void;
    onDayDragLeave: (d: Date) => void;
    onDayDrop: (d: Date, e: React.DragEvent) => void;
    dragTaskId: string | null;
    dragOverKey: string | null;
}) {
    const days = getMonthGrid(anchor);
    const currentMonth = anchor.getUTCMonth();
    const MAX_PER_CELL = 3;
    return (
        <div className="flex flex-col h-full">
            <div className="grid grid-cols-7 bg-white border-b border-hui-border sticky top-0 z-10">
                {WEEKDAY_LABELS.map((w, i) => (
                    <div key={i} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{w}</div>
                ))}
            </div>
            <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-[640px]">
                {days.map((day, idx) => {
                    const isToday = isSameUTCDay(day, today);
                    const weekend = isWeekend(day);
                    const isCurrentMonth = day.getUTCMonth() === currentMonth;
                    const dayTasks = tasksForDay(day);
                    const visible = dayTasks.slice(0, MAX_PER_CELL);
                    const overflow = dayTasks.length - visible.length;
                    const dayKey = formatDate(day);
                    const isDropTarget = dragOverKey === dayKey;
                    return (
                        <div
                            key={idx}
                            onClick={e => onCellClick(day, e)}
                            onDragOver={e => onDayDragOver(day, e)}
                            onDragLeave={() => onDayDragLeave(day)}
                            onDrop={e => onDayDrop(day, e)}
                            className={`relative border-r border-b border-hui-border last:border-r-0 p-1.5 cursor-pointer min-h-[110px] ${isCurrentMonth ? (weekend ? "bg-slate-50/60" : "bg-white") : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""} ${isDropTarget ? "ring-2 ring-inset ring-indigo-500 bg-indigo-50/40" : ""}`}
                        >
                            <div className="flex items-center justify-between">
                                <span className={`text-xs font-semibold ${isToday ? "inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white" : isCurrentMonth ? "text-hui-textMain" : "text-slate-400"}`}>
                                    {day.getUTCDate()}
                                </span>
                            </div>
                            <div className="mt-1 flex flex-col gap-0.5">
                                {visible.map(t => (
                                    <button
                                        key={t.id}
                                        draggable
                                        onDragStart={e => onTaskDragStart(t, e)}
                                        onDragEnd={onTaskDragEnd}
                                        onClick={e => onTaskClick(t, e)}
                                        className={`text-left text-[11px] px-1.5 py-0.5 rounded truncate hover:opacity-90 transition cursor-grab active:cursor-grabbing ${dragTaskId === t.id ? "opacity-40" : ""}`}
                                        style={{ backgroundColor: hexWithAlpha(t.color, 0.15), color: t.color, borderLeft: `3px solid ${t.color}` }}
                                    >
                                        <span className="truncate text-slate-800">{t.name}</span>
                                    </button>
                                ))}
                                {overflow > 0 && (
                                    <button
                                        onClick={e => { e.stopPropagation(); onSwitchToWeek(day); }}
                                        className="text-left text-[10px] text-indigo-600 hover:underline"
                                    >+{overflow} more</button>
                                )}
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
                    <div className="flex items-center gap-1.5">
                        {PRESET_COLORS.map(c => (
                            <button
                                key={c}
                                onClick={() => onPatch({ color: c })}
                                aria-label={`Color ${c}`}
                                className={`w-5 h-5 rounded-full border ${task.color === c ? "ring-2 ring-offset-1 ring-indigo-400 border-white" : "border-slate-200"}`}
                                style={{ backgroundColor: c }}
                            />
                        ))}
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
