"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
    createScheduleTask, updateScheduleTask, deleteScheduleTask,
    importEstimateToSchedule, linkTasks, unlinkTasks,
    addTaskComment, getTaskComments, addTaskPunchItem, togglePunchItem,
    deletePunchItem, getTaskPunchItems, aiGeneratePunchlist,
    assignUserToTask, unassignUserFromTask,
} from "@/lib/actions";
import { toast } from "sonner";

type EstimateSummary = { id: string; title: string; status: string };
type Dependency = { id: string; predecessorId: string; dependentId: string };
type TeamMember = { id: string; name: string | null; email: string };
type PunchItem = { id: string; name: string; completed: boolean; order: number };
type Comment = { id: string; text: string; createdAt: string; user: { id: string; name: string | null; email: string } };
type Assignment = { id: string; userId: string; user: TeamMember };

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
    actualHours: number;
    dependencies: Dependency[];
    dependents: Dependency[];
    assignments?: Assignment[];
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

function getDaysBetween(a: Date, b: Date) { return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)); }
function addDays(date: Date, days: number) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function formatDate(d: Date) { return d.toISOString().split("T")[0]; }
function getMonday(d: Date) { const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.setDate(diff)); }
function isWeekend(d: Date) { const day = d.getDay(); return day === 0 || day === 6; }
function getInitials(name: string | null, email: string) { if (name) { const parts = name.split(" "); return parts.map(p => p[0]).join("").toUpperCase().slice(0, 2); } return email[0].toUpperCase(); }

