"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Task } from "./schedule-types";
import {
    STATUS_OPTIONS,
    STATUS_COLORS,
    PRESET_COLORS,
    addDays,
    formatDate,
    getMonday,
    isWeekend,
    getWeekDays,
    getMonthGrid,
    isSameUTCDay,
    parseUTCDate,
    todayUTC,
} from "./schedule-utils";
import { createScheduleTask, updateScheduleTask, deleteScheduleTask } from "@/lib/actions";

type ViewMode = "gantt" | "table" | "calendar";
type SubMode = "month" | "week";

type Props = {
    projectId: string;
    tasks: Task[];
    setTasks: Dispatch<SetStateAction<Task[]>>;
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

export default function CalendarView({ projectId, tasks, setTasks, viewMode, onViewModeChange, subMode, onSubModeChange }: Props) {
    const router = useRouter();

    const [anchor, setAnchor] = useState<Date>(() => todayUTC());
    const [isPending, startTransition] = useTransition();

    const [quickAdd, setQuickAdd] = useState<{ date: Date; x: number; y: number } | null>(null);
    const [quickAddName, setQuickAddName] = useState("");
    const quickAddInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (quickAdd && quickAddInputRef.current) quickAddInputRef.current.focus(); }, [quickAdd]);

    const [editing, setEditing] = useState<{ taskId: string; x: number; y: number } | null>(null);
    const editingTask = useMemo(() => editing ? tasks.find(t => t.id === editing.taskId) ?? null : null, [editing, tasks]);

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

    return (
        <div className="flex flex-col h-full bg-hui-background" onClick={() => { setQuickAdd(null); setEditing(null); }}>
            {/* Top toolbar with view toggle + calendar header */}
            <div className="bg-white border-b border-hui-border shrink-0 z-20 relative">
                <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
                <div className="px-6 py-3 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                        <h1 className="text-lg font-bold text-hui-textMain">Schedule</h1>
                        <span className="text-xs text-hui-textMuted">{tasks.length} tasks</span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={navPrev} className="px-2 py-1.5 text-slate-600 hover:bg-slate-100 rounded-md transition" aria-label="Previous">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                        </button>
                        <button onClick={navToday} className="px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md transition border border-slate-200">Today</button>
                        <button onClick={navNext} className="px-2 py-1.5 text-slate-600 hover:bg-slate-100 rounded-md transition" aria-label="Next">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                        <span className="text-sm font-semibold text-hui-textMain px-2 min-w-[140px] text-center">{formatHeader(anchor)}</span>
                        {/* Sub-mode pill */}
                        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                            <button onClick={() => onSubModeChange("month")} className={`px-3 py-1 text-xs font-medium rounded-md transition ${subMode === "month" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Month</button>
                            <button onClick={() => onSubModeChange("week")} className={`px-3 py-1 text-xs font-medium rounded-md transition ${subMode === "week" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Week</button>
                        </div>
                        {/* View toggle */}
                        {onViewModeChange && (
                            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                                <button onClick={() => onViewModeChange("gantt")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "gantt" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="6" y="10" width="12" height="4" rx="1"/><rect x="3" y="16" width="15" height="4" rx="1"/></svg>Gantt
                                </button>
                                <button onClick={() => onViewModeChange("table")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "table" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><path d="M3 6h18M3 12h18M3 18h18"/><path d="M9 6v12"/></svg>Table
                                </button>
                                <button onClick={() => onViewModeChange("calendar")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "calendar" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Calendar
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-auto">
                {subMode === "week" ? (
                    <WeekGrid
                        anchor={anchor}
                        today={today}
                        tasksForDay={tasksForDay}
                        onCellClick={handleCellClick}
                        onTaskClick={handleTaskClick}
                    />
                ) : (
                    <MonthGrid
                        anchor={anchor}
                        today={today}
                        tasksForDay={tasksForDay}
                        onCellClick={handleCellClick}
                        onTaskClick={handleTaskClick}
                        onSwitchToWeek={(d) => { setAnchor(d); onSubModeChange("week"); }}
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
}: {
    anchor: Date;
    today: Date;
    tasksForDay: (d: Date) => Task[];
    onCellClick: (d: Date, e: React.MouseEvent) => void;
    onTaskClick: (t: Task, e: React.MouseEvent) => void;
}) {
    const days = getWeekDays(anchor);
    return (
        <div className="grid grid-cols-7 min-h-full">
            {days.map((day, idx) => {
                const isToday = isSameUTCDay(day, today);
                const weekend = isWeekend(day);
                const dayTasks = tasksForDay(day);
                return (
                    <div
                        key={idx}
                        className={`flex flex-col border-r last:border-r-0 border-hui-border ${weekend ? "bg-slate-50/60" : "bg-white"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""}`}
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
                        >
                            <div className="flex flex-col gap-1.5">
                                {dayTasks.map(t => (
                                    <button
                                        key={t.id}
                                        onClick={e => onTaskClick(t, e)}
                                        className="text-left px-2 py-1.5 rounded-md text-xs font-medium shadow-sm hover:shadow transition border border-black/5"
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
                                    <div className="text-[10px] text-slate-300 italic select-none">Click to add</div>
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
}: {
    anchor: Date;
    today: Date;
    tasksForDay: (d: Date) => Task[];
    onCellClick: (d: Date, e: React.MouseEvent) => void;
    onTaskClick: (t: Task, e: React.MouseEvent) => void;
    onSwitchToWeek: (d: Date) => void;
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
                    return (
                        <div
                            key={idx}
                            onClick={e => onCellClick(day, e)}
                            className={`relative border-r border-b border-hui-border last:border-r-0 p-1.5 cursor-pointer min-h-[110px] ${isCurrentMonth ? (weekend ? "bg-slate-50/60" : "bg-white") : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""}`}
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
                                        onClick={e => onTaskClick(t, e)}
                                        className="text-left text-[11px] px-1.5 py-0.5 rounded truncate hover:opacity-90 transition"
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

    const left = clamp(x - 160, 8, typeof window !== "undefined" ? window.innerWidth - 328 : 0);
    const top = clamp(y, 8, typeof window !== "undefined" ? window.innerHeight - 320 : 0);

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

            <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between">
                <button onClick={onDelete} className="text-xs text-red-600 hover:text-red-700">Delete</button>
                <span className="text-[10px] text-slate-400">For dependencies, comments, punch list — switch to Gantt or Table</span>
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
