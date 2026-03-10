"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createScheduleTask, updateScheduleTask, deleteScheduleTask } from "@/lib/actions";
import { toast } from "sonner";

type Task = {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    assignee: string | null;
    order: number;
};

type ZoomLevel = "day" | "week" | "month";

const STATUS_OPTIONS = ["Not Started", "In Progress", "Complete", "Blocked"];
const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

const PRESET_COLORS = ["#4c9a2a", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4", "#64748b"];

function getDaysBetween(a: Date, b: Date) {
    return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function addDays(date: Date, days: number) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function formatDate(d: Date) {
    return d.toISOString().split("T")[0];
}

function getMonday(d: Date) {
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
}

export default function GanttChart({ projectId, projectName, initialTasks }: {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
}) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [zoom, setZoom] = useState<ZoomLevel>("week");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragState, setDragState] = useState<{
        taskId: string;
        type: "move" | "resize-left" | "resize-right";
        startX: number;
        origStart: Date;
        origEnd: Date;
    } | null>(null);

    // Timeline range: from earliest task start - 14 days to latest end + 14 days
    const allDates = tasks.flatMap(t => [new Date(t.startDate), new Date(t.endDate)]);
    const today = new Date();
    if (allDates.length === 0) {
        allDates.push(addDays(today, -14), addDays(today, 60));
    }
    const minDate = addDays(new Date(Math.min(...allDates.map(d => d.getTime()))), -14);
    const maxDate = addDays(new Date(Math.max(...allDates.map(d => d.getTime()))), 30);
    const totalDays = getDaysBetween(minDate, maxDate);

    const colWidth = zoom === "day" ? 40 : zoom === "week" ? 20 : 8;
    const timelineWidth = totalDays * colWidth;

    // Generate column headers
    function getHeaders() {
        const headers: { label: string; span: number; key: string }[] = [];
        if (zoom === "month") {
            let cursor = new Date(minDate);
            while (cursor < maxDate) {
                const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
                const end = monthEnd > maxDate ? maxDate : monthEnd;
                const days = getDaysBetween(cursor, end) + 1;
                headers.push({
                    label: cursor.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
                    span: days,
                    key: `${cursor.getFullYear()}-${cursor.getMonth()}`,
                });
                cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            }
        } else if (zoom === "week") {
            let cursor = getMonday(new Date(minDate));
            while (cursor < maxDate) {
                const weekEnd = addDays(cursor, 6);
                const end = weekEnd > maxDate ? maxDate : weekEnd;
                const days = getDaysBetween(cursor, end) + 1;
                headers.push({
                    label: `${cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
                    span: Math.min(days, 7),
                    key: formatDate(cursor),
                });
                cursor = addDays(cursor, 7);
            }
        } else {
            let cursor = new Date(minDate);
            while (cursor < maxDate) {
                headers.push({
                    label: cursor.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
                    span: 1,
                    key: formatDate(cursor),
                });
                cursor = addDays(cursor, 1);
            }
        }
        return headers;
    }

    function getBarStyle(task: Task) {
        const start = new Date(task.startDate);
        const end = new Date(task.endDate);
        const offsetDays = getDaysBetween(minDate, start);
        const durationDays = getDaysBetween(start, end) + 1;
        return {
            left: offsetDays * colWidth,
            width: Math.max(durationDays * colWidth, colWidth),
        };
    }

    function getTodayOffset() {
        return getDaysBetween(minDate, today) * colWidth;
    }

    // Scroll to today on mount
    useEffect(() => {
        if (scrollRef.current) {
            const todayX = getTodayOffset();
            scrollRef.current.scrollLeft = Math.max(0, todayX - 300);
        }
    }, []);

    // --- Drag handlers ---
    const handleMouseDown = useCallback((e: React.MouseEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        e.preventDefault();
        e.stopPropagation();
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        setDragState({
            taskId,
            type,
            startX: e.clientX,
            origStart: new Date(task.startDate),
            origEnd: new Date(task.endDate),
        });
    }, [tasks]);

    useEffect(() => {
        if (!dragState) return;

        const handleMouseMove = (e: MouseEvent) => {
            const dx = e.clientX - dragState.startX;
            const daysDelta = Math.round(dx / colWidth);
            if (daysDelta === 0) return;

            setTasks(prev => prev.map(t => {
                if (t.id !== dragState.taskId) return t;
                if (dragState.type === "move") {
                    return {
                        ...t,
                        startDate: formatDate(addDays(dragState.origStart, daysDelta)),
                        endDate: formatDate(addDays(dragState.origEnd, daysDelta)),
                    };
                } else if (dragState.type === "resize-left") {
                    const newStart = addDays(dragState.origStart, daysDelta);
                    if (newStart >= new Date(t.endDate)) return t;
                    return { ...t, startDate: formatDate(newStart) };
                } else {
                    const newEnd = addDays(dragState.origEnd, daysDelta);
                    if (newEnd <= new Date(t.startDate)) return t;
                    return { ...t, endDate: formatDate(newEnd) };
                }
            }));
        };

        const handleMouseUp = async () => {
            const task = tasks.find(t => t.id === dragState.taskId);
            // Find the updated version from state after drag
            setDragState(null);
            if (task) {
                // The state was already updated optimistically. Now persist.
                // We need to read the latest state
                setTasks(prev => {
                    const updated = prev.find(t => t.id === dragState.taskId);
                    if (updated) {
                        updateScheduleTask(dragState.taskId, {
                            startDate: updated.startDate,
                            endDate: updated.endDate,
                        }).catch(() => toast.error("Failed to save"));
                    }
                    return prev;
                });
            }
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    }, [dragState, colWidth, tasks]);

    // --- Handlers ---
    async function handleAddTask() {
        setIsAdding(true);
        try {
            const start = formatDate(today);
            const end = formatDate(addDays(today, 7));
            const newTask = await createScheduleTask(projectId, {
                name: "New Task",
                startDate: start,
                endDate: end,
            });
            setTasks(prev => [...prev, { ...newTask, startDate: start, endDate: end }]);
            setEditingId(newTask.id);
            setEditName("New Task");
            toast.success("Task added");
        } catch {
            toast.error("Failed to add task");
        } finally {
            setIsAdding(false);
        }
    }

    async function handleSaveName(taskId: string) {
        if (!editName.trim()) return;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: editName } : t));
        setEditingId(null);
        await updateScheduleTask(taskId, { name: editName });
    }

    async function handleStatusChange(taskId: string, status: string) {
        const progress = status === "Complete" ? 100 : status === "In Progress" ? 50 : 0;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status, progress } : t));
        await updateScheduleTask(taskId, { status, progress });
    }

    async function handleColorChange(taskId: string, color: string) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color } : t));
        setColorPickerId(null);
        await updateScheduleTask(taskId, { color });
    }

    async function handleDelete(taskId: string) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
        await deleteScheduleTask(taskId);
        toast.success("Task deleted");
    }

    async function handleProgressChange(taskId: string, progress: number) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress } : t));
        await updateScheduleTask(taskId, { progress });
    }

    const headers = getHeaders();
    const todayOffset = getTodayOffset();
    const ROW_HEIGHT = 52;

    // --- EMPTY STATE ---
    if (tasks.length === 0 && !isAdding) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-12">
                <div className="hui-card p-12 text-center max-w-lg">
                    <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-2xl flex items-center justify-center">
                        <svg className="w-10 h-10 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-hui-textMain mb-2">No Schedule Yet</h2>
                    <p className="text-hui-textMuted mb-8">Create your first task to start building the project timeline. Drag and resize bars to set dates.</p>
                    <button onClick={handleAddTask} disabled={isAdding} className="hui-btn hui-btn-primary text-base px-8 py-3">
                        {isAdding ? "Adding..." : "Create First Task"}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Top Toolbar */}
            <div className="bg-white border-b border-hui-border px-6 py-3 flex items-center justify-between shrink-0 shadow-sm z-20">
                <div className="flex items-center gap-4">
                    <h1 className="text-xl font-bold text-hui-textMain">Schedule</h1>
                    <span className="text-sm text-hui-textMuted">—</span>
                    <span className="text-sm text-hui-textMuted">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="flex items-center gap-3">
                    {/* Zoom Toggle */}
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                        {(["day", "week", "month"] as ZoomLevel[]).map(z => (
                            <button
                                key={z}
                                onClick={() => setZoom(z)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition capitalize ${zoom === z ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                            >
                                {z}
                            </button>
                        ))}
                    </div>
                    <button
                        onClick={() => {
                            if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayOffset - 300);
                        }}
                        className="hui-btn hui-btn-secondary text-xs py-1.5 px-3"
                    >
                        Today
                    </button>
                    <button onClick={handleAddTask} disabled={isAdding} className="hui-btn hui-btn-primary text-sm">
                        + Add Task
                    </button>
                </div>
            </div>

            {/* Gantt Body */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left Panel — Task List */}
                <div className="w-80 shrink-0 bg-white border-r border-hui-border flex flex-col z-10">
                    {/* Table Header */}
                    <div className="flex items-center px-4 py-3 bg-slate-50 border-b border-hui-border text-[11px] font-bold text-slate-400 uppercase tracking-wider h-[44px]">
                        <div className="flex-1">Task Name</div>
                        <div className="w-24 text-center">Status</div>
                        <div className="w-10"></div>
                    </div>
                    {/* Task Rows */}
                    <div className="flex-1 overflow-y-auto">
                        {tasks.map(task => (
                            <div
                                key={task.id}
                                className="flex items-center px-4 border-b border-slate-100 hover:bg-slate-50/80 transition group"
                                style={{ height: ROW_HEIGHT }}
                            >
                                {/* Color Dot */}
                                <div className="relative mr-3">
                                    <button
                                        onClick={() => setColorPickerId(colorPickerId === task.id ? null : task.id)}
                                        className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm ring-1 ring-slate-200 hover:ring-slate-400 transition"
                                        style={{ backgroundColor: task.color }}
                                    />
                                    {colorPickerId === task.id && (
                                        <div className="absolute top-6 left-0 z-50 bg-white border border-hui-border rounded-lg shadow-xl p-2 flex gap-1.5 animate-in fade-in">
                                            {PRESET_COLORS.map(c => (
                                                <button
                                                    key={c}
                                                    onClick={() => handleColorChange(task.id, c)}
                                                    className="w-6 h-6 rounded-full hover:scale-125 transition shadow-sm border border-white"
                                                    style={{ backgroundColor: c }}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                                {/* Name */}
                                <div className="flex-1 min-w-0">
                                    {editingId === task.id ? (
                                        <input
                                            autoFocus
                                            className="hui-input text-sm py-1 w-full"
                                            value={editName}
                                            onChange={e => setEditName(e.target.value)}
                                            onBlur={() => handleSaveName(task.id)}
                                            onKeyDown={e => { if (e.key === "Enter") handleSaveName(task.id); }}
                                        />
                                    ) : (
                                        <button
                                            onClick={() => { setEditingId(task.id); setEditName(task.name); }}
                                            className="text-sm font-medium text-hui-textMain truncate text-left w-full hover:text-hui-primary transition"
                                        >
                                            {task.name}
                                        </button>
                                    )}
                                </div>
                                {/* Status */}
                                <div className="w-24 flex justify-center">
                                    <select
                                        value={task.status}
                                        onChange={e => handleStatusChange(task.id, e.target.value)}
                                        className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border-0 cursor-pointer appearance-none text-center ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-700"}`}
                                    >
                                        {STATUS_OPTIONS.map(s => (
                                            <option key={s} value={s}>{s}</option>
                                        ))}
                                    </select>
                                </div>
                                {/* Delete */}
                                <div className="w-10 flex justify-end">
                                    <button
                                        onClick={() => handleDelete(task.id)}
                                        className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1 transition opacity-0 group-hover:opacity-100"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                    </button>
                                </div>
                            </div>
                        ))}
                        {/* Add Task Row */}
                        <button
                            onClick={handleAddTask}
                            className="flex items-center px-4 w-full text-left hover:bg-slate-50 transition text-sm text-indigo-500 font-medium gap-2 group"
                            style={{ height: ROW_HEIGHT }}
                            disabled={isAdding}
                        >
                            <span className="bg-indigo-50 group-hover:bg-indigo-100 rounded p-0.5 transition">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                            </span>
                            {isAdding ? "Adding..." : "Add Task"}
                        </button>
                    </div>
                </div>

                {/* Right Panel — Timeline */}
                <div ref={scrollRef} className="flex-1 overflow-auto bg-slate-50/50 relative">
                    <div style={{ width: timelineWidth, minHeight: "100%" }} className="relative">
                        {/* Header */}
                        <div className="sticky top-0 z-10 flex bg-slate-50 border-b border-hui-border h-[44px]">
                            {headers.map(h => (
                                <div
                                    key={h.key}
                                    className="text-[11px] font-semibold text-slate-500 border-r border-slate-200/60 flex items-center justify-center shrink-0 uppercase tracking-wider"
                                    style={{ width: h.span * colWidth }}
                                >
                                    {h.label}
                                </div>
                            ))}
                        </div>

                        {/* Today line */}
                        <div
                            className="absolute top-0 bottom-0 w-px z-[5] pointer-events-none"
                            style={{
                                left: todayOffset,
                                background: "repeating-linear-gradient(to bottom, #ef4444 0, #ef4444 4px, transparent 4px, transparent 8px)"
                            }}
                        >
                            <div className="absolute -top-0 -translate-x-1/2 bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-b-md shadow">
                                TODAY
                            </div>
                        </div>

                        {/* Task Bars */}
                        {tasks.map((task, idx) => {
                            const bar = getBarStyle(task);
                            return (
                                <div
                                    key={task.id}
                                    className="absolute flex items-center"
                                    style={{
                                        top: 44 + idx * ROW_HEIGHT + 10,
                                        left: bar.left,
                                        width: bar.width,
                                        height: ROW_HEIGHT - 20,
                                    }}
                                >
                                    {/* Resize handle left */}
                                    <div
                                        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-l-md transition"
                                        onMouseDown={e => handleMouseDown(e, task.id, "resize-left")}
                                    />
                                    {/* Bar body */}
                                    <div
                                        className="w-full h-full rounded-md shadow-sm cursor-grab active:cursor-grabbing relative overflow-hidden group border border-black/5"
                                        style={{ backgroundColor: task.color + "22" }}
                                        onMouseDown={e => handleMouseDown(e, task.id, "move")}
                                    >
                                        {/* Progress fill */}
                                        <div
                                            className="absolute inset-0 rounded-md transition-all"
                                            style={{
                                                width: `${task.progress}%`,
                                                backgroundColor: task.color,
                                                opacity: 0.7,
                                            }}
                                        />
                                        {/* Task label on bar */}
                                        <div className="relative z-[2] flex items-center h-full px-2">
                                            <span className="text-[11px] font-semibold truncate" style={{ color: task.progress > 50 ? "#fff" : task.color }}>
                                                {task.name}
                                            </span>
                                        </div>
                                        {/* Progress drag handle */}
                                        <div
                                            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition z-10"
                                            title={`${task.progress}%`}
                                        >
                                            <input
                                                type="range"
                                                min={0}
                                                max={100}
                                                value={task.progress}
                                                onChange={e => handleProgressChange(task.id, parseInt(e.target.value))}
                                                onMouseDown={e => e.stopPropagation()}
                                                className="w-16 h-1 accent-current cursor-pointer"
                                                style={{ accentColor: task.color }}
                                            />
                                        </div>
                                    </div>
                                    {/* Resize handle right */}
                                    <div
                                        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-r-md transition"
                                        onMouseDown={e => handleMouseDown(e, task.id, "resize-right")}
                                    />
                                </div>
                            );
                        })}

                        {/* Grid lines (subtle) */}
                        {headers.map((h, i) => {
                            let x = 0;
                            for (let j = 0; j < i; j++) x += headers[j].span * colWidth;
                            return (
                                <div
                                    key={`grid-${h.key}`}
                                    className="absolute top-[44px] bottom-0 border-r border-slate-200/40 pointer-events-none"
                                    style={{ left: x }}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