export default function GanttChart({ projectId, projectName, initialTasks, estimates = [], teamMembers = [] }: {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
    estimates?: EstimateSummary[];
    teamMembers?: TeamMember[];
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
    const [linkMode, setLinkMode] = useState<string | null>(null);
    const [editingHoursId, setEditingHoursId] = useState<string | null>(null);
    const [editHoursVal, setEditHoursVal] = useState("");
    // Detail panel state
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [panelTab, setPanelTab] = useState<"details" | "punch" | "conversation">("details");
    const [punchItems, setPunchItems] = useState<PunchItem[]>([]);
    const [comments, setComments] = useState<Comment[]>([]);
    const [newPunchName, setNewPunchName] = useState("");
    const [newComment, setNewComment] = useState("");
    const [isAiPunching, setIsAiPunching] = useState(false);
    const [showAssignMenu, setShowAssignMenu] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragState, setDragState] = useState<{
        taskId: string; type: "move" | "resize-left" | "resize-right"; startX: number; origStart: Date; origEnd: Date;
    } | null>(null);

    const selectedTask = tasks.find(t => t.id === selectedTaskId);

    // Load detail data when task selected
    useEffect(() => {
        if (selectedTaskId) {
            getTaskPunchItems(selectedTaskId).then(items => setPunchItems(items as any));
            getTaskComments(selectedTaskId).then(comments => setComments(comments.map((c: any) => ({ ...c, createdAt: c.createdAt.toISOString?.() || c.createdAt }))));
        }
    }, [selectedTaskId]);

    // Timeline range
    const allDates = tasks.flatMap(t => [new Date(t.startDate), new Date(t.endDate)]);
    const today = new Date();
    if (allDates.length === 0) { allDates.push(addDays(today, -14), addDays(today, 60)); }
    const minDate = addDays(new Date(Math.min(...allDates.map(d => d.getTime()))), -14);
    const maxDate = addDays(new Date(Math.max(...allDates.map(d => d.getTime()))), 30);
    const totalDays = getDaysBetween(minDate, maxDate);
    const colWidth = zoom === "day" ? 40 : zoom === "week" ? 20 : 8;
    const timelineWidth = totalDays * colWidth;
    const ROW_HEIGHT = 52;

    function getHeaders() {
        const headers: { label: string; span: number; key: string }[] = [];
        if (zoom === "month") {
            let cursor = new Date(minDate);
            while (cursor < maxDate) {
                const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
                const end = monthEnd > maxDate ? maxDate : monthEnd;
                headers.push({ label: cursor.toLocaleString("en", { month: "short" }), span: getDaysBetween(cursor, end) + 1, key: `m-${cursor.getMonth()}-${cursor.getFullYear()}` });
                cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            }
        } else if (zoom === "week") {
            let cursor = getMonday(new Date(minDate));
            while (cursor < maxDate) {
                headers.push({ label: cursor.toLocaleDateString("en", { month: "short", day: "numeric" }).toUpperCase(), span: 7, key: `w-${formatDate(cursor)}` });
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
        return { left: getDaysBetween(minDate, start) * colWidth, width: Math.max(getDaysBetween(start, end) * colWidth, colWidth) };
    }

    function getAutoProgress(task: Task): number {
        if (task.estimatedHours && task.estimatedHours > 0 && task.actualHours > 0) {
            return Math.min(100, Math.round((task.actualHours / task.estimatedHours) * 100));
        }
        return task.progress;
    }

    // Weekend columns for the timeline
    function getWeekendColumns() {
        const cols: { left: number; width: number }[] = [];
        let cursor = new Date(minDate);
        for (let i = 0; i < totalDays; i++) {
            if (isWeekend(cursor)) {
                cols.push({ left: i * colWidth, width: colWidth });
            }
            cursor = addDays(cursor, 1);
        }
        return cols;
    }

    const todayOffset = getDaysBetween(minDate, today) * colWidth;
    const headers = getHeaders();
    const weekendCols = getWeekendColumns();

    // --- Drag handlers ---
    const handleMouseDown = useCallback((e: React.MouseEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        e.preventDefault();
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        setDragState({ taskId, type, startX: e.clientX, origStart: new Date(task.startDate), origEnd: new Date(task.endDate) });
    }, [tasks]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!dragState) return;
        const dayDelta = Math.round((e.clientX - dragState.startX) / colWidth);
        if (dayDelta === 0) return;
        setTasks(prev => prev.map(t => {
            if (t.id !== dragState.taskId) return t;
            if (dragState.type === "move") return { ...t, startDate: formatDate(addDays(dragState.origStart, dayDelta)), endDate: formatDate(addDays(dragState.origEnd, dayDelta)) };
            if (dragState.type === "resize-right") { const ne = addDays(dragState.origEnd, dayDelta); return ne <= new Date(t.startDate) ? t : { ...t, endDate: formatDate(ne) }; }
            const ns = addDays(dragState.origStart, dayDelta); return ns >= new Date(t.endDate) ? t : { ...t, startDate: formatDate(ns) };
        }));
    }, [dragState, colWidth]);

    const handleMouseUp = useCallback(async () => {
        if (!dragState) return;
        const task = tasks.find(t => t.id === dragState.taskId);
        if (task) {
            await updateScheduleTask(dragState.taskId, { startDate: task.startDate, endDate: task.endDate });
            if (dragState.type === "move") {
                const dayDelta = getDaysBetween(dragState.origStart, new Date(task.startDate));
                if (dayDelta !== 0) await cascadeDependents(dragState.taskId, dayDelta);
            }
        }
        setDragState(null);
    }, [dragState, tasks]);

    async function cascadeDependents(taskId: string, dayDelta: number) {
        const deps = tasks.filter(t => t.dependencies.some(d => d.predecessorId === taskId));
        for (const dep of deps) {
            const ns = formatDate(addDays(new Date(dep.startDate), dayDelta));
            const ne = formatDate(addDays(new Date(dep.endDate), dayDelta));
            setTasks(prev => prev.map(t => t.id === dep.id ? { ...t, startDate: ns, endDate: ne } : t));
            await updateScheduleTask(dep.id, { startDate: ns, endDate: ne });
            await cascadeDependents(dep.id, dayDelta);
        }
    }

    useEffect(() => {
        if (dragState) {
            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);
            return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
        }
    }, [dragState, handleMouseMove, handleMouseUp]);

    // --- Task CRUD ---
    async function handleAddTask() {
        setIsAdding(true);
        try {
            const start = formatDate(today); const end = formatDate(addDays(today, 5));
            const task = await createScheduleTask(projectId, { name: "New Task", startDate: start, endDate: end });
            setTasks(prev => [...prev, { ...task, startDate: start, endDate: end, actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [] }]);
            toast.success("Task added");
        } finally { setIsAdding(false); }
    }
    async function handleSaveName(taskId: string) { if (editName.trim()) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: editName.trim() } : t)); await updateScheduleTask(taskId, { name: editName.trim() }); } setEditingId(null); }
    async function handleColorChange(taskId: string, color: string) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color } : t)); setColorPickerId(null); await updateScheduleTask(taskId, { color }); }
    async function handleStatusChange(taskId: string, status: string) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t)); await updateScheduleTask(taskId, { status }); }
    async function handleDelete(taskId: string) { setTasks(prev => prev.filter(t => t.id !== taskId)); if (selectedTaskId === taskId) setSelectedTaskId(null); await deleteScheduleTask(taskId); toast.success("Task deleted"); }
    async function handleProgressChange(taskId: string, progress: number) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress } : t)); await updateScheduleTask(taskId, { progress }); }
    async function handleEstimatedHoursSave(taskId: string) { const h = parseFloat(editHoursVal); if (!isNaN(h) && h >= 0) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: h } : t)); await updateScheduleTask(taskId, { estimatedHours: h }); } setEditingHoursId(null); }

    async function handleImportEstimate(estimateId: string) {
        setIsImporting(true); setShowImportMenu(false);
        try {
            const newTasks = await importEstimateToSchedule(projectId, estimateId);
            setTasks(prev => [...prev, ...newTasks.map((t: any) => ({ ...t, startDate: formatDate(new Date(t.startDate)), endDate: formatDate(new Date(t.endDate)), actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [] }))]);
            toast.success(`Imported ${newTasks.length} tasks`);
        } catch { toast.error("Import failed"); } finally { setIsImporting(false); }
    }

    async function handleAiSchedule(estimateId?: string) {
        setIsAiGenerating(true); setShowAiMenu(false);
        try {
            const res = await fetch("/api/ai-schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, estimateId }) });
            const data = await res.json();
            if (!res.ok) { toast.error(data.error || "AI failed"); return; }
            setTasks(prev => [...prev, ...data.tasks.map((t: any) => ({ ...t, actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [] }))]);
            toast.success(`✨ AI generated ${data.count} tasks`);
        } catch { toast.error("Failed to connect to AI"); } finally { setIsAiGenerating(false); }
    }

    // --- Linking ---
    async function handleTaskClick(taskId: string) {
        if (!linkMode) return;
        if (linkMode === taskId) { setLinkMode(null); return; }
        try {
            const dep = await linkTasks(linkMode, taskId);
            setTasks(prev => prev.map(t => {
                if (t.id === taskId) return { ...t, dependencies: [...t.dependencies, { id: dep.id, predecessorId: linkMode, dependentId: taskId }] };
                if (t.id === linkMode) return { ...t, dependents: [...t.dependents, { id: dep.id, predecessorId: linkMode, dependentId: taskId }] };
                return t;
            }));
            toast.success("Tasks linked");
        } catch { toast.error("Already linked or invalid"); }
        setLinkMode(null);
    }
    async function handleUnlink(pid: string, did: string) {
        await unlinkTasks(pid, did);
        setTasks(prev => prev.map(t => ({ ...t, dependencies: t.dependencies.filter(d => !(d.predecessorId === pid && d.dependentId === did)), dependents: t.dependents.filter(d => !(d.predecessorId === pid && d.dependentId === did)) })));
        toast.success("Link removed");
    }

    // --- Detail Panel ---
    async function handleAddPunch() {
        if (!newPunchName.trim() || !selectedTaskId) return;
        const item = await addTaskPunchItem(selectedTaskId, newPunchName.trim());
        setPunchItems(prev => [...prev, item as any]);
        setNewPunchName("");
    }
    async function handleTogglePunch(id: string) { await togglePunchItem(id); setPunchItems(prev => prev.map(p => p.id === id ? { ...p, completed: !p.completed } : p)); }
    async function handleDeletePunch(id: string) { await deletePunchItem(id); setPunchItems(prev => prev.filter(p => p.id !== id)); }
    async function handleAiPunchlist() {
        if (!selectedTaskId) return;
        setIsAiPunching(true);
        try {
            const items = await aiGeneratePunchlist(selectedTaskId);
            setPunchItems(prev => [...prev, ...(items as any)]);
            toast.success(`✨ AI generated ${items.length} punch items`);
        } catch { toast.error("AI punchlist failed"); } finally { setIsAiPunching(false); }
    }
    async function handleAddComment() {
        if (!newComment.trim() || !selectedTaskId) return;
        // We'll use a hardcoded userId for now — in real app, this comes from session
        try {
            const comment = await addTaskComment(selectedTaskId, "system", newComment.trim());
            setComments(prev => [...prev, { ...(comment as any), createdAt: new Date().toISOString() }]);
            setNewComment("");
        } catch { toast.error("Failed to add comment"); }
    }
    async function handleAssign(userId: string) {
        if (!selectedTaskId) return;
        try {
            const assignment = await assignUserToTask(selectedTaskId, userId);
            setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: [...(t.assignments || []), assignment as any] } : t));
            setShowAssignMenu(false);
            toast.success("Member assigned");
        } catch { toast.error("Already assigned"); }
    }
    async function handleUnassign(userId: string) {
        if (!selectedTaskId) return;
        await unassignUserFromTask(selectedTaskId, userId);
        setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: (t.assignments || []).filter(a => a.userId !== userId) } : t));
    }

    // Arrows
    const arrows: { fromId: string; toId: string; predecessorId: string; dependentId: string }[] = [];
    tasks.forEach(t => t.dependencies.forEach(d => arrows.push({ fromId: d.predecessorId, toId: d.dependentId, predecessorId: d.predecessorId, dependentId: d.dependentId })));

    // --- EMPTY STATE ---
    if (tasks.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-white to-slate-50 gap-4 py-20">
                <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>
                </div>
                <h2 className="text-lg font-semibold text-hui-textMain">No tasks yet</h2>
                <p className="text-sm text-hui-textMuted max-w-sm text-center">Create your project schedule by adding tasks or let AI generate one.</p>
                <button onClick={handleAddTask} className="hui-btn hui-btn-primary text-sm" disabled={isAdding}>+ Add First Task</button>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="bg-white border-b border-hui-border px-6 py-3 flex items-center justify-between shrink-0 shadow-sm z-20">
                <div className="flex items-center gap-4">
                    <h1 className="text-xl font-bold text-hui-textMain">Schedule</h1>
                    <span className="text-sm text-hui-textMuted">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                        {(["day", "week", "month"] as ZoomLevel[]).map(z => (
                            <button key={z} onClick={() => setZoom(z)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition capitalize ${zoom === z ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{z}</button>
                        ))}
                    </div>
                    <button onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayOffset - 300); }} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Today</button>
                    <button onClick={() => setLinkMode(linkMode ? null : "__awaiting__")} className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition border ${linkMode ? "bg-amber-50 text-amber-700 border-amber-300 ring-2 ring-amber-200" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        {linkMode ? "Linking..." : "Link"}
                    </button>
                    {estimates.length > 0 && (
                        <div className="relative">
                            <button onClick={() => setShowImportMenu(!showImportMenu)} disabled={isImporting} className="hui-btn hui-btn-secondary text-xs flex items-center gap-1">
                                {isImporting ? "Importing..." : "Import"}
                            </button>
                            {showImportMenu && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] py-1 animate-in fade-in">
                                    {estimates.map(est => (
                                        <button key={est.id} onClick={() => handleImportEstimate(est.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm">{est.title}</button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    <div className="relative">
                        <button onClick={() => estimates.length > 0 ? setShowAiMenu(!showAiMenu) : handleAiSchedule()} disabled={isAiGenerating}
                            className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition border ${isAiGenerating ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white border-purple-600 animate-pulse" : "bg-gradient-to-r from-purple-50 to-indigo-50 text-purple-700 border-purple-200 hover:shadow-md"}`}>
                            ✨ {isAiGenerating ? "AI thinking..." : "AI Schedule"}
                        </button>
                        {showAiMenu && estimates.length > 0 && (
                            <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[260px] py-1 animate-in fade-in">
                                <button onClick={() => handleAiSchedule()} className="w-full text-left px-3 py-2 hover:bg-purple-50 transition text-sm">🧠 General Schedule</button>
                                {estimates.map(est => (
                                    <button key={est.id} onClick={() => handleAiSchedule(est.id)} className="w-full text-left px-3 py-2 hover:bg-purple-50 transition text-sm">📋 {est.title}</button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button onClick={handleAddTask} disabled={isAdding} className="hui-btn hui-btn-primary text-xs">+ Add Task</button>
                </div>
            </div>

            {linkMode && (
                <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-xs text-amber-800">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span className="font-medium">{linkMode === "__awaiting__" ? "Click the predecessor task" : "Now click the dependent task"}</span>
                    <button onClick={() => setLinkMode(null)} className="ml-auto text-amber-600 hover:text-amber-800 text-xs font-medium">Cancel</button>
                </div>
            )}

            <div className="flex flex-1 overflow-hidden">
                {/* Left Panel — Task List */}
                <div className="w-80 shrink-0 bg-white border-r border-hui-border flex flex-col z-10">
                    <div className="flex items-center px-3 py-3 bg-slate-50 border-b border-hui-border text-[10px] font-bold text-slate-400 uppercase tracking-wider h-[44px]">
                        <div className="flex-1">Task Name</div>
                        <div className="w-16 text-center">Hours</div>
                        <div className="w-20 text-center">Status</div>
                        <div className="w-8"></div>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {tasks.map(task => {
                            const hasTimeData = task.actualHours > 0 && task.estimatedHours;
                            return (
                                <div key={task.id}
                                    onClick={() => { if (linkMode === "__awaiting__") setLinkMode(task.id); else if (linkMode) handleTaskClick(task.id); else { setSelectedTaskId(task.id); setPanelTab("details"); } }}
                                    className={`flex items-center px-3 border-b border-slate-100 hover:bg-slate-50/80 transition group cursor-pointer ${selectedTaskId === task.id ? "bg-indigo-50/60 ring-1 ring-indigo-200" : ""} ${linkMode === task.id ? "bg-amber-50 ring-1 ring-amber-300" : ""}`}
                                    style={{ height: ROW_HEIGHT }}
                                >
                                    <div className="relative mr-2">
                                        <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }} className="w-3 h-3 rounded-full border-2 border-white shadow-sm ring-1 ring-slate-200" style={{ backgroundColor: task.color }} />
                                        {colorPickerId === task.id && (
                                            <div className="absolute top-5 left-0 z-50 bg-white border border-hui-border rounded-lg shadow-xl p-1.5 flex gap-1 animate-in fade-in">
                                                {PRESET_COLORS.map(c => (<button key={c} onClick={e => { e.stopPropagation(); handleColorChange(task.id, c); }} className="w-5 h-5 rounded-full hover:scale-125 transition" style={{ backgroundColor: c }} />))}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {editingId === task.id ? (
                                            <input autoFocus className="hui-input text-xs py-1 w-full" value={editName} onChange={e => setEditName(e.target.value)} onBlur={() => handleSaveName(task.id)} onKeyDown={e => { if (e.key === "Enter") handleSaveName(task.id); }} onClick={e => e.stopPropagation()} />
                                        ) : (
                                            <div className="flex items-center gap-1">
                                                {/* Crew avatars inline */}
                                                {(task.assignments || []).slice(0, 2).map(a => (
                                                    <div key={a.userId} className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold flex items-center justify-center shrink-0" title={a.user.name || a.user.email}>
                                                        {getInitials(a.user.name, a.user.email)}
                                                    </div>
                                                ))}
                                                <button onClick={e => { if (!linkMode) { e.stopPropagation(); setEditingId(task.id); setEditName(task.name); }}} className="text-xs font-medium text-hui-textMain truncate text-left hover:text-hui-primary transition">{task.name}</button>
                                            </div>
                                        )}
                                    </div>
                                    <div className="w-16 flex justify-center">
                                        {editingHoursId === task.id ? (
                                            <input autoFocus type="number" className="hui-input text-[10px] py-0.5 w-12 text-center" value={editHoursVal} onChange={e => setEditHoursVal(e.target.value)} onBlur={() => handleEstimatedHoursSave(task.id)} onKeyDown={e => { if (e.key === "Enter") handleEstimatedHoursSave(task.id); }} onClick={e => e.stopPropagation()} placeholder="hrs" />
                                        ) : (
                                            <button onClick={e => { e.stopPropagation(); setEditingHoursId(task.id); setEditHoursVal(task.estimatedHours?.toString() || ""); }} className={`text-[10px] px-1 py-0.5 rounded ${hasTimeData ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-300 hover:bg-slate-100"}`}>
                                                {hasTimeData ? `${task.actualHours.toFixed(1)}/${task.estimatedHours}h` : task.estimatedHours ? `${task.estimatedHours}h` : "—"}
                                            </button>
                                        )}
                                    </div>
                                    <div className="w-20 flex justify-center">
                                        <select value={task.status} onChange={e => { e.stopPropagation(); handleStatusChange(task.id, e.target.value); }} onClick={e => e.stopPropagation()} className={`text-[9px] font-semibold rounded-full px-1.5 py-0.5 border-0 cursor-pointer appearance-none text-center ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-700"}`}>
                                            {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                        </select>
                                    </div>
                                    <div className="w-8 flex justify-end">
                                        <button onClick={e => { e.stopPropagation(); handleDelete(task.id); }} className="text-slate-300 hover:text-red-500 rounded p-0.5 transition opacity-0 group-hover:opacity-100">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                        <button onClick={handleAddTask} className="flex items-center px-3 w-full hover:bg-slate-50 transition text-xs text-indigo-500 font-medium gap-2" style={{ height: ROW_HEIGHT }} disabled={isAdding}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                            {isAdding ? "Adding..." : "Add Task"}
                        </button>
                    </div>
                </div>

                {/* Middle — Timeline */}
                <div ref={scrollRef} className="flex-1 overflow-auto bg-slate-50/50 relative">
                    <div style={{ width: timelineWidth, minHeight: "100%" }} className="relative">
                        <div className="sticky top-0 z-10 flex bg-slate-50 border-b border-hui-border h-[44px]">
                            {headers.map(h => (<div key={h.key} className="text-[10px] font-semibold text-slate-500 border-r border-slate-200/60 flex items-center justify-center shrink-0 uppercase tracking-wider" style={{ width: h.span * colWidth }}>{h.label}</div>))}
                        </div>

                        {/* Weekend shading */}
                        {weekendCols.map((wc, i) => (
                            <div key={`wk-${i}`} className="absolute top-[44px] bottom-0 bg-slate-200/25 pointer-events-none z-[1]" style={{ left: wc.left, width: wc.width }} />
                        ))}

                        {/* Today line */}
                        <div className="absolute top-0 bottom-0 w-px z-[5] pointer-events-none" style={{ left: todayOffset, background: "repeating-linear-gradient(to bottom, #ef4444 0, #ef4444 4px, transparent 4px, transparent 8px)" }}>
                            <div className="absolute -top-0 -translate-x-1/2 bg-red-500 text-white text-[8px] font-bold px-1 py-0.5 rounded-b-md shadow">TODAY</div>
                        </div>

                        {/* Dependency arrows */}
                        <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-[4]" style={{ width: timelineWidth, height: 44 + tasks.length * ROW_HEIGHT }}>
                            <defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#94a3b8" /></marker></defs>
                            {arrows.map((arrow, i) => {
                                const ft = tasks.find(t => t.id === arrow.fromId), tt = tasks.find(t => t.id === arrow.toId);
                                if (!ft || !tt) return null;
                                const fb = getBarStyle(ft), tb = getBarStyle(tt);
                                const x1 = fb.left + fb.width, y1 = 44 + tasks.indexOf(ft) * ROW_HEIGHT + ROW_HEIGHT / 2;
                                const x2 = tb.left, y2 = 44 + tasks.indexOf(tt) * ROW_HEIGHT + ROW_HEIGHT / 2;
                                const mx = (x1 + x2) / 2;
                                return (
                                    <g key={`a-${i}`}>
                                        <path d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4,3" markerEnd="url(#arrowhead)" />
                                        <circle cx={mx} cy={(y1+y2)/2} r="7" fill="transparent" className="pointer-events-auto cursor-pointer" onClick={() => handleUnlink(arrow.predecessorId, arrow.dependentId)}><title>Remove link</title></circle>
                                        <text x={mx} y={(y1+y2)/2+3} textAnchor="middle" fill="#94a3b8" fontSize="9" fontWeight="bold" className="pointer-events-none">×</text>
                                    </g>
                                );
                            })}
                        </svg>

                        {/* Task Bars */}
                        {tasks.map((task, idx) => {
                            const bar = getBarStyle(task);
                            const ap = getAutoProgress(task);
                            return (
                                <div key={task.id} className="absolute flex items-center" style={{ top: 44 + idx * ROW_HEIGHT + 10, left: bar.left, width: bar.width, height: ROW_HEIGHT - 20 }}>
                                    <div className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-l-md" onMouseDown={e => handleMouseDown(e, task.id, "resize-left")} />
                                    <div className="w-full h-full rounded-md shadow-sm cursor-grab active:cursor-grabbing relative overflow-hidden group border border-black/5" style={{ backgroundColor: task.color + "22" }} onMouseDown={e => handleMouseDown(e, task.id, "move")}>
                                        <div className="absolute inset-0 rounded-md transition-all" style={{ width: `${ap}%`, backgroundColor: task.color, opacity: 0.7 }} />
                                        <div className="relative z-[2] flex items-center justify-between h-full px-2">
                                            <span className="text-[10px] font-semibold truncate" style={{ color: ap > 50 ? "#fff" : task.color }}>{task.name}</span>
                                            {(task.assignments || []).length > 0 && bar.width > 80 && (
                                                <div className="flex -space-x-1 ml-1">{(task.assignments || []).slice(0,3).map(a => (
                                                    <div key={a.userId} className="w-4 h-4 rounded-full bg-white text-[7px] font-bold flex items-center justify-center border border-slate-200" style={{ color: task.color }}>{getInitials(a.user.name, a.user.email)}</div>
                                                ))}</div>
                                            )}
                                        </div>
                                        {!(task.actualHours > 0 && task.estimatedHours) && (
                                            <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition z-10" title={`${task.progress}%`}>
                                                <input type="range" min={0} max={100} value={task.progress} onChange={e => handleProgressChange(task.id, parseInt(e.target.value))} onMouseDown={e => e.stopPropagation()} className="w-14 h-1 accent-current cursor-pointer" style={{ accentColor: task.color }} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-r-md" onMouseDown={e => handleMouseDown(e, task.id, "resize-right")} />
                                </div>
                            );
                        })}

                        {headers.map((h, i) => { let x = 0; for (let j = 0; j < i; j++) x += headers[j].span * colWidth; return (<div key={`g-${h.key}`} className="absolute top-[44px] bottom-0 border-r border-slate-200/40 pointer-events-none" style={{ left: x }} />); })}
                    </div>
                </div>

                {/* Right Panel — Task Detail */}
                {selectedTask && (
                    <div className="w-96 shrink-0 bg-white border-l border-hui-border flex flex-col z-10 shadow-lg animate-in slide-in-from-right-5">
                        {/* Panel Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-hui-border bg-slate-50">
                            <h3 className="text-sm font-bold text-hui-textMain truncate flex-1">{selectedTask.name}</h3>
                            <button onClick={() => setSelectedTaskId(null)} className="text-slate-400 hover:text-slate-700 p-1 rounded-md hover:bg-slate-100 transition">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        </div>
                        {/* Tabs */}
                        <div className="flex border-b border-hui-border bg-white">
                            {(["details", "punch", "conversation"] as const).map(tab => (
                                <button key={tab} onClick={() => setPanelTab(tab)} className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider transition ${panelTab === tab ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-400 hover:text-slate-600"}`}>
                                    {tab === "punch" ? "Punch List" : tab === "conversation" ? "Comments" : "Details"}
                                </button>
                            ))}
                        </div>
                        {/* Tab Content */}
                        <div className="flex-1 overflow-y-auto p-4">
                            {panelTab === "details" && (
                                <div className="space-y-5">
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</label>
                                        <select value={selectedTask.status} onChange={e => handleStatusChange(selectedTask.id, e.target.value)} className="hui-input text-sm mt-1 w-full">
                                            {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                        </select>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Start</label><div className="text-sm font-medium text-hui-textMain mt-1">{selectedTask.startDate}</div></div>
                                        <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">End</label><div className="text-sm font-medium text-hui-textMain mt-1">{selectedTask.endDate}</div></div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estimated Hours</label>
                                        <input type="number" value={selectedTask.estimatedHours ?? ""} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, estimatedHours: v } : t)); updateScheduleTask(selectedTask.id, { estimatedHours: v }); }}} className="hui-input text-sm mt-1 w-full" placeholder="e.g. 40" />
                                    </div>
                                    {/* Assigned Members */}
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned Members</label>
                                            <div className="relative">
                                                <button onClick={() => setShowAssignMenu(!showAssignMenu)} className="text-[10px] text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Add</button>
                                                {showAssignMenu && (
                                                    <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[200px] py-1 animate-in fade-in max-h-48 overflow-y-auto">
                                                        {teamMembers.filter(m => !(selectedTask.assignments || []).some(a => a.userId === m.id)).map(m => (
                                                            <button key={m.id} onClick={() => handleAssign(m.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold flex items-center justify-center">{getInitials(m.name, m.email)}</div>
                                                                {m.name || m.email}
                                                            </button>
                                                        ))}
                                                        {teamMembers.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No team members found</div>}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="space-y-1.5">
                                            {(selectedTask.assignments || []).map(a => (
                                                <div key={a.userId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                                                    <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center">{getInitials(a.user.name, a.user.email)}</div>
                                                    <span className="text-xs font-medium text-hui-textMain flex-1">{a.user.name || a.user.email}</span>
                                                    <button onClick={() => handleUnassign(a.userId)} className="text-slate-300 hover:text-red-500 transition">
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                    </button>
                                                </div>
                                            ))}
                                            {(selectedTask.assignments || []).length === 0 && <p className="text-xs text-slate-400 italic">No members assigned</p>}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {panelTab === "punch" && (
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                        <button onClick={handleAiPunchlist} disabled={isAiPunching} className={`text-xs flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-medium transition border ${isAiPunching ? "bg-purple-100 text-purple-700 border-purple-300 animate-pulse" : "bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100"}`}>
                                            ✨ {isAiPunching ? "Generating..." : "AI Punchlist"}
                                        </button>
                                        <span className="text-[10px] text-slate-400">{punchItems.filter(p => p.completed).length}/{punchItems.length} done</span>
                                    </div>
                                    {punchItems.map(item => (
                                        <div key={item.id} className="flex items-start gap-2 group">
                                            <button onClick={() => handleTogglePunch(item.id)} className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center transition shrink-0 ${item.completed ? "bg-green-500 border-green-500 text-white" : "border-slate-300 hover:border-green-400"}`}>
                                                {item.completed && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                                            </button>
                                            <span className={`text-xs flex-1 ${item.completed ? "line-through text-slate-400" : "text-hui-textMain"}`}>{item.name}</span>
                                            <button onClick={() => handleDeletePunch(item.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
                                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                    <div className="flex gap-2 mt-2">
                                        <input value={newPunchName} onChange={e => setNewPunchName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddPunch(); }} className="hui-input text-xs flex-1" placeholder="Add punch item..." />
                                        <button onClick={handleAddPunch} className="hui-btn hui-btn-primary text-xs px-2">+</button>
                                    </div>
                                </div>
                            )}

                            {panelTab === "conversation" && (
                                <div className="space-y-3">
                                    {comments.length === 0 && <p className="text-xs text-slate-400 italic text-center py-4">No comments yet</p>}
                                    {comments.map(c => (
                                        <div key={c.id} className="flex gap-2">
                                            <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold flex items-center justify-center shrink-0 mt-0.5">{getInitials(c.user.name, c.user.email)}</div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2"><span className="text-xs font-semibold text-hui-textMain">{c.user.name || c.user.email}</span><span className="text-[9px] text-slate-400">{new Date(c.createdAt).toLocaleDateString()}</span></div>
                                                <p className="text-xs text-hui-textMuted mt-0.5">{c.text}</p>
                                            </div>
                                        </div>
                                    ))}
                                    <div className="flex gap-2 mt-3 pt-3 border-t border-hui-border">
                                        <input value={newComment} onChange={e => setNewComment(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddComment(); }} className="hui-input text-xs flex-1" placeholder="Add a comment..." />
                                        <button onClick={handleAddComment} className="hui-btn hui-btn-primary text-xs px-3">Send</button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
