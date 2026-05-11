"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import {
    createScheduleTask, updateScheduleTask, deleteScheduleTask,
    importEstimateToSchedule, linkTasks, unlinkTasks, clearAllTasks,
    reorderScheduleTasks,
    aiGenerateSchedule,
    addTaskComment, getTaskComments, addTaskPunchItem, togglePunchItem,
    deletePunchItem, getTaskPunchItems, aiGeneratePunchlist,
    assignUserToTask, unassignUserFromTask, assignSubToTask, unassignSubFromTask,
    getEstimateItemsForProject,
} from "@/lib/actions";
import { toast } from "sonner";
import type { Task, EstimateSummary, EstimateItemSummary, TeamMember, Subcontractor, PunchItem, Comment, SortKey, SortDir, FilterState } from "./schedule-types";
import { STATUS_OPTIONS, STATUS_COLORS, PRESET_COLORS, getDaysBetween, addDays, formatDate, getInitials, formatCurrency, computeCriticalPath } from "./schedule-utils";
import TaskDetailPanel from "./TaskDetailPanel";
import DependencyPicker from "./DependencyPicker";
import SchedulePublishButton from "./SchedulePublishButton";

// 14-column grid: drag handle | color | name | type | start | end | dur | status | progress | assigned | est hrs | act hrs | deps | actions
const GRID_COLS = "24px 32px minmax(200px,1fr) 70px 120px 120px 70px 110px 100px 130px 80px 80px 90px 40px";

const SORT_OPTIONS: { key: SortKey; dir: SortDir; label: string }[] = [
    { key: "manual", dir: "asc", label: "Manual order" },
    { key: "startDate", dir: "asc", label: "Start date ↑" },
    { key: "startDate", dir: "desc", label: "Start date ↓" },
    { key: "endDate", dir: "asc", label: "End date ↑" },
    { key: "endDate", dir: "desc", label: "End date ↓" },
    { key: "status", dir: "asc", label: "Status (A → Z)" },
    { key: "progress", dir: "desc", label: "Progress (most done)" },
    { key: "progress", dir: "asc", label: "Progress (least done)" },
    { key: "duration", dir: "desc", label: "Duration (longest)" },
    { key: "duration", dir: "asc", label: "Duration (shortest)" },
    { key: "name", dir: "asc", label: "Name (A → Z)" },
    { key: "name", dir: "desc", label: "Name (Z → A)" },
];

