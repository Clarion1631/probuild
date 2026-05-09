"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
    createScheduleTask, updateScheduleTask, deleteScheduleTask,
    importEstimateToSchedule, linkTasks, unlinkTasks, clearAllTasks,
    aiGenerateSchedule,
    addTaskComment, getTaskComments, addTaskPunchItem, togglePunchItem,
    deletePunchItem, getTaskPunchItems, aiGeneratePunchlist,
    assignUserToTask, unassignUserFromTask, assignSubToTask, unassignSubFromTask,
    getEstimateItemsForProject,
    toggleSchedulePublished, getPortalVisibility,
} from "@/lib/actions";
import { toast } from "sonner";
import type { Task, EstimateSummary, EstimateItemSummary, TeamMember, Subcontractor, PunchItem, Comment } from "./schedule-types";
import { STATUS_OPTIONS, STATUS_COLORS, PRESET_COLORS, getDaysBetween, addDays, formatDate, getInitials, formatCurrency, computeCriticalPath } from "./schedule-utils";
import TaskDetailPanel from "./TaskDetailPanel";

type SortKey = "name" | "type" | "startDate" | "endDate" | "duration" | "status" | "progress" | "estimatedHours" | "actualHours";

export default function TableView({ projectId, projectName, initialTasks, estimates = [], teamMembers = [], subcontractors = [], currentUserId = "system", viewMode, onViewModeChange }: {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
    estimates?: EstimateSummary[];
    teamMembers?: TeamMember[];
    subcontractors?: Subcontractor[];
    currentUserId?: string;
    viewMode?: "gantt" | "table";
    onViewModeChange?: (mode: "gantt" | "table") => void;
}) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [panelTab, setPanelTab] = useState<"details" | "punch" | "conversation">("details");
    const [punchItems, setPunchItems] = useState<PunchItem[]>([]);
    const [comments, setComments] = useState<Comment[]>([]);
    const [isAiPunching, setIsAiPunching] = useState(false);
    const [estimateItems, setEstimateItems] = useState<EstimateItemSummary[]>([]);
    const [isPublished, setIsPublished] = useState(false);
    const [isPublishing, setIsPublishing] = useState(false);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [showAiMenu, setShowAiMenu] = useState(false);
    const [isAiRisk, setIsAiRisk] = useState(false);
    const [showRiskPanel, setShowRiskPanel] = useState(false);
    const [riskAnalysis, setRiskAnalysis] = useState<string | null>(null);
    const [linkMode, setLinkMode] = useState<string | null>(null);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [showImportMenu, setShowImportMenu] = useState(false);
    const [showCriticalPath, setShowCriticalPath] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [showNewTaskForm, setShowNewTaskForm] = useState(false);
    const [newTaskType, setNewTaskType] = useState<"task" | "milestone">("task");
    const [newTaskName, setNewTaskName] = useState("");
    const [newTaskStart, setNewTaskStart] = useState("");
    const [newTaskEnd, setNewTaskEnd] = useState("");
    const [sortKey, setSortKey] = useState<SortKey | null>(null);
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
    const [editingCell, setEditingCell] = useState<{ taskId: string; field: string } | null>(null);
    const [editValue, setEditValue] = useState("");
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const editRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
    const tasksRef = useRef(tasks);
    useEffect(() => { tasksRef.current = tasks; });

    const selectedTask = tasks.find(t => t.id === selectedTaskId);
    const criticalPathIds = useMemo(() => computeCriticalPath(tasks), [tasks]);
    const today = new Date();

    useEffect(() => { getPortalVisibility(projectId).then(v => setIsPublished(v.showSchedule)); }, [projectId]);

    useEffect(() => {
        if (selectedTaskId) {
            getTaskPunchItems(selectedTaskId).then(items => setPunchItems(items as any));
            getTaskComments(selectedTaskId).then(c => setComments(c.map((x: any) => ({ ...x, createdAt: x.createdAt.toISOString?.() || x.createdAt }))));
        }
    }, [selectedTaskId]);

    useEffect(() => { if (editRef.current) editRef.current.focus(); }, [editingCell]);

    // --- Sorting ---
    function handleSort(key: SortKey) {
        if (sortKey === key) { setSortDir(d => d === "asc" ? "desc" : "asc"); }
        else { setSortKey(key); setSortDir("asc"); }
    }
    const sortedTasks = useMemo(() => {
        if (!sortKey) return tasks;
        return [...tasks].sort((a, b) => {
            let cmp = 0;
            if (sortKey === "duration") {
                cmp = getDaysBetween(new Date(a.startDate), new Date(a.endDate)) - getDaysBetween(new Date(b.startDate), new Date(b.endDate));
            } else if (sortKey === "progress" || sortKey === "actualHours") {
                cmp = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
            } else if (sortKey === "estimatedHours") {
                cmp = (a.estimatedHours ?? 0) - (b.estimatedHours ?? 0);
            } else {
                const va = String(a[sortKey] ?? "");
                const vb = String(b[sortKey] ?? "");
                cmp = va.localeCompare(vb);
            }
            return sortDir === "asc" ? cmp : -cmp;
        });
    }, [tasks, sortKey, sortDir]);

    // --- Toolbar handlers (same as GanttChart) ---
    async function handleTogglePublish() {
        setIsPublishing(true);
        try {
            const next = !isPublished;
            await toggleSchedulePublished(projectId, next);
            setIsPublished(next);
            toast.success(next ? "Schedule published to client portal" : "Schedule hidden from client portal");
        } catch { toast.error("Failed to update publish status"); }
        finally { setIsPublishing(false); }
    }

    async function handleAiSchedule(estimateId?: string) {
        setIsAiGenerating(true); setShowAiMenu(false);
        try {
            const created = await aiGenerateSchedule(projectId, estimateId);
            const newTasks: Task[] = created.map((t: any) => ({
                id: t.id, name: t.name,
                startDate: new Date(t.startDate).toISOString().split("T")[0],
                endDate: new Date(t.endDate).toISOString().split("T")[0],
                color: t.color, progress: 0, status: t.status, type: "task",
                assignee: null, order: t.order, estimatedHours: t.estimatedHours, actualHours: 0,
                dependencies: [], dependents: [], assignments: [], estimateItemId: null, estimateItem: null,
            }));
            setTasks(prev => [...prev, ...newTasks]);
            toast.success(`AI generated ${newTasks.length} tasks`);
        } catch (e: any) { toast.error(e.message || "AI schedule generation failed"); }
        finally { setIsAiGenerating(false); }
    }

    async function handleAiRisk() {
        setIsAiRisk(true);
        try {
            const res = await fetch("/api/ai/schedule-risk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, tasks }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Risk analysis failed");
            setRiskAnalysis(data.analysis); setShowRiskPanel(true);
        } catch (e: any) { toast.error(e.message || "Schedule risk analysis failed"); }
        finally { setIsAiRisk(false); }
    }

    async function handleImportEstimate(estimateId: string) {
        setIsImporting(true); setShowImportMenu(false);
        try {
            const newTasks = await importEstimateToSchedule(projectId, estimateId);
            setTasks(prev => [...prev, ...newTasks.map((t: any) => ({ ...t, startDate: formatDate(new Date(t.startDate)), endDate: formatDate(new Date(t.endDate)), type: "task" as const, actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [], estimateItemId: t.estimateItemId || null, estimateItem: null }))]);
            toast.success(`Imported ${newTasks.length} tasks`);
        } catch { toast.error("Import failed"); } finally { setIsImporting(false); }
    }

    // --- Task CRUD ---
    function openNewTaskForm(type: "task" | "milestone") {
        setNewTaskType(type);
        setNewTaskName(type === "milestone" ? "New Milestone" : "New Task");
        setNewTaskStart(formatDate(today));
        setNewTaskEnd(type === "milestone" ? formatDate(today) : formatDate(addDays(today, 5)));
        setShowNewTaskForm(true);
    }

    async function handleAddTask() {
        if (!newTaskName.trim()) { toast.error("Name is required"); return; }
        if (!newTaskStart || (newTaskType !== "milestone" && !newTaskEnd)) { toast.error("Dates are required"); return; }
        if (newTaskType !== "milestone" && newTaskStart > newTaskEnd) { toast.error("End date must be on or after start date"); return; }
        setIsAdding(true);
        try {
            const start = newTaskStart;
            const end = newTaskType === "milestone" ? start : newTaskEnd;
            const task = await createScheduleTask(projectId, { name: newTaskName.trim(), startDate: start, endDate: end, type: newTaskType });
            setTasks(prev => [...prev, { ...task, startDate: start, endDate: end, type: newTaskType, actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [], estimateItemId: null, estimateItem: null }]);
            toast.success(newTaskType === "milestone" ? "Milestone added" : "Task added");
            setShowNewTaskForm(false);
        } finally { setIsAdding(false); }
    }

    async function cascadeDependents(taskId: string, dayDelta: number) {
        const deps = tasksRef.current.filter(t => t.dependencies.some(d => d.predecessorId === taskId));
        for (const dep of deps) {
            const ns = formatDate(addDays(new Date(dep.startDate), dayDelta));
            const ne = dep.type === "milestone" ? ns : formatDate(addDays(new Date(dep.endDate), dayDelta));
            setTasks(prev => prev.map(t => t.id === dep.id ? { ...t, startDate: ns, endDate: ne } : t));
            await updateScheduleTask(dep.id, { startDate: ns, endDate: ne });
            await cascadeDependents(dep.id, dayDelta);
        }
    }

    async function handleStatusChange(taskId: string, status: string) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t)); await updateScheduleTask(taskId, { status }); }
    async function handleDateChange(taskId: string, field: "startDate" | "endDate", value: string) {
        if (!value) return;
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        if (task.type === "milestone") {
            const oldStart = task.startDate;
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, startDate: value, endDate: value } : t));
            await updateScheduleTask(taskId, { startDate: value, endDate: value });
            if (value !== oldStart) {
                const dayDelta = getDaysBetween(new Date(oldStart), new Date(value));
                if (dayDelta !== 0) await cascadeDependents(taskId, dayDelta);
            }
            return;
        }
        if (field === "startDate" && value > task.endDate) { toast.error("Start must be before end"); return; }
        if (field === "endDate" && value < task.startDate) { toast.error("End must be after start"); return; }
        const oldStart = task.startDate;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, [field]: value } : t));
        await updateScheduleTask(taskId, { [field]: value });
        if (field === "startDate" && value !== oldStart) {
            const dayDelta = getDaysBetween(new Date(oldStart), new Date(value));
            if (dayDelta !== 0) await cascadeDependents(taskId, dayDelta);
        }
    }
    async function handleDelete(taskId: string) { setTasks(prev => prev.filter(t => t.id !== taskId)); if (selectedTaskId === taskId) setSelectedTaskId(null); await deleteScheduleTask(taskId); toast.success("Task deleted"); }
    async function handleColorChange(taskId: string, color: string) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color } : t)); setColorPickerId(null); await updateScheduleTask(taskId, { color }); }
    async function handleProgressChange(taskId: string, progress: number) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress } : t)); await updateScheduleTask(taskId, { progress }); }

    // --- Inline editing ---
    function startEdit(taskId: string, field: string, currentValue: string) {
        setEditingCell({ taskId, field }); setEditValue(currentValue);
    }
    async function commitEdit() {
        if (!editingCell) return;
        const { taskId, field } = editingCell;
        if (field === "name" && editValue.trim()) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: editValue.trim() } : t));
            await updateScheduleTask(taskId, { name: editValue.trim() });
        } else if (field === "estimatedHours") {
            const h = parseFloat(editValue);
            if (!isNaN(h) && h >= 0) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: h } : t));
                await updateScheduleTask(taskId, { estimatedHours: h });
            }
        }
        setEditingCell(null);
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

    // --- Estimate linking ---
    async function handleLinkEstimateItem(taskId: string, item: EstimateItemSummary) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimateItemId: item.id, estimateItem: item } : t));
        await updateScheduleTask(taskId, { estimateItemId: item.id });
        toast.success("Linked to estimate item");
    }
    async function handleUnlinkEstimateItem(taskId: string) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimateItemId: null, estimateItem: null } : t));
        await updateScheduleTask(taskId, { estimateItemId: null });
        toast.success("Estimate link removed");
    }

    // --- Detail Panel handlers ---
    async function handleAddPunch(name: string) {
        if (!name || !selectedTaskId) return;
        const item = await addTaskPunchItem(selectedTaskId, name);
        setPunchItems(prev => [...prev, item as any]);
    }
    async function handleTogglePunch(id: string) { await togglePunchItem(id); setPunchItems(prev => prev.map(p => p.id === id ? { ...p, completed: !p.completed } : p)); }
    async function handleDeletePunch(id: string) { await deletePunchItem(id); setPunchItems(prev => prev.filter(p => p.id !== id)); }
    async function handleAiPunchlist() {
        if (!selectedTaskId) return;
        setIsAiPunching(true);
        try { const items = await aiGeneratePunchlist(selectedTaskId); setPunchItems(prev => [...prev, ...(items as any)]); toast.success(`AI generated ${items.length} punch items`); }
        catch { toast.error("AI punchlist failed"); } finally { setIsAiPunching(false); }
    }
    async function handleAddComment(text: string) {
        if (!text || !selectedTaskId) return;
        try { const comment = await addTaskComment(selectedTaskId, currentUserId, text); setComments(prev => [...prev, { ...(comment as any), createdAt: new Date().toISOString() }]); }
        catch { toast.error("Failed to add comment"); }
    }
    async function handleAssign(userId: string) {
        if (!selectedTaskId) return;
        try { const a = await assignUserToTask(selectedTaskId, userId); setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: [...(t.assignments || []), a as any] } : t)); toast.success("Member assigned"); }
        catch { toast.error("Already assigned"); }
    }
    async function handleUnassign(userId: string) {
        if (!selectedTaskId) return;
        await unassignUserFromTask(selectedTaskId, userId);
        setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: (t.assignments || []).filter(a => a.userId !== userId) } : t));
    }
    async function handleAssignSub(subId: string) {
        if (!selectedTaskId) return;
        try { const a = await assignSubToTask(selectedTaskId, subId); setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, subAssignments: [...(t.subAssignments || []), a as any] } : t)); toast.success("Subcontractor assigned"); }
        catch { toast.error("Already assigned"); }
    }
    async function handleUnassignSub(subId: string) {
        if (!selectedTaskId) return;
        await unassignSubFromTask(selectedTaskId, subId);
        setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, subAssignments: (t.subAssignments || []).filter(a => a.subcontractorId !== subId) } : t));
    }

    // --- Sort header helper ---
    function SortHeader({ label, sortable, field }: { label: string; sortable: boolean; field?: SortKey }) {
        if (!sortable || !field) return <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>;
        return (
            <button onClick={() => handleSort(field)} className="text-[10px] font-bold text-slate-400 uppercase tracking-wider hover:text-slate-600 transition flex items-center gap-1 group">
                {label}
                <span className={`transition ${sortKey === field ? "text-indigo-500" : "text-slate-300 opacity-0 group-hover:opacity-100"}`}>
                    {sortKey === field && sortDir === "desc" ? "▼" : "▲"}
                </span>
            </button>
        );
    }

    // --- EMPTY STATE ---
    if (tasks.length === 0) {
        return (
            <div className="flex flex-col h-full">
                {/* Minimal toolbar with view toggle */}
                {onViewModeChange && (
                    <div className="bg-white border-b border-hui-border shrink-0 z-20 relative">
                        <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
                        <div className="px-6 py-3 flex items-center justify-between">
                            <div><h1 className="text-lg font-bold text-hui-textMain">Schedule</h1><span className="text-xs text-hui-textMuted">0 tasks</span></div>
                            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                                <button onClick={() => onViewModeChange("gantt")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "gantt" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="6" y="10" width="12" height="4" rx="1"/><rect x="3" y="16" width="15" height="4" rx="1"/></svg>Gantt
                                </button>
                                <button onClick={() => onViewModeChange("table")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "table" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><path d="M3 6h18M3 12h18M3 18h18"/><path d="M9 6v12"/></svg>Table
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 gap-6 py-20">
                    <div className="relative">
                        <div className="w-20 h-20 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-100/50">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="url(#tgrad)" strokeWidth="1.5">
                                <defs><linearGradient id="tgrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#6366f1"/><stop offset="100%" stopColor="#8b5cf6"/></linearGradient></defs>
                                <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
                            </svg>
                        </div>
                        <div className="absolute -right-1 -top-1 w-6 h-6 bg-amber-400 rounded-full flex items-center justify-center shadow-md"><span className="text-[10px]">📋</span></div>
                    </div>
                    <div className="text-center">
                        <h2 className="text-xl font-bold text-hui-textMain">Build your schedule</h2>
                        <p className="text-sm text-hui-textMuted mt-2 max-w-md">Add tasks manually, import from an estimate, or let AI generate a smart schedule with dependencies.</p>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap justify-center">
                        <button onClick={() => openNewTaskForm("task")} className="hui-btn hui-btn-primary" disabled={isAdding}>+ Add First Task</button>
                        <div className="relative">
                            <button onClick={() => estimates.length > 0 ? setShowAiMenu(!showAiMenu) : handleAiSchedule()} disabled={isAiGenerating}
                                className="hui-btn hui-btn-secondary bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 flex items-center gap-2"
                            >✨ {isAiGenerating ? "Generating..." : "AI Schedule"}</button>
                            {showAiMenu && estimates.length > 0 && (
                                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[260px] py-1 animate-in fade-in">
                                    <button onClick={() => handleAiSchedule()} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>🧠</span> General Schedule</button>
                                    {estimates.map(est => (
                                        <button key={est.id} onClick={() => handleAiSchedule(est.id)} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>📋</span> {est.title}</button>
                                    ))}
                                </div>
                            )}
                        </div>
                        {estimates.length > 0 && (
                            <div className="relative">
                                <button onClick={() => setShowImportMenu(!showImportMenu)} disabled={isImporting} className="hui-btn hui-btn-secondary flex items-center gap-2">{isImporting ? "Importing..." : "📋 Import"}</button>
                                {showImportMenu && (
                                    <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] py-1 animate-in fade-in">
                                        {estimates.map(est => (<button key={est.id} onClick={() => handleImportEstimate(est.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm">{est.title}</button>))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
                {/* New task form modal */}
                {showNewTaskForm && (
                    <div className="fixed inset-0 z-[200] flex items-center justify-center">
                        <div className="fixed inset-0 bg-black/40" onClick={() => setShowNewTaskForm(false)} />
                        <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
                            <h3 className="text-sm font-bold text-hui-textMain mb-4">{newTaskType === "milestone" ? "New Milestone" : "New Task"}</h3>
                            <div className="space-y-3">
                                <input value={newTaskName} onChange={e => setNewTaskName(e.target.value)} className="hui-input text-sm w-full" placeholder="Task name" autoFocus />
                                <div className="grid grid-cols-2 gap-3">
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Start</label><input type="date" value={newTaskStart} onChange={e => setNewTaskStart(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>
                                    {newTaskType !== "milestone" && <div><label className="text-[10px] font-bold text-slate-400 uppercase">End</label><input type="date" value={newTaskEnd} onChange={e => setNewTaskEnd(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>}
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 mt-5">
                                <button onClick={() => setShowNewTaskForm(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                                <button onClick={handleAddTask} disabled={isAdding} className="hui-btn hui-btn-primary text-xs">{isAdding ? "Adding..." : "Add"}</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const completedCount = tasks.filter(t => t.status === "Complete").length;
    const progressPct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="bg-white border-b border-hui-border shrink-0 z-20 relative">
                <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
                <div className="px-6 py-3 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-4">
                        <div>
                            <h1 className="text-lg font-bold text-hui-textMain">Schedule</h1>
                            <div className="flex items-center gap-3 mt-0.5">
                                <span className="text-xs text-hui-textMuted">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
                                <span className="text-xs text-hui-textMuted">·</span>
                                <span className="text-xs text-green-600 font-medium">{completedCount} done</span>
                                <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
                                </div>
                                <span className="text-[10px] text-slate-400 font-medium">{progressPct}%</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        {onViewModeChange && (
                            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                                <button onClick={() => onViewModeChange("gantt")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "gantt" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="6" y="10" width="12" height="4" rx="1"/><rect x="3" y="16" width="15" height="4" rx="1"/></svg>Gantt
                                </button>
                                <button onClick={() => onViewModeChange("table")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "table" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1"><path d="M3 6h18M3 12h18M3 18h18"/><path d="M9 6v12"/></svg>Table
                                </button>
                            </div>
                        )}
                        <button onClick={() => setShowCriticalPath(v => !v)} className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${showCriticalPath ? "bg-red-50 text-red-700 border-red-300" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`} title="Highlight critical path">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>Critical Path
                        </button>
                        <button onClick={handleAiRisk} disabled={isAiRisk || tasks.length === 0} className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isAiRisk ? "bg-amber-500 text-white border-amber-600 animate-pulse" : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"}`} title="AI schedule risk analysis">
                            ⚠️ {isAiRisk ? "Analyzing…" : "AI Risk"}
                        </button>
                        <button onClick={handleTogglePublish} disabled={isPublishing} className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isPublished ? "bg-green-50 text-green-700 border-green-300" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`} title={isPublished ? "Schedule is visible to client — click to hide" : "Publish schedule to client portal"}>
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isPublished ? "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" : "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18"} /></svg>
                            {isPublishing ? "Updating…" : isPublished ? "Published" : "Publish to Client"}
                        </button>
                        <button onClick={() => { if (tasks.length === 0) { toast.error("No tasks to sync"); return; } const a = document.createElement("a"); a.href = `/api/calendar/sync?projectId=${projectId}`; a.download = "schedule.ics"; a.click(); toast.success("Calendar file downloaded"); }} disabled={tasks.length === 0} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 disabled:opacity-40" title="Download .ics file">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>Sync
                        </button>
                        <div className="relative">
                            <button onClick={() => estimates.length > 0 ? setShowAiMenu(!showAiMenu) : handleAiSchedule()} disabled={isAiGenerating}
                                className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isAiGenerating ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white border-purple-600 animate-pulse" : "bg-gradient-to-r from-purple-50 to-indigo-50 text-purple-700 border-purple-200 hover:shadow-md hover:from-purple-100 hover:to-indigo-100"}`}>
                                ✨ {isAiGenerating ? "AI thinking..." : "AI Schedule"}
                            </button>
                            {showAiMenu && estimates.length > 0 && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[260px] py-1 animate-in fade-in">
                                    <button onClick={() => handleAiSchedule()} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>🧠</span> General Schedule</button>
                                    {estimates.map(est => (<button key={est.id} onClick={() => handleAiSchedule(est.id)} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>📋</span> {est.title}</button>))}
                                </div>
                            )}
                        </div>
                        <button onClick={() => openNewTaskForm("task")} disabled={isAdding} className="hui-btn hui-btn-primary text-xs">+ Task</button>
                        <button onClick={() => openNewTaskForm("milestone")} disabled={isAdding} className="hui-btn hui-btn-secondary text-xs flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0L10.5 5.5L16 8L10.5 10.5L8 16L5.5 10.5L0 8L5.5 5.5Z"/></svg>Milestone
                        </button>
                        <div className="relative">
                            <button onClick={() => setShowMoreMenu(!showMoreMenu)} className="hui-btn hui-btn-secondary text-xs py-1.5 px-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                            </button>
                            {showMoreMenu && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[200px] py-1 animate-in fade-in">
                                    <button onClick={() => { setLinkMode(linkMode ? null : "__awaiting__"); setShowMoreMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                                        {linkMode ? "Cancel Linking" : "Link Tasks"}
                                    </button>
                                    {estimates.length > 0 && (
                                        <>
                                            <div className="border-t border-slate-100 my-1" />
                                            <div className="px-3 py-1 text-[10px] text-slate-400 uppercase font-semibold">Import from Estimate</div>
                                            {estimates.map(est => (<button key={est.id} onClick={() => { handleImportEstimate(est.id); setShowMoreMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">📋 {est.title}</button>))}
                                        </>
                                    )}
                                    <div className="border-t border-slate-100 my-1" />
                                    <button onClick={async () => { if (confirm('Delete ALL tasks from this schedule? This cannot be undone.')) { setShowMoreMenu(false); await clearAllTasks(projectId); setTasks([]); setSelectedTaskId(null); toast.success('Schedule cleared'); } }} className="w-full text-left px-3 py-2 hover:bg-red-50 transition text-sm flex items-center gap-2 text-red-600">🗑️ Clear All Tasks</button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {linkMode && (
                <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-xs text-amber-800">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span className="font-medium">{linkMode === "__awaiting__" ? "Click the predecessor task" : "Now click the dependent task"}</span>
                    <button onClick={() => setLinkMode(null)} className="ml-auto text-amber-600 hover:text-amber-800 text-xs font-medium">Cancel</button>
                </div>
            )}

            {/* Table + Detail panel */}
            <div className="flex flex-1 overflow-hidden">
                <div className="flex-1 overflow-auto">
                    <table className="w-full text-xs border-collapse min-w-[900px]">
                        <thead className="sticky top-0 bg-slate-50 z-10 border-b border-hui-border">
                            <tr>
                                <th className="w-8 px-2 py-2.5" />
                                <th className="text-left px-3 py-2.5 min-w-[200px]"><SortHeader label="Task Name" sortable field="name" /></th>
                                <th className="text-left px-3 py-2.5 w-20"><SortHeader label="Type" sortable field="type" /></th>
                                <th className="text-left px-3 py-2.5 w-28"><SortHeader label="Start" sortable field="startDate" /></th>
                                <th className="text-left px-3 py-2.5 w-28"><SortHeader label="End" sortable field="endDate" /></th>
                                <th className="text-left px-3 py-2.5 w-20"><SortHeader label="Duration" sortable field="duration" /></th>
                                <th className="text-left px-3 py-2.5 w-28"><SortHeader label="Status" sortable field="status" /></th>
                                <th className="text-left px-3 py-2.5 w-24"><SortHeader label="Progress" sortable field="progress" /></th>
                                <th className="text-left px-3 py-2.5 w-32"><SortHeader label="Assigned" sortable={false} /></th>
                                <th className="text-right px-3 py-2.5 w-20"><SortHeader label="Est. Hrs" sortable field="estimatedHours" /></th>
                                <th className="text-right px-3 py-2.5 w-20"><SortHeader label="Act. Hrs" sortable field="actualHours" /></th>
                                <th className="text-left px-3 py-2.5 w-24"><SortHeader label="Deps" sortable={false} /></th>
                                <th className="w-10 px-2 py-2.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {sortedTasks.map(task => {
                                const duration = getDaysBetween(new Date(task.startDate), new Date(task.endDate));
                                const isSelected = task.id === selectedTaskId;
                                const isCritical = showCriticalPath && criticalPathIds.has(task.id);
                                const isLinkSource = linkMode === task.id;
                                const progress = (task.estimatedHours && task.estimatedHours > 0 && task.actualHours > 0) ? Math.min(100, Math.round((task.actualHours / task.estimatedHours) * 100)) : task.progress;

                                return (
                                    <tr
                                        key={task.id}
                                        onClick={() => { if (linkMode) { if (linkMode === "__awaiting__") setLinkMode(task.id); else handleTaskClick(task.id); } else setSelectedTaskId(task.id); }}
                                        className={`border-b border-slate-100 cursor-pointer transition group hover:bg-slate-50 ${isSelected ? "bg-indigo-50/60 ring-1 ring-inset ring-indigo-200" : ""} ${isLinkSource ? "bg-amber-50" : ""} ${isCritical ? "border-l-3 border-l-red-500" : ""}`}
                                    >
                                        {/* Color dot */}
                                        <td className="px-2 py-2">
                                            <div className="relative">
                                                <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }} className="w-4 h-4 rounded-full border border-white shadow-sm" style={{ backgroundColor: task.color }} />
                                                {colorPickerId === task.id && (
                                                    <div className="absolute left-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 p-2 flex gap-1 animate-in fade-in" onClick={e => e.stopPropagation()}>
                                                        {PRESET_COLORS.map(c => (<button key={c} onClick={() => handleColorChange(task.id, c)} className="w-5 h-5 rounded-full border-2 transition hover:scale-110" style={{ backgroundColor: c, borderColor: c === task.color ? "#1e293b" : "transparent" }} />))}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        {/* Name */}
                                        <td className="px-3 py-2">
                                            {editingCell?.taskId === task.id && editingCell.field === "name" ? (
                                                <input ref={editRef as any} value={editValue} onChange={e => setEditValue(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingCell(null); }} className="hui-input text-xs w-full py-0.5" onClick={e => e.stopPropagation()} />
                                            ) : (
                                                <div className="flex items-center gap-1.5" onDoubleClick={e => { e.stopPropagation(); startEdit(task.id, "name", task.name); }}>
                                                    {task.type === "milestone" && <div className="w-2.5 h-2.5 rotate-45 shrink-0" style={{ backgroundColor: task.color }} />}
                                                    <span className="font-medium text-hui-textMain truncate">{task.name}</span>
                                                    {task.estimateItem && <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded font-semibold shrink-0">$</span>}
                                                </div>
                                            )}
                                        </td>
                                        {/* Type */}
                                        <td className="px-3 py-2">
                                            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${task.type === "milestone" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                                                {task.type === "milestone" ? "Mile." : "Task"}
                                            </span>
                                        </td>
                                        {/* Start Date */}
                                        <td className="px-3 py-2">
                                            <input type="date" value={task.startDate} onChange={e => { e.stopPropagation(); handleDateChange(task.id, "startDate", e.target.value); }} onClick={e => e.stopPropagation()} className="bg-transparent text-xs text-hui-textMain cursor-pointer hover:text-indigo-600 transition w-full border-0 p-0 focus:ring-0" />
                                        </td>
                                        {/* End Date */}
                                        <td className="px-3 py-2">
                                            {task.type === "milestone" ? (
                                                <span className="text-slate-300">—</span>
                                            ) : (
                                                <input type="date" value={task.endDate} onChange={e => { e.stopPropagation(); handleDateChange(task.id, "endDate", e.target.value); }} onClick={e => e.stopPropagation()} className="bg-transparent text-xs text-hui-textMain cursor-pointer hover:text-indigo-600 transition w-full border-0 p-0 focus:ring-0" />
                                            )}
                                        </td>
                                        {/* Duration */}
                                        <td className="px-3 py-2 text-hui-textMuted">{task.type === "milestone" ? "0d" : `${duration}d`}</td>
                                        {/* Status */}
                                        <td className="px-3 py-2">
                                            <select value={task.status} onChange={e => { e.stopPropagation(); handleStatusChange(task.id, e.target.value); }} onClick={e => e.stopPropagation()} className={`text-[10px] font-semibold px-2 py-1 rounded-full border-0 cursor-pointer ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-600"}`}>
                                                {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                            </select>
                                        </td>
                                        {/* Progress */}
                                        <td className="px-3 py-2">
                                            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                                <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                    <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, backgroundColor: task.color + "cc" }} />
                                                </div>
                                                <span className="text-[10px] text-slate-500 w-7 text-right">{progress}%</span>
                                            </div>
                                        </td>
                                        {/* Assigned */}
                                        <td className="px-3 py-2">
                                            <div className="flex -space-x-1.5">
                                                {(task.assignments || []).slice(0, 3).map(a => (
                                                    <div key={a.userId} className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold flex items-center justify-center border-2 border-white" title={a.user.name || a.user.email}>{getInitials(a.user.name, a.user.email)}</div>
                                                ))}
                                                {(task.subAssignments || []).slice(0, 2).map(a => (
                                                    <div key={a.subcontractorId} className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[8px] font-bold flex items-center justify-center border-2 border-white" title={a.subcontractor.companyName}>{a.subcontractor.companyName.substring(0, 2).toUpperCase()}</div>
                                                ))}
                                                {((task.assignments || []).length + (task.subAssignments || []).length) > 5 && (
                                                    <div className="w-6 h-6 rounded-full bg-slate-200 text-slate-600 text-[8px] font-bold flex items-center justify-center border-2 border-white">+{(task.assignments || []).length + (task.subAssignments || []).length - 5}</div>
                                                )}
                                            </div>
                                        </td>
                                        {/* Est. Hours */}
                                        <td className="px-3 py-2 text-right">
                                            {editingCell?.taskId === task.id && editingCell.field === "estimatedHours" ? (
                                                <input ref={editRef as any} type="number" value={editValue} onChange={e => setEditValue(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingCell(null); }} className="hui-input text-xs w-16 py-0.5 text-right" onClick={e => e.stopPropagation()} />
                                            ) : (
                                                <span className="text-hui-textMuted cursor-pointer hover:text-indigo-600" onDoubleClick={e => { e.stopPropagation(); startEdit(task.id, "estimatedHours", String(task.estimatedHours ?? "")); }}>
                                                    {task.estimatedHours != null ? `${task.estimatedHours}h` : "—"}
                                                </span>
                                            )}
                                        </td>
                                        {/* Act. Hours */}
                                        <td className="px-3 py-2 text-right text-hui-textMuted">{task.actualHours > 0 ? `${task.actualHours.toFixed(1)}h` : "—"}</td>
                                        {/* Dependencies */}
                                        <td className="px-3 py-2">
                                            {task.dependencies.length > 0 ? (
                                                <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">{task.dependencies.length} dep{task.dependencies.length !== 1 ? "s" : ""}</span>
                                            ) : (
                                                <span className="text-slate-300">—</span>
                                            )}
                                        </td>
                                        {/* Actions */}
                                        <td className="px-2 py-2">
                                            <button onClick={e => { e.stopPropagation(); if (confirm("Delete this task?")) handleDelete(task.id); }} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition p-1">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Detail Panel */}
                {selectedTask && !linkMode && (
                    <TaskDetailPanel
                        task={selectedTask}
                        onClose={() => setSelectedTaskId(null)}
                        panelTab={panelTab}
                        setPanelTab={setPanelTab}
                        onStatusChange={handleStatusChange}
                        onNameChange={(taskId, name) => { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name } : t)); updateScheduleTask(taskId, { name }); }}
                        onDateChange={handleDateChange}
                        onEstimatedHoursChange={(taskId, hours) => { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: hours } : t)); updateScheduleTask(taskId, { estimatedHours: hours }); }}
                        onDelete={handleDelete}
                        estimateItems={estimateItems}
                        onLinkEstimateItem={handleLinkEstimateItem}
                        onUnlinkEstimateItem={handleUnlinkEstimateItem}
                        onFetchEstimateItems={() => { if (estimateItems.length === 0) getEstimateItemsForProject(projectId).then(items => setEstimateItems(items as any)); }}
                        teamMembers={teamMembers}
                        subcontractors={subcontractors}
                        onAssign={handleAssign}
                        onUnassign={handleUnassign}
                        onAssignSub={handleAssignSub}
                        onUnassignSub={handleUnassignSub}
                        punchItems={punchItems}
                        onAddPunch={handleAddPunch}
                        onTogglePunch={handleTogglePunch}
                        onDeletePunch={handleDeletePunch}
                        onAiPunchlist={handleAiPunchlist}
                        isAiPunching={isAiPunching}
                        comments={comments}
                        onAddComment={handleAddComment}
                        showCriticalPath={showCriticalPath}
                        criticalPathIds={criticalPathIds}
                    />
                )}
            </div>

            {/* New task form modal */}
            {showNewTaskForm && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center">
                    <div className="fixed inset-0 bg-black/40" onClick={() => setShowNewTaskForm(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
                        <h3 className="text-sm font-bold text-hui-textMain mb-4">{newTaskType === "milestone" ? "New Milestone" : "New Task"}</h3>
                        <div className="space-y-3">
                            <input value={newTaskName} onChange={e => setNewTaskName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddTask(); }} className="hui-input text-sm w-full" placeholder="Task name" autoFocus />
                            <div className="grid grid-cols-2 gap-3">
                                <div><label className="text-[10px] font-bold text-slate-400 uppercase">Start</label><input type="date" value={newTaskStart} onChange={e => setNewTaskStart(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>
                                {newTaskType !== "milestone" && <div><label className="text-[10px] font-bold text-slate-400 uppercase">End</label><input type="date" value={newTaskEnd} onChange={e => setNewTaskEnd(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 mt-5">
                            <button onClick={() => setShowNewTaskForm(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                            <button onClick={handleAddTask} disabled={isAdding} className="hui-btn hui-btn-primary text-xs">{isAdding ? "Adding..." : "Add"}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* AI Risk Analysis panel */}
            {showRiskPanel && riskAnalysis && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center">
                    <div className="fixed inset-0 bg-black/40" onClick={() => setShowRiskPanel(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
                        <div className="flex items-center justify-between p-5 border-b border-hui-border">
                            <div className="flex items-center gap-2"><span className="text-xl">⚠️</span><h2 className="font-bold text-hui-textMain text-lg">Schedule Risk Analysis</h2></div>
                            <button onClick={() => setShowRiskPanel(false)} className="text-hui-textMuted hover:text-hui-textMain"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1"><div className="prose prose-sm max-w-none text-hui-textMain whitespace-pre-wrap text-sm leading-relaxed">{riskAnalysis}</div></div>
                        <div className="p-4 border-t border-hui-border"><button onClick={() => setShowRiskPanel(false)} className="hui-btn hui-btn-secondary text-sm">Close</button></div>
                    </div>
                </div>
            )}
        </div>
    );
}
