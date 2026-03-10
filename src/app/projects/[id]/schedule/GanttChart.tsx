"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createScheduleTask, updateScheduleTask, deleteScheduleTask, importEstimateToSchedule, linkTasks, unlinkTasks } from "@/lib/actions";
import { toast } from "sonner";

type EstimateSummary = {
    id: string;
    title: string;
    status: string;
};

type Dependency = {
    id: string;
    predecessorId: string;
    dependentId: string;
};

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
    estimatedHours: number | null;
    actualHours: number;  // computed from timeEntries
    dependencies: Dependency[];
    dependents: Dependency[];
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

export default function GanttChart({ projectId, projectName, initialTasks, estimates = [] }: {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
    estimates?: EstimateSummary[];
}) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [zoom, setZoom] = useState<ZoomLevel>("week");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [showImportMenu, setShowImportMenu] = useState(false);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [showAiMenu, setShowAiMenu] = useState(false);
    const [linkMode, setLinkMode] = useState<string | null>(null); // first task id when linking
    const [editingHoursId, setEditingHoursId] = useState<string | null>(null);
    const [editHoursVal, setEditHoursVal] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragState, setDragState] = useState<{
        taskId: string;
        type: "move" | "resize-left" | "resize-right";
        startX: number;
        origStart: Date;
        origEnd: Date;
    } | null>(null);

    // Timeline range
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

    function getHeaders() {
        const headers: { label: string; span: number; key: string }[] = [];
        if (zoom === "month") {
            let cursor = new Date(minDate);
            while (cursor < maxDate) {
                const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
                const end = monthEnd > maxDate ? maxDate : monthEnd;
                const days = getDaysBetween(cursor, end) + 1;
                headers.push({ label: cursor.toLocaleString("en", { month: "short" }), span: days, key: `m-${cursor.getMonth()}-${cursor.getFullYear()}` });
                cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            }
        } else if (zoom === "week") {
            let cursor = getMonday(new Date(minDate));
            while (cursor < maxDate) {
                const label = cursor.toLocaleDateString("en", { month: "short", day: "numeric" }).toUpperCase();
                headers.push({ label, span: 7, key: `w-${formatDate(cursor)}` });
                cursor = addDays(cursor, 7);
            }
        } else {
            let cursor = new Date(minDate);
            while (cursor < maxDate) {
                headers.push({ label: cursor.getDate().toString(), span: 1, key: `d-${formatDate(cursor)}` });
                cursor = addDays(cursor, 1);
            }
        }
        return headers;
    }

    function getBarStyle(task: Task) {
        const start = new Date(task.startDate);
        const end = new Date(task.endDate);
        const left = getDaysBetween(minDate, start) * colWidth;
        const width = Math.max(getDaysBetween(start, end) * colWidth, colWidth);
        return { left, width };
    }

    function getTodayOffset() {
        return getDaysBetween(minDate, today) * colWidth;
    }

    // Compute auto-progress for a task
    function getAutoProgress(task: Task): number {
        if (task.estimatedHours && task.estimatedHours > 0 && task.actualHours > 0) {
            return Math.min(100, Math.round((task.actualHours / task.estimatedHours) * 100));
        }
        return task.progress;
    }

    const handleMouseDown = useCallback((e: React.MouseEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        e.preventDefault();
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

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dayDelta = Math.round(dx / colWidth);
        if (dayDelta === 0) return;

        setTasks(prev => prev.map(t => {
            if (t.id !== dragState.taskId) return t;
            if (dragState.type === "move") {
                return {
                    ...t,
                    startDate: formatDate(addDays(dragState.origStart, dayDelta)),
                    endDate: formatDate(addDays(dragState.origEnd, dayDelta)),
                };
            } else if (dragState.type === "resize-right") {
                const newEnd = addDays(dragState.origEnd, dayDelta);
                if (newEnd <= new Date(t.startDate)) return t;
                return { ...t, endDate: formatDate(newEnd) };
            } else {
                const newStart = addDays(dragState.origStart, dayDelta);
                if (newStart >= new Date(t.endDate)) return t;
                return { ...t, startDate: formatDate(newStart) };
            }
        }));
    }, [dragState, colWidth]);

    const handleMouseUp = useCallback(async () => {
        if (!dragState) return;
        const task = tasks.find(t => t.id === dragState.taskId);
        if (task) {
            await updateScheduleTask(dragState.taskId, {
                startDate: task.startDate,
                endDate: task.endDate,
            });

            // Cascade to dependents if this was a move
            if (dragState.type === "move") {
                const dayDelta = getDaysBetween(dragState.origStart, new Date(task.startDate));
                if (dayDelta !== 0) {
                    await cascadeDependents(dragState.taskId, dayDelta);
                }
            }
        }
        setDragState(null);
    }, [dragState, tasks]);

    // Cascade date shifts to all downstream dependents
    async function cascadeDependents(taskId: string, dayDelta: number) {
        const directDependents = tasks.filter(t =>
            t.dependencies.some(d => d.predecessorId === taskId)
        );
        for (const dep of directDependents) {
            const newStart = formatDate(addDays(new Date(dep.startDate), dayDelta));
            const newEnd = formatDate(addDays(new Date(dep.endDate), dayDelta));
            setTasks(prev => prev.map(t => t.id === dep.id ? { ...t, startDate: newStart, endDate: newEnd } : t));
            await updateScheduleTask(dep.id, { startDate: newStart, endDate: newEnd });
            // Recursively cascade
            await cascadeDependents(dep.id, dayDelta);
        }
    }

    useEffect(() => {
        if (dragState) {
            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);
            return () => {
                window.removeEventListener("mousemove", handleMouseMove);
                window.removeEventListener("mouseup", handleMouseUp);
            };
        }
    }, [dragState, handleMouseMove, handleMouseUp]);

    async function handleAddTask() {
        setIsAdding(true);
        try {
            const start = formatDate(today);
            const end = formatDate(addDays(today, 5));
            const task = await createScheduleTask(projectId, { name: "New Task", startDate: start, endDate: end });
            setTasks(prev => [...prev, { ...task, startDate: start, endDate: end, actualHours: 0, estimatedHours: null, dependencies: [], dependents: [] }]);
            toast.success("Task added");
        } finally {
            setIsAdding(false);
        }
    }

    async function handleSaveName(taskId: string) {
        if (editName.trim()) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: editName.trim() } : t));
            await updateScheduleTask(taskId, { name: editName.trim() });
        }
        setEditingId(null);
    }

    async function handleColorChange(taskId: string, color: string) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color } : t));
        setColorPickerId(null);
        await updateScheduleTask(taskId, { color });
    }

    async function handleStatusChange(taskId: string, status: string) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
        await updateScheduleTask(taskId, { status });
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

    async function handleEstimatedHoursSave(taskId: string) {
        const hours = parseFloat(editHoursVal);
        if (!isNaN(hours) && hours >= 0) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: hours } : t));
            await updateScheduleTask(taskId, { estimatedHours: hours });
            toast.success("Estimated hours updated");
        }
        setEditingHoursId(null);
    }

    async function handleImportEstimate(estimateId: string) {
        setIsImporting(true);
        setShowImportMenu(false);
        try {
            const newTasks = await importEstimateToSchedule(projectId, estimateId);
            const mapped = newTasks.map((t: any) => ({
                ...t,
                startDate: formatDate(new Date(t.startDate)),
                endDate: formatDate(new Date(t.endDate)),
                actualHours: 0,
                estimatedHours: null,
                dependencies: [],
                dependents: [],
            }));
            setTasks(prev => [...prev, ...mapped]);
            toast.success(`Imported ${mapped.length} tasks`);
        } catch {
            toast.error("Import failed");
        } finally {
            setIsImporting(false);
        }
    }

    async function handleAiSchedule(estimateId?: string) {
        setIsAiGenerating(true);
        setShowAiMenu(false);
        try {
            const res = await fetch("/api/ai-schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, estimateId }),
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || "AI scheduling failed");
                return;
            }
            const mapped: Task[] = data.tasks.map((t: any) => ({
                ...t,
                startDate: typeof t.startDate === 'string' ? t.startDate : t.startDate,
                endDate: typeof t.endDate === 'string' ? t.endDate : t.endDate,
                actualHours: 0,
                estimatedHours: null,
                dependencies: [],
                dependents: [],
            }));
            setTasks(prev => [...prev, ...mapped]);
            toast.success(`✨ AI generated ${data.count} tasks`);
        } catch {
            toast.error("Failed to connect to AI");
        } finally {
            setIsAiGenerating(false);
        }
    }

    // --- LINKING ---
    async function handleTaskClick(taskId: string) {
        if (!linkMode) return;
        if (linkMode === taskId) {
            setLinkMode(null);
            return;
        }
        // Create link: linkMode is predecessor, taskId is dependent
        try {
            const dep = await linkTasks(linkMode, taskId);
            setTasks(prev => prev.map(t => {
                if (t.id === taskId) {
                    return { ...t, dependencies: [...t.dependencies, { id: dep.id, predecessorId: linkMode, dependentId: taskId }] };
                }
                if (t.id === linkMode) {
                    return { ...t, dependents: [...t.dependents, { id: dep.id, predecessorId: linkMode, dependentId: taskId }] };
                }
                return t;
            }));
            toast.success("Tasks linked");
        } catch {
            toast.error("Already linked or invalid");
        }
        setLinkMode(null);
    }

    async function handleUnlink(predecessorId: string, dependentId: string) {
        await unlinkTasks(predecessorId, dependentId);
        setTasks(prev => prev.map(t => ({
            ...t,
            dependencies: t.dependencies.filter(d => !(d.predecessorId === predecessorId && d.dependentId === dependentId)),
            dependents: t.dependents.filter(d => !(d.predecessorId === predecessorId && d.dependentId === dependentId)),
        })));
        toast.success("Link removed");
    }

    const headers = getHeaders();
    const todayOffset = getTodayOffset();
    const ROW_HEIGHT = 52;

    // --- EMPTY STATE ---
    if (tasks.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-white to-slate-50 gap-4 py-20">
                <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>
                </div>
                <h2 className="text-lg font-semibold text-hui-textMain">No tasks yet</h2>
                <p className="text-sm text-hui-textMuted max-w-sm text-center">Create your project schedule by adding tasks or let AI generate one for you.</p>
                <div className="flex gap-3">
                    <button onClick={handleAddTask} className="hui-btn hui-btn-primary text-sm" disabled={isAdding}>+ Add First Task</button>
                </div>
            </div>
        );
    }

    // Collect all dependency arrows data
    const arrows: { fromId: string; toId: string; predecessorId: string; dependentId: string }[] = [];
    tasks.forEach(t => {
        t.dependencies.forEach(d => {
            arrows.push({ fromId: d.predecessorId, toId: d.dependentId, predecessorId: d.predecessorId, dependentId: d.dependentId });
        });
    });

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
                    {/* Link Mode Toggle */}
                    <button
                        onClick={() => setLinkMode(linkMode ? null : "__awaiting__")}
                        className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg font-medium transition-all border ${
                            linkMode
                                ? "bg-amber-50 text-amber-700 border-amber-300 ring-2 ring-amber-200"
                                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300"
                        }`}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        {linkMode ? (linkMode === "__awaiting__" ? "Click first task…" : "Click second task…") : "Link Tasks"}
                    </button>
                    {/* Import from Estimate */}
                    {estimates.length > 0 && (
                        <div className="relative">
                            <button
                                onClick={() => setShowImportMenu(!showImportMenu)}
                                disabled={isImporting}
                                className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                                {isImporting ? "Importing..." : "Import from Estimate"}
                            </button>
                            {showImportMenu && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[280px] py-1 animate-in fade-in">
                                    <div className="px-3 py-2 text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-hui-border">
                                        Select Estimate
                                    </div>
                                    {estimates.map(est => (
                                        <button
                                            key={est.id}
                                            onClick={() => handleImportEstimate(est.id)}
                                            className="w-full text-left px-3 py-2.5 hover:bg-slate-50 transition flex items-center justify-between group"
                                        >
                                            <div>
                                                <div className="text-sm font-medium text-hui-textMain group-hover:text-hui-primary transition">{est.title}</div>
                                                <div className="text-[11px] text-hui-textMuted">{est.status}</div>
                                            </div>
                                            <svg className="w-4 h-4 text-slate-300 group-hover:text-hui-primary transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {/* ✨ AI Schedule Button */}
                    <div className="relative">
                        <button
                            onClick={() => estimates.length > 0 ? setShowAiMenu(!showAiMenu) : handleAiSchedule()}
                            disabled={isAiGenerating}
                            className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg font-medium transition-all border ${
                                isAiGenerating
                                    ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white border-purple-600 animate-pulse"
                                    : "bg-gradient-to-r from-purple-50 to-indigo-50 text-purple-700 border-purple-200 hover:from-purple-100 hover:to-indigo-100 hover:border-purple-300 hover:shadow-md"
                            }`}
                        >
                            <span className="text-base">✨</span>
                            {isAiGenerating ? "AI is thinking..." : "AI Schedule"}
                        </button>
                        {showAiMenu && estimates.length > 0 && (
                            <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[300px] py-1 animate-in fade-in">
                                <div className="px-3 py-2 text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-hui-border">
                                    AI Schedule from...
                                </div>
                                <button
                                    onClick={() => handleAiSchedule()}
                                    className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition flex items-center gap-2 group border-b border-slate-100"
                                >
                                    <span className="text-base">🧠</span>
                                    <div>
                                        <div className="text-sm font-medium text-hui-textMain group-hover:text-purple-700 transition">General Project Schedule</div>
                                        <div className="text-[11px] text-hui-textMuted">AI creates a schedule based on the project type</div>
                                    </div>
                                </button>
                                {estimates.map(est => (
                                    <button
                                        key={est.id}
                                        onClick={() => handleAiSchedule(est.id)}
                                        className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition flex items-center gap-2 group"
                                    >
                                        <span className="text-base">📋</span>
                                        <div>
                                            <div className="text-sm font-medium text-hui-textMain group-hover:text-purple-700 transition">{est.title}</div>
                                            <div className="text-[11px] text-hui-textMuted">Schedule from estimate — {est.status}</div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button onClick={handleAddTask} disabled={isAdding} className="hui-btn hui-btn-primary text-sm">
                        + Add Task
                    </button>
                </div>
            </div>

            {/* Link Mode Banner */}
            {linkMode && (
                <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-sm text-amber-800">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span className="font-medium">
                        {linkMode === "__awaiting__"
                            ? "Click the first task (predecessor) to start linking"
                            : `Now click the second task (dependent) to complete the link`}
                    </span>
                    <button onClick={() => setLinkMode(null)} className="ml-auto text-amber-600 hover:text-amber-800 text-xs font-medium">Cancel</button>
                </div>
            )}

            {/* Gantt Body */}
            <div className="flex flex-1 overflow-hidden">
                {/* Left Panel — Task List */}
                <div className="w-96 shrink-0 bg-white border-r border-hui-border flex flex-col z-10">
                    {/* Table Header */}
                    <div className="flex items-center px-4 py-3 bg-slate-50 border-b border-hui-border text-[11px] font-bold text-slate-400 uppercase tracking-wider h-[44px]">
                        <div className="flex-1">Task Name</div>
                        <div className="w-20 text-center">Hours</div>
                        <div className="w-24 text-center">Status</div>
                        <div className="w-10"></div>
                    </div>
                    {/* Task Rows */}
                    <div className="flex-1 overflow-y-auto">
                        {tasks.map(task => {
                            const autoProgress = getAutoProgress(task);
                            const hasTimeData = task.actualHours > 0 && task.estimatedHours;
                            return (
                                <div
                                    key={task.id}
                                    onClick={() => {
                                        if (linkMode === "__awaiting__") {
                                            setLinkMode(task.id);
                                        } else if (linkMode) {
                                            handleTaskClick(task.id);
                                        }
                                    }}
                                    className={`flex items-center px-4 border-b border-slate-100 hover:bg-slate-50/80 transition group ${
                                        linkMode ? "cursor-pointer" : ""
                                    } ${linkMode === task.id ? "bg-amber-50 ring-1 ring-amber-300" : ""}`}
                                    style={{ height: ROW_HEIGHT }}
                                >
                                    {/* Color Dot */}
                                    <div className="relative mr-3">
                                        <button
                                            onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }}
                                            className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm ring-1 ring-slate-200 hover:ring-slate-400 transition"
                                            style={{ backgroundColor: task.color }}
                                        />
                                        {colorPickerId === task.id && (
                                            <div className="absolute top-6 left-0 z-50 bg-white border border-hui-border rounded-lg shadow-xl p-2 flex gap-1.5 animate-in fade-in">
                                                {PRESET_COLORS.map(c => (
                                                    <button
                                                        key={c}
                                                        onClick={e => { e.stopPropagation(); handleColorChange(task.id, c); }}
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
                                                onClick={e => e.stopPropagation()}
                                            />
                                        ) : (
                                            <button
                                                onClick={e => { if (!linkMode) { e.stopPropagation(); setEditingId(task.id); setEditName(task.name); }}}
                                                className="text-sm font-medium text-hui-textMain truncate text-left w-full hover:text-hui-primary transition"
                                            >
                                                {task.name}
                                            </button>
                                        )}
                                    </div>
                                    {/* Hours */}
                                    <div className="w-20 flex justify-center">
                                        {editingHoursId === task.id ? (
                                            <input
                                                autoFocus
                                                type="number"
                                                className="hui-input text-[11px] py-0.5 w-14 text-center"
                                                value={editHoursVal}
                                                onChange={e => setEditHoursVal(e.target.value)}
                                                onBlur={() => handleEstimatedHoursSave(task.id)}
                                                onKeyDown={e => { if (e.key === "Enter") handleEstimatedHoursSave(task.id); }}
                                                onClick={e => e.stopPropagation()}
                                                placeholder="hrs"
                                            />
                                        ) : (
                                            <button
                                                onClick={e => { e.stopPropagation(); setEditingHoursId(task.id); setEditHoursVal(task.estimatedHours?.toString() || ""); }}
                                                className={`text-[11px] px-1.5 py-0.5 rounded transition ${
                                                    hasTimeData
                                                        ? "bg-blue-50 text-blue-700 font-semibold"
                                                        : task.estimatedHours
                                                            ? "text-slate-500 hover:bg-slate-100"
                                                            : "text-slate-300 hover:bg-slate-100"
                                                }`}
                                                title={hasTimeData ? `${task.actualHours.toFixed(1)}h logged / ${task.estimatedHours}h estimated = ${autoProgress}%` : "Click to set estimated hours"}
                                            >
                                                {hasTimeData ? (
                                                    <span>
                                                        <span className="font-bold">{task.actualHours.toFixed(1)}</span>
                                                        <span className="text-slate-400">/{task.estimatedHours}h</span>
                                                    </span>
                                                ) : task.estimatedHours ? (
                                                    `${task.estimatedHours}h`
                                                ) : (
                                                    "—"
                                                )}
                                            </button>
                                        )}
                                    </div>
                                    {/* Status */}
                                    <div className="w-24 flex justify-center">
                                        <select
                                            value={task.status}
                                            onChange={e => { e.stopPropagation(); handleStatusChange(task.id, e.target.value); }}
                                            onClick={e => e.stopPropagation()}
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
                                            onClick={e => { e.stopPropagation(); handleDelete(task.id); }}
                                            className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1 transition opacity-0 group-hover:opacity-100"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
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

                        {/* Dependency Arrows (SVG overlay) */}
                        <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-[4]" style={{ width: timelineWidth, height: 44 + tasks.length * ROW_HEIGHT }}>
                            <defs>
                                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                                    <polygon points="0 0, 8 3, 0 6" fill="#94a3b8" />
                                </marker>
                            </defs>
                            {arrows.map((arrow, i) => {
                                const fromTask = tasks.find(t => t.id === arrow.fromId);
                                const toTask = tasks.find(t => t.id === arrow.toId);
                                if (!fromTask || !toTask) return null;
                                const fromIdx = tasks.indexOf(fromTask);
                                const toIdx = tasks.indexOf(toTask);
                                const fromBar = getBarStyle(fromTask);
                                const toBar = getBarStyle(toTask);

                                const x1 = fromBar.left + fromBar.width;
                                const y1 = 44 + fromIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                                const x2 = toBar.left;
                                const y2 = 44 + toIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

                                // Curved path
                                const midX = (x1 + x2) / 2;

                                return (
                                    <g key={`arrow-${i}`}>
                                        <path
                                            d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                                            fill="none"
                                            stroke="#94a3b8"
                                            strokeWidth="1.5"
                                            strokeDasharray="4,3"
                                            markerEnd="url(#arrowhead)"
                                        />
                                        {/* Clickable delete zone */}
                                        <circle
                                            cx={midX}
                                            cy={(y1 + y2) / 2}
                                            r="8"
                                            fill="transparent"
                                            className="pointer-events-auto cursor-pointer"
                                            onClick={() => handleUnlink(arrow.predecessorId, arrow.dependentId)}
                                        >
                                            <title>Click to remove link</title>
                                        </circle>
                                        <text
                                            x={midX}
                                            y={(y1 + y2) / 2 + 3.5}
                                            textAnchor="middle"
                                            fill="#94a3b8"
                                            fontSize="9"
                                            fontWeight="bold"
                                            className="pointer-events-none"
                                        >
                                            ×
                                        </text>
                                    </g>
                                );
                            })}
                        </svg>

                        {/* Task Bars */}
                        {tasks.map((task, idx) => {
                            const bar = getBarStyle(task);
                            const autoProgress = getAutoProgress(task);
                            const hasTimeData = task.actualHours > 0 && task.estimatedHours;
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
                                                width: `${autoProgress}%`,
                                                backgroundColor: task.color,
                                                opacity: 0.7,
                                            }}
                                        />
                                        {/* Task label on bar */}
                                        <div className="relative z-[2] flex items-center justify-between h-full px-2">
                                            <span className="text-[11px] font-semibold truncate" style={{ color: autoProgress > 50 ? "#fff" : task.color }}>
                                                {task.name}
                                            </span>
                                            {/* Hours badge on bar */}
                                            {hasTimeData && bar.width > 100 && (
                                                <span className="text-[9px] font-bold ml-1 px-1 py-0.5 rounded bg-white/60 text-slate-700 whitespace-nowrap flex items-center gap-0.5">
                                                    🕐 {task.actualHours.toFixed(1)}/{task.estimatedHours}h
                                                </span>
                                            )}
                                        </div>
                                        {/* Progress slider — only show for tasks WITHOUT time entry data */}
                                        {!hasTimeData && (
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
                                        )}
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