export default function TableView({ projectId, projectName, initialTasks, estimates = [], teamMembers = [], subcontractors = [], initialPublished, viewMode, onViewModeChange }: {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
    estimates?: EstimateSummary[];
    teamMembers?: TeamMember[];
    subcontractors?: Subcontractor[];
    initialPublished: boolean;
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
    // URL-driven sort + filter state
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const VALID_SORT_KEYS = useMemo(() => new Set<SortKey>(["manual", "name", "type", "startDate", "endDate", "duration", "status", "progress", "estimatedHours", "actualHours"]), []);
    const VALID_TYPES = useMemo(() => new Set<FilterState["type"]>(["all", "task", "milestone"]), []);
    const sortKeyRaw = searchParams.get("sort") as SortKey | null;
    const sortKey: SortKey = sortKeyRaw && VALID_SORT_KEYS.has(sortKeyRaw) ? sortKeyRaw : "startDate";
    const sortDirRaw = searchParams.get("dir");
    const sortDir: SortDir = sortDirRaw === "desc" ? "desc" : "asc";
    const filters: FilterState = useMemo(() => {
        const typeRaw = searchParams.get("type") as FilterState["type"] | null;
        return {
            q: searchParams.get("q") || "",
            statuses: searchParams.getAll("status"),
            type: typeRaw && VALID_TYPES.has(typeRaw) ? typeRaw : "all",
            assignee: searchParams.get("assignee"),
            startFrom: searchParams.get("from"),
            startTo: searchParams.get("to"),
        };
    }, [searchParams, VALID_TYPES]);
    const filtersActive = !!(filters.q || filters.statuses.length > 0 || filters.type !== "all" || filters.assignee || filters.startFrom || filters.startTo);
    const canDrag = sortKey === "manual" && !filtersActive;
    const [searchInput, setSearchInput] = useState(filters.q);
    const [showFilterPopover, setShowFilterPopover] = useState(false);
    const [showSortMenu, setShowSortMenu] = useState(false);
    const [showSwitchHint, setShowSwitchHint] = useState(false);
    const [editingCell, setEditingCell] = useState<{ taskId: string; field: string } | null>(null);
    const [editValue, setEditValue] = useState("");
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [depsPopoverId, setDepsPopoverId] = useState<string | null>(null);
    const [depsPickerId, setDepsPickerId] = useState<string | null>(null);
    const editRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
    const tasksRef = useRef(tasks);
    useEffect(() => { tasksRef.current = tasks; });

    const selectedTask = tasks.find(t => t.id === selectedTaskId);
    const criticalPathIds = useMemo(() => computeCriticalPath(tasks), [tasks]);
    const today = new Date();

    useEffect(() => {
        if (selectedTaskId) {
            getTaskPunchItems(selectedTaskId).then(items => setPunchItems(items as any));
            getTaskComments(selectedTaskId).then(c => setComments(c.map((x: any) => ({ ...x, createdAt: x.createdAt.toISOString?.() || x.createdAt }))));
        }
    }, [selectedTaskId]);

    useEffect(() => { if (editRef.current) editRef.current.focus(); }, [editingCell]);

    // --- URL state helpers ---
    const updateUrl = useCallback((updates: Record<string, string | string[] | null>) => {
        const params = new URLSearchParams(searchParams.toString());
        for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
                params.delete(k);
            } else if (Array.isArray(v)) {
                params.delete(k);
                v.forEach(item => params.append(k, item));
            } else {
                params.set(k, v);
            }
        }
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, [pathname, router, searchParams]);

    function setSort(key: SortKey, dir: SortDir) {
        updateUrl({ sort: key, dir });
        setShowSortMenu(false);
    }
    function clearAllFilters() {
        updateUrl({ q: null, status: null, type: null, assignee: null, from: null, to: null });
        setSearchInput("");
    }
    function toggleStatusFilter(status: string) {
        const next = filters.statuses.includes(status)
            ? filters.statuses.filter(s => s !== status)
            : [...filters.statuses, status];
        updateUrl({ status: next });
    }

    // Sync local search input with URL (handles back/forward nav and external URL changes)
    useEffect(() => {
        setSearchInput(prev => prev === filters.q ? prev : filters.q);
    }, [filters.q]);

    // Debounced search → URL
    useEffect(() => {
        const t = setTimeout(() => {
            if (searchInput !== filters.q) updateUrl({ q: searchInput || null });
        }, 300);
        return () => clearTimeout(t);
    }, [searchInput, filters.q, updateUrl]);

    // --- Sorting ---
    function handleSort(key: SortKey) {
        if (sortKey === key) updateUrl({ sort: key, dir: sortDir === "asc" ? "desc" : "asc" });
        else updateUrl({ sort: key, dir: "asc" });
    }

    function compareTasks(a: Task, b: Task): number {
        if (sortKey === "manual") return a.order - b.order;
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
    }

    const filteredSortedTasks = useMemo(() => {
        let arr = tasks;
        if (filters.q) {
            const q = filters.q.toLowerCase();
            arr = arr.filter(t => t.name.toLowerCase().includes(q));
        }
        if (filters.statuses.length > 0) arr = arr.filter(t => filters.statuses.includes(t.status));
        if (filters.type !== "all") arr = arr.filter(t => t.type === filters.type);
        if (filters.assignee) {
            arr = arr.filter(t =>
                (t.assignments || []).some(a => a.userId === filters.assignee) ||
                (t.subAssignments || []).some(a => a.subcontractorId === filters.assignee)
            );
        }
        if (filters.startFrom) arr = arr.filter(t => t.startDate >= filters.startFrom!);
        if (filters.startTo) arr = arr.filter(t => t.startDate <= filters.startTo!);
        if (sortKey === "manual" && !filtersActive) {
            arr = [...arr].sort((a, b) => a.order - b.order);
        } else {
            arr = [...arr].sort(compareTasks);
        }
        return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tasks, filters, sortKey, sortDir, filtersActive]);

    // --- Drag and drop ---
    async function handleDragEnd(result: DropResult) {
        if (!result.destination || !canDrag) return;
        const srcIdx = result.source.index;
        const dstIdx = result.destination.index;
        if (srcIdx === dstIdx) return;

        const reordered = Array.from(filteredSortedTasks);
        const [moved] = reordered.splice(srcIdx, 1);
        reordered.splice(dstIdx, 0, moved);
        const newOrderIds = reordered.map(t => t.id);
        const newOrderMap = new Map(newOrderIds.map((id, idx) => [id, idx]));
        // Snapshot prior order values only, so rollback doesn't clobber concurrent edits
        const priorOrder = new Map(tasks.map(t => [t.id, t.order]));

        setTasks(p => p.map(t => newOrderMap.has(t.id) ? { ...t, order: newOrderMap.get(t.id)! } : t));
        try {
            await reorderScheduleTasks(projectId, newOrderIds);
        } catch {
            setTasks(p => p.map(t => priorOrder.has(t.id) ? { ...t, order: priorOrder.get(t.id)! } : t));
            toast.error("Failed to reorder tasks");
        }
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

    async function addPredecessor(dependentId: string, predecessorId: string) {
        try {
            const dep = await linkTasks(predecessorId, dependentId);
            setTasks(prev => prev.map(t => {
                if (t.id === dependentId) return { ...t, dependencies: [...t.dependencies, { id: dep.id, predecessorId, dependentId }] };
                if (t.id === predecessorId) return { ...t, dependents: [...t.dependents, { id: dep.id, predecessorId, dependentId }] };
                return t;
            }));
            toast.success("Predecessor added");
        } catch { toast.error("Already linked or invalid"); }
    }
    async function removePredecessor(dependentId: string, predecessorId: string) {
        await unlinkTasks(predecessorId, dependentId);
        setTasks(prev => prev.map(t => ({
            ...t,
            dependencies: t.dependencies.filter(d => !(d.predecessorId === predecessorId && d.dependentId === dependentId)),
            dependents: t.dependents.filter(d => !(d.predecessorId === predecessorId && d.dependentId === dependentId)),
        })));
        toast.success("Predecessor removed");
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
        try {
            const comment = await addTaskComment(selectedTaskId, text);
            setComments(prev => [...prev, { ...(comment as any), createdAt: new Date().toISOString() }]);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to add comment");
        }
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
                                <span className="text-xs text-hui-textMuted">
                                    {filtersActive ? `${filteredSortedTasks.length} of ${tasks.length}` : tasks.length} task{tasks.length !== 1 ? "s" : ""}
                                </span>
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
                        <button
                            onClick={() => setLinkMode(linkMode ? null : "__awaiting__")}
                            className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${linkMode ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`}
                            title={linkMode ? "Cancel linking" : "Click two tasks to create a Finish-to-Start dependency"}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                            {linkMode ? "Cancel Link" : "Link Tasks"}
                        </button>
                        <button onClick={handleAiRisk} disabled={isAiRisk || tasks.length === 0} className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isAiRisk ? "bg-amber-500 text-white border-amber-600 animate-pulse" : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"}`} title="AI schedule risk analysis">
                            ⚠️ {isAiRisk ? "Analyzing…" : "AI Risk"}
                        </button>
                        <SchedulePublishButton projectId={projectId} initialPublished={initialPublished} />
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
                                    {estimates.length > 0 && (
                                        <>
                                            <div className="px-3 py-1 text-[10px] text-slate-400 uppercase font-semibold">Import from Estimate</div>
                                            {estimates.map(est => (<button key={est.id} onClick={() => { handleImportEstimate(est.id); setShowMoreMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">📋 {est.title}</button>))}
                                            <div className="border-t border-slate-100 my-1" />
                                        </>
                                    )}
                                    <button onClick={async () => { if (confirm('Delete ALL tasks from this schedule? This cannot be undone.')) { setShowMoreMenu(false); await clearAllTasks(projectId); setTasks([]); setSelectedTaskId(null); toast.success('Schedule cleared'); } }} className="w-full text-left px-3 py-2 hover:bg-red-50 transition text-sm flex items-center gap-2 text-red-600">🗑️ Clear All Tasks</button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Secondary toolbar: search + filter + sort */}
            <div className="bg-white border-b border-hui-border shrink-0 z-10 px-6 py-2 flex items-center gap-2 flex-wrap">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px] max-w-md">
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    <input
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                        placeholder="Search tasks..."
                        className="w-full text-xs pl-8 pr-8 py-1.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 transition outline-none"
                    />
                    {searchInput && (
                        <button onClick={() => setSearchInput("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition" aria-label="Clear search">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
                        </button>
                    )}
                </div>

                {/* Filter button */}
                <div className="relative">
                    <button onClick={() => setShowFilterPopover(v => !v)} className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${filtersActive ? "bg-indigo-50 text-indigo-700 border-indigo-300" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>
                        Filter
                        {filtersActive && (
                            <span className="ml-0.5 bg-indigo-600 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                                {(filters.q ? 1 : 0) + filters.statuses.length + (filters.type !== "all" ? 1 : 0) + (filters.assignee ? 1 : 0) + (filters.startFrom ? 1 : 0) + (filters.startTo ? 1 : 0)}
                            </span>
                        )}
                    </button>
                    {showFilterPopover && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowFilterPopover(false)} />
                            <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 w-[320px] p-4 animate-in fade-in">
                                {/* Status */}
                                <div className="mb-4">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</label>
                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                        {STATUS_OPTIONS.map(s => {
                                            const active = filters.statuses.includes(s);
                                            return (
                                                <button key={s} onClick={() => toggleStatusFilter(s)} className={`text-[10px] font-semibold px-2 py-1 rounded-full transition border ${active ? `${STATUS_COLORS[s] || "bg-indigo-100 text-indigo-700"} border-indigo-300 ring-1 ring-indigo-200` : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`}>
                                                    {s}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                {/* Type */}
                                <div className="mb-4">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Type</label>
                                    <div className="mt-1.5 flex gap-1">
                                        {(["all", "task", "milestone"] as const).map(opt => (
                                            <button key={opt} onClick={() => updateUrl({ type: opt === "all" ? null : opt })} className={`text-[10px] font-semibold px-2 py-1 rounded-md transition border flex-1 capitalize ${filters.type === opt ? "bg-indigo-50 text-indigo-700 border-indigo-300" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`}>
                                                {opt === "all" ? "All" : opt === "task" ? "Tasks" : "Milestones"}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* Assignee */}
                                <div className="mb-4">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned to</label>
                                    <select value={filters.assignee || ""} onChange={e => updateUrl({ assignee: e.target.value || null })} className="hui-input text-xs w-full mt-1.5">
                                        <option value="">Anyone</option>
                                        {teamMembers.length > 0 && <optgroup label="Team">{teamMembers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}</optgroup>}
                                        {subcontractors.length > 0 && <optgroup label="Subcontractors">{subcontractors.map(s => <option key={s.id} value={s.id}>{s.companyName}</option>)}</optgroup>}
                                    </select>
                                </div>
                                {/* Date range */}
                                <div className="mb-3">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Start date range</label>
                                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                                        <input type="date" value={filters.startFrom || ""} onChange={e => updateUrl({ from: e.target.value || null })} className="hui-input text-xs" placeholder="From" />
                                        <input type="date" value={filters.startTo || ""} onChange={e => updateUrl({ to: e.target.value || null })} className="hui-input text-xs" placeholder="To" />
                                    </div>
                                </div>
                                {filtersActive && (
                                    <button onClick={() => { clearAllFilters(); setShowFilterPopover(false); }} className="w-full text-xs text-indigo-600 hover:text-indigo-800 font-medium py-1.5 mt-1 border-t border-slate-100 pt-3 transition">
                                        Clear all filters
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Sort dropdown */}
                <div className="relative">
                    <button onClick={() => setShowSortMenu(v => !v)} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border bg-white text-slate-600 border-slate-200 hover:bg-slate-50">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M6 12h12M10 18h4"/></svg>
                        <span className="hidden sm:inline">Sort:</span>
                        <span className="font-semibold text-slate-700">
                            {SORT_OPTIONS.find(o => o.key === sortKey && o.dir === sortDir)?.label || `${sortKey} ${sortDir}`}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    {showSortMenu && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowSortMenu(false)} />
                            <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[220px] py-1 animate-in fade-in">
                                {SORT_OPTIONS.map(opt => {
                                    const active = sortKey === opt.key && sortDir === opt.dir;
                                    return (
                                        <button key={`${opt.key}-${opt.dir}`} onClick={() => setSort(opt.key, opt.dir)} className={`w-full text-left text-xs px-3 py-1.5 transition flex items-center gap-2 ${active ? "bg-indigo-50 text-indigo-700 font-semibold" : "text-slate-700 hover:bg-slate-50"}`}>
                                            {opt.key === "manual" && <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>}
                                            <span className="flex-1">{opt.label}</span>
                                            {active && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5"/></svg>}
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Active filter chips */}
            {filtersActive && (
                <div className="bg-slate-50 border-b border-hui-border px-6 py-1.5 flex items-center gap-1.5 flex-wrap">
                    {filters.q && (
                        <span className="text-[10px] font-medium bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span className="text-slate-400">Search:</span> <span className="text-slate-700">{filters.q}</span>
                            <button onClick={() => { setSearchInput(""); updateUrl({ q: null }); }} className="text-slate-400 hover:text-slate-700"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                        </span>
                    )}
                    {filters.statuses.map(s => (
                        <span key={s} className="text-[10px] font-medium bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span className="text-slate-400">Status:</span> <span className="text-slate-700">{s}</span>
                            <button onClick={() => toggleStatusFilter(s)} className="text-slate-400 hover:text-slate-700"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                        </span>
                    ))}
                    {filters.type !== "all" && (
                        <span className="text-[10px] font-medium bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span className="text-slate-400">Type:</span> <span className="text-slate-700 capitalize">{filters.type}</span>
                            <button onClick={() => updateUrl({ type: null })} className="text-slate-400 hover:text-slate-700"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                        </span>
                    )}
                    {filters.assignee && (
                        <span className="text-[10px] font-medium bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span className="text-slate-400">Assigned:</span>
                            <span className="text-slate-700">
                                {teamMembers.find(m => m.id === filters.assignee)?.name || teamMembers.find(m => m.id === filters.assignee)?.email || subcontractors.find(s => s.id === filters.assignee)?.companyName || filters.assignee}
                            </span>
                            <button onClick={() => updateUrl({ assignee: null })} className="text-slate-400 hover:text-slate-700"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                        </span>
                    )}
                    {(filters.startFrom || filters.startTo) && (
                        <span className="text-[10px] font-medium bg-white border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span className="text-slate-400">Start:</span>
                            <span className="text-slate-700">{filters.startFrom || "…"} → {filters.startTo || "…"}</span>
                            <button onClick={() => updateUrl({ from: null, to: null })} className="text-slate-400 hover:text-slate-700"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                        </span>
                    )}
                    <button onClick={clearAllFilters} className="text-[10px] text-indigo-600 hover:text-indigo-800 font-semibold px-2 py-0.5 transition">Clear all</button>
                </div>
            )}

            {linkMode && (
                <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-xs text-amber-800">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span className="font-medium">{linkMode === "__awaiting__" ? "Click the predecessor task" : "Now click the dependent task"}</span>
                    <button onClick={() => setLinkMode(null)} className="ml-auto text-amber-600 hover:text-amber-800 text-xs font-medium">Cancel</button>
                </div>
            )}

            {/* Table + Detail panel */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
                <div className="flex-1 min-h-0 min-w-0 overflow-auto">
                    <div className="min-w-[940px] text-xs">
                        {/* Header row (sticky) */}
                        <div className="sticky top-0 bg-slate-50 z-10 border-b border-hui-border grid items-center" style={{ gridTemplateColumns: GRID_COLS }}>
                            <div className="px-1 py-2.5" />
                            <div className="px-2 py-2.5" />
                            <div className="text-left px-3 py-2.5"><SortHeader label="Task Name" sortable field="name" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Type" sortable field="type" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Start" sortable field="startDate" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="End" sortable field="endDate" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Duration" sortable field="duration" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Status" sortable field="status" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Progress" sortable field="progress" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Assigned" sortable={false} /></div>
                            <div className="text-right px-3 py-2.5"><SortHeader label="Est. Hrs" sortable field="estimatedHours" /></div>
                            <div className="text-right px-3 py-2.5"><SortHeader label="Act. Hrs" sortable field="actualHours" /></div>
                            <div className="text-left px-3 py-2.5"><SortHeader label="Deps" sortable={false} /></div>
                            <div className="px-2 py-2.5" />
                        </div>

                        {/* Empty filtered state */}
                        {filteredSortedTasks.length === 0 && (
                            <div className="px-6 py-10 text-center text-sm text-slate-400">
                                <p>No tasks match your filters.</p>
                                <button onClick={clearAllFilters} className="text-indigo-600 hover:text-indigo-800 font-medium mt-2 text-xs">Clear all filters</button>
                            </div>
                        )}

                        {/* Rows */}
                        <DragDropContext onDragEnd={handleDragEnd}>
                            <Droppable droppableId="schedule-tasks">
                                {(dropProvided) => (
                                    <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                                        {filteredSortedTasks.map((task, index) => {
                                            const duration = getDaysBetween(new Date(task.startDate), new Date(task.endDate));
                                            const isSelected = task.id === selectedTaskId;
                                            const isCritical = showCriticalPath && criticalPathIds.has(task.id);
                                            const isLinkSource = linkMode === task.id;
                                            const progress = (task.estimatedHours && task.estimatedHours > 0 && task.actualHours > 0) ? Math.min(100, Math.round((task.actualHours / task.estimatedHours) * 100)) : task.progress;

                                            return (
                                                <Draggable key={task.id} draggableId={task.id} index={index} isDragDisabled={!canDrag}>
                                                    {(dragProvided, snapshot) => (
                                                        <div
                                                            ref={dragProvided.innerRef}
                                                            {...dragProvided.draggableProps}
                                                            onClick={() => { if (linkMode) { if (linkMode === "__awaiting__") setLinkMode(task.id); else handleTaskClick(task.id); } else setSelectedTaskId(task.id); }}
                                                            className={`grid items-center border-b border-slate-100 cursor-pointer transition group hover:bg-slate-50 ${isSelected ? "bg-indigo-50/60 ring-1 ring-inset ring-indigo-200" : ""} ${isLinkSource ? "bg-amber-50" : ""} ${isCritical ? "border-l-[3px] border-l-red-500" : ""} ${snapshot.isDragging ? "shadow-xl bg-white ring-2 ring-indigo-300 z-50" : ""}`}
                                                            style={{ ...dragProvided.draggableProps.style, gridTemplateColumns: GRID_COLS }}
                                                        >
                                                            {/* Drag handle */}
                                                            <div
                                                                {...(canDrag ? dragProvided.dragHandleProps : {})}
                                                                onClick={e => {
                                                                    e.stopPropagation();
                                                                    if (canDrag) return;
                                                                    setSearchInput("");
                                                                    updateUrl({ sort: "manual", dir: "asc", q: null, status: null, type: null, assignee: null, from: null, to: null });
                                                                }}
                                                                title={canDrag ? "Drag to reorder" : (filtersActive && sortKey === "manual") ? "Reordering disabled while filters are active — click to clear filters" : `Sorted by ${SORT_OPTIONS.find(o => o.key === sortKey && o.dir === sortDir)?.label || sortKey}${filtersActive ? " with filters" : ""} — click to enable manual reordering`}
                                                                className={`flex items-center justify-center self-stretch transition ${canDrag ? "text-slate-300 hover:text-indigo-600 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100" : "text-slate-200 hover:text-indigo-400 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 cursor-pointer"}`}
                                                            >
                                                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>
                                                            </div>
                                                            {/* Color dot */}
                                                            <div className="px-2 py-2 flex items-center">
                                                                <div className="relative">
                                                                    <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }} className="w-4 h-4 rounded-full border border-white shadow-sm" style={{ backgroundColor: task.color }} />
                                                                    {colorPickerId === task.id && (
                                                                        <div className="absolute left-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 p-2 flex gap-1 animate-in fade-in" onClick={e => e.stopPropagation()}>
                                                                            {PRESET_COLORS.map(c => (<button key={c} onClick={() => handleColorChange(task.id, c)} className="w-5 h-5 rounded-full border-2 transition hover:scale-110" style={{ backgroundColor: c, borderColor: c === task.color ? "#1e293b" : "transparent" }} />))}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {/* Name */}
                                                            <div className="px-3 py-2 min-w-0">
                                                                {editingCell?.taskId === task.id && editingCell.field === "name" ? (
                                                                    <input ref={editRef as any} value={editValue} onChange={e => setEditValue(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingCell(null); }} className="hui-input text-xs w-full py-0.5" onClick={e => e.stopPropagation()} />
                                                                ) : (
                                                                    <div className="flex items-center gap-1.5 min-w-0" onDoubleClick={e => { e.stopPropagation(); startEdit(task.id, "name", task.name); }}>
                                                                        {task.type === "milestone" && <div className="w-2.5 h-2.5 rotate-45 shrink-0" style={{ backgroundColor: task.color }} />}
                                                                        <span className="font-medium text-hui-textMain truncate">{task.name}</span>
                                                                        {task.estimateItem && <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded font-semibold shrink-0">$</span>}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {/* Type */}
                                                            <div className="px-3 py-2">
                                                                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${task.type === "milestone" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                                                                    {task.type === "milestone" ? "Mile." : "Task"}
                                                                </span>
                                                            </div>
                                                            {/* Start Date */}
                                                            <div className="px-3 py-2">
                                                                <input type="date" value={task.startDate} onChange={e => { e.stopPropagation(); handleDateChange(task.id, "startDate", e.target.value); }} onClick={e => e.stopPropagation()} className="bg-transparent text-xs text-hui-textMain cursor-pointer hover:text-indigo-600 transition w-full border-0 p-0 focus:ring-0" />
                                                            </div>
                                                            {/* End Date */}
                                                            <div className="px-3 py-2">
                                                                {task.type === "milestone" ? (
                                                                    <span className="text-slate-300">—</span>
                                                                ) : (
                                                                    <input type="date" value={task.endDate} onChange={e => { e.stopPropagation(); handleDateChange(task.id, "endDate", e.target.value); }} onClick={e => e.stopPropagation()} className="bg-transparent text-xs text-hui-textMain cursor-pointer hover:text-indigo-600 transition w-full border-0 p-0 focus:ring-0" />
                                                                )}
                                                            </div>
                                                            {/* Duration */}
                                                            <div className="px-3 py-2 text-hui-textMuted">{task.type === "milestone" ? "0d" : `${duration}d`}</div>
                                                            {/* Status */}
                                                            <div className="px-3 py-2">
                                                                <select value={task.status} onChange={e => { e.stopPropagation(); handleStatusChange(task.id, e.target.value); }} onClick={e => e.stopPropagation()} className={`text-[10px] font-semibold px-2 py-1 rounded-full border-0 cursor-pointer ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-600"}`}>
                                                                    {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                                                </select>
                                                            </div>
                                                            {/* Progress */}
                                                            <div className="px-3 py-2">
                                                                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                                                    <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                                        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, backgroundColor: task.color + "cc" }} />
                                                                    </div>
                                                                    <span className="text-[10px] text-slate-500 w-7 text-right">{progress}%</span>
                                                                </div>
                                                            </div>
                                                            {/* Assigned */}
                                                            <div className="px-3 py-2">
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
                                                            </div>
                                                            {/* Est. Hours */}
                                                            <div className="px-3 py-2 text-right">
                                                                {editingCell?.taskId === task.id && editingCell.field === "estimatedHours" ? (
                                                                    <input ref={editRef as any} type="number" value={editValue} onChange={e => setEditValue(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingCell(null); }} className="hui-input text-xs w-16 py-0.5 text-right" onClick={e => e.stopPropagation()} />
                                                                ) : (
                                                                    <span className="text-hui-textMuted cursor-pointer hover:text-indigo-600" onDoubleClick={e => { e.stopPropagation(); startEdit(task.id, "estimatedHours", String(task.estimatedHours ?? "")); }}>
                                                                        {task.estimatedHours != null ? `${task.estimatedHours}h` : "—"}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {/* Act. Hours */}
                                                            <div className="px-3 py-2 text-right text-hui-textMuted">{task.actualHours > 0 ? `${task.actualHours.toFixed(1)}h` : "—"}</div>
                                                            {/* Dependencies */}
                                                            <div className="px-3 py-2">
                                                                <div className="relative inline-block" onClick={e => e.stopPropagation()}>
                                                                    <button
                                                                        onClick={() => { setDepsPopoverId(depsPopoverId === task.id ? null : task.id); setDepsPickerId(null); }}
                                                                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium transition ${task.dependencies.length > 0 ? "bg-slate-100 text-slate-600 hover:bg-indigo-100 hover:text-indigo-700" : "text-slate-300 hover:text-indigo-600 hover:bg-indigo-50"}`}
                                                                        title={task.dependencies.length > 0 ? "View / edit predecessors" : "Add a predecessor"}
                                                                    >
                                                                        {task.dependencies.length > 0 ? `${task.dependencies.length} dep${task.dependencies.length !== 1 ? "s" : ""}` : "+ Link"}
                                                                    </button>
                                                                    {depsPopoverId === task.id && (
                                                                        <div className="absolute left-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] py-1 animate-in fade-in">
                                                                            <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50 flex items-center justify-between">
                                                                                <span>Predecessors</span>
                                                                                <button onClick={() => setDepsPopoverId(null)} className="text-slate-400 hover:text-slate-700">
                                                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                                                </button>
                                                                            </div>
                                                                            {task.dependencies.length === 0 ? (
                                                                                <div className="px-3 py-2 text-xs text-slate-400 italic">No predecessors yet.</div>
                                                                            ) : (
                                                                                task.dependencies.map(d => {
                                                                                    const pred = tasks.find(t => t.id === d.predecessorId);
                                                                                    if (!pred) return null;
                                                                                    return (
                                                                                        <div key={d.id} className="px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-xs group/dep">
                                                                                            {pred.type === "milestone" ? (
                                                                                                <div className="w-2 h-2 rotate-45 shrink-0" style={{ backgroundColor: pred.color }} />
                                                                                            ) : (
                                                                                                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: pred.color }} />
                                                                                            )}
                                                                                            <span className="font-medium truncate flex-1">{pred.name}</span>
                                                                                            <span className="text-[9px] text-slate-400 font-semibold">FS</span>
                                                                                            <button onClick={() => removePredecessor(task.id, pred.id)} className="text-slate-300 hover:text-red-500 transition shrink-0" title="Remove">
                                                                                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                                                            </button>
                                                                                        </div>
                                                                                    );
                                                                                })
                                                                            )}
                                                                            <div className="border-t border-slate-100 my-1" />
                                                                            <div className="px-1 relative">
                                                                                <button
                                                                                    onClick={() => setDepsPickerId(depsPickerId === task.id ? null : task.id)}
                                                                                    className="w-full text-left px-2 py-1.5 hover:bg-indigo-50 transition text-xs text-indigo-600 font-semibold rounded"
                                                                                >
                                                                                    + Add predecessor
                                                                                </button>
                                                                                {depsPickerId === task.id && (
                                                                                    <DependencyPicker
                                                                                        task={task}
                                                                                        allTasks={tasks}
                                                                                        onPick={(predId) => addPredecessor(task.id, predId)}
                                                                                        onClose={() => setDepsPickerId(null)}
                                                                                        align="left"
                                                                                    />
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {/* Actions */}
                                                            <div className="px-2 py-2">
                                                                <button onClick={e => { e.stopPropagation(); if (confirm("Delete this task?")) handleDelete(task.id); }} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition p-1">
                                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </Draggable>
                                            );
                                        })}
                                        {dropProvided.placeholder}
                                    </div>
                                )}
                            </Droppable>
                        </DragDropContext>
                    </div>
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
                        allTasks={tasks}
                        onLinkPredecessor={async (predId) => {
                            if (selectedTaskId) await addPredecessor(selectedTaskId, predId);
                        }}
                        onUnlinkPredecessor={async (predId) => {
                            if (selectedTaskId) await removePredecessor(selectedTaskId, predId);
                        }}
                        onSelectTask={(taskId) => { setSelectedTaskId(taskId); setPanelTab("details"); }}
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
