"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
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

type EstimateSummary = { id: string; title: string; status: string };
type EstimateItemSummary = { id: string; name: string; type: string; total: number; estimateId: string };
type Dependency = { id: string; predecessorId: string; dependentId: string };
type TeamMember = { id: string; name: string | null; email: string };
type PunchItem = { id: string; name: string; completed: boolean; order: number };
type Comment = { id: string; text: string; createdAt: string; user: { id: string; name: string | null; email: string } };
type Assignment = { id: string; userId: string; user: TeamMember };
type Subcontractor = { id: string; companyName: string; email: string; trade: string | null };
type SubAssignment = { id: string; subcontractorId: string; subcontractor: Subcontractor };

type Task = {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    type: "task" | "milestone";
    assignee: string | null;
    order: number;
    estimatedHours: number | null;
    actualHours: number;
    dependencies: Dependency[];
    dependents: Dependency[];
    assignments?: Assignment[];
    subAssignments?: SubAssignment[];
    estimateItemId?: string | null;
    estimateItem?: EstimateItemSummary | null;
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
function formatCurrency(n: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n); }

// --- Critical Path Algorithm ---
function computeCriticalPath(tasks: Task[]): Set<string> {
    if (tasks.length === 0) return new Set();
    // Build duration map (days) and dependency graph
    const dur: Record<string, number> = {};
    const deps: Record<string, string[]> = {}; // task -> its predecessors
    const successors: Record<string, string[]> = {}; // task -> its dependents
    for (const t of tasks) {
        dur[t.id] = Math.max(1, getDaysBetween(new Date(t.startDate), new Date(t.endDate)));
        deps[t.id] = t.dependencies.map(d => d.predecessorId);
        successors[t.id] = t.dependents.map(d => d.dependentId);
    }
    // Forward pass: earliest finish
    const ef: Record<string, number> = {};
    const topoOrder: string[] = [];
    const visited = new Set<string>();
    function visit(id: string, stack = new Set<string>()) {
        if (visited.has(id)) return;
        if (stack.has(id)) return; // cycle guard
        stack.add(id);
        for (const pred of (deps[id] || [])) visit(pred, stack);
        visited.add(id);
        topoOrder.push(id);
    }
    for (const t of tasks) visit(t.id);
    for (const id of topoOrder) {
        const predMaxEF = (deps[id] || []).reduce((m, pid) => Math.max(m, ef[pid] ?? 0), 0);
        ef[id] = predMaxEF + dur[id];
    }
    // Backward pass: latest start
    const projectEnd = Math.max(...Object.values(ef));
    const ls: Record<string, number> = {};
    for (const id of [...topoOrder].reverse()) {
        const succMinLS = (successors[id] || []).reduce((m, sid) => Math.min(m, ls[sid] ?? Infinity), Infinity);
        const lf = succMinLS === Infinity ? projectEnd : succMinLS;
        ls[id] = lf - dur[id];
    }
    // Float = ls - (ef - dur) = ls - es
    const critical = new Set<string>();
    for (const id of topoOrder) {
        const es = ef[id] - dur[id];
        if (ls[id] - es <= 0) critical.add(id);
    }
    return critical;
}

export default function GanttChart({ projectId, projectName, initialTasks, estimates = [], teamMembers = [], subcontractors = [], currentUserId = "system" }: {
    projectId: string;
    projectName: string;
    initialTasks: Task[];
    estimates?: EstimateSummary[];
    teamMembers?: TeamMember[];
    subcontractors?: Subcontractor[];
    currentUserId?: string;
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
    const [isAiRisk, setIsAiRisk] = useState(false);
    const [showRiskPanel, setShowRiskPanel] = useState(false);
    const [riskAnalysis, setRiskAnalysis] = useState<string | null>(null);
    const [linkMode, setLinkMode] = useState<string | null>(null);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [editingHoursId, setEditingHoursId] = useState<string | null>(null);
    const [editHoursVal, setEditHoursVal] = useState("");
    const [showCriticalPath, setShowCriticalPath] = useState(false);
    const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    // Detail panel state
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [panelTab, setPanelTab] = useState<"details" | "punch" | "conversation">("details");
    const [punchItems, setPunchItems] = useState<PunchItem[]>([]);
    const [comments, setComments] = useState<Comment[]>([]);
    const [newPunchName, setNewPunchName] = useState("");
    const [newComment, setNewComment] = useState("");
    const [isAiPunching, setIsAiPunching] = useState(false);
    const [showAssignMenu, setShowAssignMenu] = useState(false);
    const [estimateItems, setEstimateItems] = useState<EstimateItemSummary[]>([]);
    const [showEstimateLinkMenu, setShowEstimateLinkMenu] = useState(false);
    const [isPublished, setIsPublished] = useState(false);
    const [isPublishing, setIsPublishing] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [dragState, setDragState] = useState<{
        taskId: string; type: "move" | "resize-left" | "resize-right"; startX: number; origStart: Date; origEnd: Date;
    } | null>(null);

    const selectedTask = tasks.find(t => t.id === selectedTaskId);

    useEffect(() => {
        getPortalVisibility(projectId).then(v => setIsPublished(v.showSchedule));
    }, [projectId]);

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

    // Critical path computation
    const criticalPathIds = useMemo(() => computeCriticalPath(tasks), [tasks]);

    // AI Schedule handler
    async function handleAiSchedule(estimateId?: string) {
        setIsAiGenerating(true);
        setShowAiMenu(false);
        try {
            const created = await aiGenerateSchedule(projectId, estimateId);
            const newTasks: Task[] = created.map((t: any) => ({
                id: t.id, name: t.name,
                startDate: new Date(t.startDate).toISOString().split("T")[0],
                endDate: new Date(t.endDate).toISOString().split("T")[0],
                color: t.color, progress: 0, status: t.status,
                type: "task",
                assignee: null, order: t.order,
                estimatedHours: t.estimatedHours, actualHours: 0,
                dependencies: [], dependents: [], assignments: [],
                estimateItemId: null, estimateItem: null,
            }));
            setTasks(prev => [...prev, ...newTasks]);
            toast.success(`AI generated ${newTasks.length} tasks`);
        } catch (e: any) {
            toast.error(e.message || "AI schedule generation failed");
        } finally {
            setIsAiGenerating(false);
        }
    }

    // AI Risk Analysis handler
    async function handleAiRisk() {
        setIsAiRisk(true);
        try {
            const res = await fetch("/api/ai/schedule-risk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, tasks }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Risk analysis failed");
            setRiskAnalysis(data.analysis);
            setShowRiskPanel(true);
        } catch (e: any) {
            toast.error(e.message || "Schedule risk analysis failed");
        } finally {
            setIsAiRisk(false);
        }
    }

    // Load detail data when task selected
    useEffect(() => {
        if (selectedTaskId) {
            getTaskPunchItems(selectedTaskId).then(items => setPunchItems(items as any));
            getTaskComments(selectedTaskId).then(comments => setComments(comments.map((c: any) => ({ ...c, createdAt: c.createdAt.toISOString?.() || c.createdAt }))));
        }
    }, [selectedTaskId]);

    // Load estimate items for linking (lazy)
    useEffect(() => {
        if (showEstimateLinkMenu && estimateItems.length === 0) {
            getEstimateItemsForProject(projectId).then(items => setEstimateItems(items as any));
        }
    }, [showEstimateLinkMenu]);

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

    function getWeekendColumns() {
        const cols: { left: number; width: number }[] = [];
        let cursor = new Date(minDate);
        for (let i = 0; i < totalDays; i++) {
            if (isWeekend(cursor)) cols.push({ left: i * colWidth, width: colWidth });
            cursor = addDays(cursor, 1);
        }
        return cols;
    }

    const todayOffset = getDaysBetween(minDate, today) * colWidth;
    const headers = getHeaders();
    const weekendCols = getWeekendColumns();

    // --- Drag handlers (mouse) ---
    const handleMouseDown = useCallback((e: React.MouseEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        e.preventDefault();
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        setDragState({ taskId, type, startX: e.clientX, origStart: new Date(task.startDate), origEnd: new Date(task.endDate) });
    }, [tasks]);

    // --- Touch drag handlers ---
    const handleTouchStart = useCallback((e: React.TouchEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        e.preventDefault();
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        setDragState({ taskId, type, startX: e.touches[0].clientX, origStart: new Date(task.startDate), origEnd: new Date(task.endDate) });
    }, [tasks]);

    const applyDrag = useCallback((clientX: number) => {
        if (!dragState) return;
        const dayDelta = Math.round((clientX - dragState.startX) / colWidth);
        if (dayDelta === 0) return;
        setTasks(prev => prev.map(t => {
            if (t.id !== dragState.taskId) return t;
            const isMilestone = t.type === "milestone";
            if (dragState.type === "move") {
                const newStart = formatDate(addDays(dragState.origStart, dayDelta));
                const newEnd = isMilestone ? newStart : formatDate(addDays(dragState.origEnd, dayDelta));
                return { ...t, startDate: newStart, endDate: newEnd };
            }
            if (dragState.type === "resize-right" && !isMilestone) {
                const ne = addDays(dragState.origEnd, dayDelta);
                return ne <= new Date(t.startDate) ? t : { ...t, endDate: formatDate(ne) };
            }
            if (dragState.type === "resize-left" && !isMilestone) {
                const ns = addDays(dragState.origStart, dayDelta);
                return ns >= new Date(t.endDate) ? t : { ...t, startDate: formatDate(ns) };
            }
            return t;
        }));
    }, [dragState, colWidth]);

    const handleMouseMove = useCallback((e: MouseEvent) => applyDrag(e.clientX), [applyDrag]);
    const handleTouchMove = useCallback((e: TouchEvent) => { e.preventDefault(); applyDrag(e.touches[0].clientX); }, [applyDrag]);

    const finishDrag = useCallback(async () => {
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

    const handleMouseUp = useCallback(() => finishDrag(), [finishDrag]);
    const handleTouchEnd = useCallback(() => finishDrag(), [finishDrag]);

    async function cascadeDependents(taskId: string, dayDelta: number) {
        const deps = tasks.filter(t => t.dependencies.some(d => d.predecessorId === taskId));
        for (const dep of deps) {
            const ns = formatDate(addDays(new Date(dep.startDate), dayDelta));
            const ne = dep.type === "milestone" ? ns : formatDate(addDays(new Date(dep.endDate), dayDelta));
            setTasks(prev => prev.map(t => t.id === dep.id ? { ...t, startDate: ns, endDate: ne } : t));
            await updateScheduleTask(dep.id, { startDate: ns, endDate: ne });
            await cascadeDependents(dep.id, dayDelta);
        }
    }

    useEffect(() => {
        if (dragState) {
            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);
            window.addEventListener("touchmove", handleTouchMove, { passive: false });
            window.addEventListener("touchend", handleTouchEnd);
            return () => {
                window.removeEventListener("mousemove", handleMouseMove);
                window.removeEventListener("mouseup", handleMouseUp);
                window.removeEventListener("touchmove", handleTouchMove);
                window.removeEventListener("touchend", handleTouchEnd);
            };
        }
    }, [dragState, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

    // Pinch-to-zoom
    const pinchRef = useRef<{ dist: number; zoomed: boolean } | null>(null);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                pinchRef.current = { dist: Math.hypot(dx, dy), zoomed: false };
            }
        };
        const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || !pinchRef.current || pinchRef.current.zoomed) return;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const newDist = Math.hypot(dx, dy);
            const ratio = newDist / pinchRef.current.dist;
            if (ratio > 1.3) { setZoom(z => z === "month" ? "week" : z === "week" ? "day" : "day"); pinchRef.current.zoomed = true; }
            else if (ratio < 0.7) { setZoom(z => z === "day" ? "week" : z === "week" ? "month" : "month"); pinchRef.current.zoomed = true; }
        };
        const onTouchEnd = () => { pinchRef.current = null; };
        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: true });
        el.addEventListener("touchend", onTouchEnd);
        return () => {
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
        };
    }, []);

    // --- Task CRUD ---
    async function handleAddTask(type: "task" | "milestone" = "task") {
        setIsAdding(true);
        try {
            const start = formatDate(today);
            const end = type === "milestone" ? start : formatDate(addDays(today, 5));
            const task = await createScheduleTask(projectId, { name: type === "milestone" ? "New Milestone" : "New Task", startDate: start, endDate: end, type });
            setTasks(prev => [...prev, { ...task, startDate: start, endDate: end, type, actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [], estimateItemId: null, estimateItem: null }]);
            toast.success(type === "milestone" ? "Milestone added" : "Task added");
        } finally { setIsAdding(false); }
    }
    async function handleSaveName(taskId: string) { if (editName.trim()) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: editName.trim() } : t)); await updateScheduleTask(taskId, { name: editName.trim() }); } setEditingId(null); }
    async function handleColorChange(taskId: string, color: string) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color } : t)); setColorPickerId(null); await updateScheduleTask(taskId, { color }); }
    async function handleStatusChange(taskId: string, status: string) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t)); await updateScheduleTask(taskId, { status }); }
    async function handleDelete(taskId: string) { setTasks(prev => prev.filter(t => t.id !== taskId)); if (selectedTaskId === taskId) setSelectedTaskId(null); await deleteScheduleTask(taskId); toast.success("Task deleted"); }
    async function handleProgressChange(taskId: string, progress: number) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress } : t)); await updateScheduleTask(taskId, { progress }); }
    async function handleEstimatedHoursSave(taskId: string) { const h = parseFloat(editHoursVal); if (!isNaN(h) && h >= 0) { setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: h } : t)); await updateScheduleTask(taskId, { estimatedHours: h }); } setEditingHoursId(null); }

    async function handleLinkEstimateItem(taskId: string, item: EstimateItemSummary) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimateItemId: item.id, estimateItem: item } : t));
        setShowEstimateLinkMenu(false);
        await updateScheduleTask(taskId, { estimateItemId: item.id });
        toast.success("Linked to estimate item");
    }
    async function handleUnlinkEstimateItem(taskId: string) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimateItemId: null, estimateItem: null } : t));
        await updateScheduleTask(taskId, { estimateItemId: null });
        toast.success("Estimate link removed");
    }

    async function handleImportEstimate(estimateId: string) {
        setIsImporting(true); setShowImportMenu(false);
        try {
            const newTasks = await importEstimateToSchedule(projectId, estimateId);
            setTasks(prev => [...prev, ...newTasks.map((t: any) => ({ ...t, startDate: formatDate(new Date(t.startDate)), endDate: formatDate(new Date(t.endDate)), type: "task", actualHours: 0, estimatedHours: null, dependencies: [], dependents: [], assignments: [], estimateItemId: t.estimateItemId || null, estimateItem: null }))]);
            toast.success(`Imported ${newTasks.length} tasks`);
        } catch { toast.error("Import failed"); } finally { setIsImporting(false); }
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
        try {
            const comment = await addTaskComment(selectedTaskId, currentUserId, newComment.trim());
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
    async function handleAssignSub(subcontractorId: string) {
        if (!selectedTaskId) return;
        try {
            const assignment = await assignSubToTask(selectedTaskId, subcontractorId);
            setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, subAssignments: [...(t.subAssignments || []), assignment as any] } : t));
            setShowAssignMenu(false);
            toast.success("Subcontractor assigned");
        } catch { toast.error("Already assigned"); }
    }
    async function handleUnassignSub(subId: string) {
        if (!selectedTaskId) return;
        await unassignSubFromTask(selectedTaskId, subId);
        setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, subAssignments: (t.subAssignments || []).filter(a => a.subcontractorId !== subId) } : t));
    }

    // Arrows
    const arrows: { fromId: string; toId: string; predecessorId: string; dependentId: string }[] = [];
    tasks.forEach(t => t.dependencies.forEach(d => arrows.push({ fromId: d.predecessorId, toId: d.dependentId, predecessorId: d.predecessorId, dependentId: d.dependentId })));

    // --- EMPTY STATE ---
    if (tasks.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 gap-6 py-20">
                <div className="relative">
                    <div className="w-20 h-20 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-100/50">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="url(#grad)" strokeWidth="1.5">
                            <defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#6366f1"/><stop offset="100%" stopColor="#8b5cf6"/></linearGradient></defs>
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
                    <button onClick={() => handleAddTask("task")} className="hui-btn hui-btn-primary" disabled={isAdding}>+ Add First Task</button>
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
                                    {estimates.map(est => (
                                        <button key={est.id} onClick={() => handleImportEstimate(est.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm">{est.title}</button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
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
                        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                            {(["day", "week", "month"] as ZoomLevel[]).map(z => (
                                <button key={z} onClick={() => setZoom(z)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition capitalize ${zoom === z ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{z}</button>
                            ))}
                        </div>
                        <button onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayOffset - 300); }} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Today</button>
                        {/* Critical Path toggle */}
                        <button
                            onClick={() => setShowCriticalPath(v => !v)}
                            className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${showCriticalPath ? "bg-red-50 text-red-700 border-red-300" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`}
                            title="Highlight critical path"
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                            Critical Path
                        </button>
                        <button
                            onClick={handleAiRisk}
                            disabled={isAiRisk || tasks.length === 0}
                            className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isAiRisk ? "bg-amber-500 text-white border-amber-600 animate-pulse" : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"}`}
                            title="AI schedule risk analysis"
                        >
                            ⚠️ {isAiRisk ? "Analyzing…" : "AI Risk"}
                        </button>
                        <button
                            onClick={handleTogglePublish}
                            disabled={isPublishing}
                            className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isPublished ? "bg-green-50 text-green-700 border-green-300" : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"}`}
                            title={isPublished ? "Schedule is visible to client — click to hide" : "Publish schedule to client portal"}
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isPublished ? "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" : "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18"} /></svg>
                            {isPublishing ? "Updating…" : isPublished ? "Published" : "Publish to Client"}
                        </button>
                        <button
                            onClick={() => {
                                if (tasks.length === 0) { toast.error("No tasks to sync"); return; }
                                const a = document.createElement("a");
                                a.href = `/api/calendar/sync?projectId=${projectId}`;
                                a.download = "schedule.ics";
                                a.click();
                                toast.success("Calendar file downloaded — import into Google Calendar, Apple Calendar, or Outlook");
                            }}
                            disabled={tasks.length === 0}
                            className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 disabled:opacity-40"
                            title="Download .ics file to sync with your calendar"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                            Sync to Calendar
                        </button>
                        <div className="relative">
                            <button onClick={() => estimates.length > 0 ? setShowAiMenu(!showAiMenu) : handleAiSchedule()} disabled={isAiGenerating}
                                className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isAiGenerating ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white border-purple-600 animate-pulse" : "bg-gradient-to-r from-purple-50 to-indigo-50 text-purple-700 border-purple-200 hover:shadow-md hover:from-purple-100 hover:to-indigo-100"}`}>
                                ✨ {isAiGenerating ? "AI thinking..." : "AI Schedule"}
                            </button>
                            {showAiMenu && estimates.length > 0 && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[260px] py-1 animate-in fade-in">
                                    <button onClick={() => handleAiSchedule()} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>🧠</span> General Schedule</button>
                                    {estimates.map(est => (
                                        <button key={est.id} onClick={() => handleAiSchedule(est.id)} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>📋</span> {est.title}</button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button onClick={() => handleAddTask("task")} disabled={isAdding} className="hui-btn hui-btn-primary text-xs">+ Task</button>
                        <button onClick={() => handleAddTask("milestone")} disabled={isAdding} className="hui-btn hui-btn-secondary text-xs flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0L10.5 5.5L16 8L10.5 10.5L8 16L5.5 10.5L0 8L5.5 5.5Z"/></svg>
                            Milestone
                        </button>
                        {/* More menu */}
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
                                            {estimates.map(est => (
                                                <button key={est.id} onClick={() => { handleImportEstimate(est.id); setShowMoreMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">
                                                    📋 {est.title}
                                                </button>
                                            ))}
                                        </>
                                    )}
                                    <div className="border-t border-slate-100 my-1" />
                                    <button onClick={async () => { if (confirm('Delete ALL tasks from this schedule? This cannot be undone.')) { setShowMoreMenu(false); await clearAllTasks(projectId); setTasks([]); setSelectedTaskId(null); toast.success('Schedule cleared'); } }} className="w-full text-left px-3 py-2 hover:bg-red-50 transition text-sm flex items-center gap-2 text-red-600">
                                        🗑️ Clear All Tasks
                                    </button>
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

            <div className="flex flex-1 overflow-hidden">
                {/* Left Panel — Task List */}
                <div className="w-80 shrink-0 bg-white border-r border-hui-border flex flex-col z-10 shadow-[2px_0_8px_rgba(0,0,0,0.03)]">
                    <div className="flex items-center px-3 py-3 bg-gradient-to-r from-slate-50 to-slate-100/50 border-b border-hui-border text-[10px] font-bold text-slate-400 uppercase tracking-wider h-[44px]">
                        <div className="flex-1">Task Name</div>
                        <div className="w-16 text-center">Hours</div>
                        <div className="w-20 text-center">Status</div>
                        <div className="w-8"></div>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {tasks.map(task => {
                            const hasTimeData = task.actualHours > 0 && task.estimatedHours;
                            const isCritical = showCriticalPath && criticalPathIds.has(task.id);
                            return (
                                <div key={task.id}
                                    onClick={() => { if (linkMode === "__awaiting__") setLinkMode(task.id); else if (linkMode) handleTaskClick(task.id); else { setSelectedTaskId(task.id); setPanelTab("details"); } }}
                                    className={`flex items-center px-3 border-b border-slate-100 hover:bg-slate-50/80 transition group cursor-pointer ${selectedTaskId === task.id ? "bg-indigo-50/60 ring-1 ring-inset ring-indigo-200" : ""} ${linkMode === task.id ? "bg-amber-50 ring-1 ring-inset ring-amber-300" : ""}`}
                                    style={{ height: ROW_HEIGHT, borderLeft: isCritical ? "3px solid #ef4444" : "" }}
                                >
                                    <div className="relative mr-2">
                                        {task.type === "milestone" ? (
                                            <button
                                                onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }}
                                                className="w-4 h-4 flex items-center justify-center"
                                                title="Milestone"
                                            >
                                                <div className="w-3 h-3 rotate-45 border-2" style={{ backgroundColor: task.color, borderColor: task.color }} />
                                            </button>
                                        ) : (
                                            <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }} className="w-3 h-3 rounded-full border-2 border-white shadow-sm ring-1 ring-slate-200" style={{ backgroundColor: task.color }} />
                                        )}
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
                                                {(task.assignments || []).slice(0, 2).map(a => (
                                                    <div key={a.userId} className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[8px] font-bold flex items-center justify-center shrink-0" title={a.user.name || a.user.email}>
                                                        {getInitials(a.user.name, a.user.email)}
                                                    </div>
                                                ))}
                                                <button onClick={e => { if (!linkMode) { e.stopPropagation(); setEditingId(task.id); setEditName(task.name); }}} className="text-xs font-medium text-hui-textMain truncate text-left hover:text-hui-primary transition">{task.name}</button>
                                                {task.estimateItem && <span className="ml-1 text-[9px] text-blue-500 bg-blue-50 rounded px-1 shrink-0">$</span>}
                                            </div>
                                        )}
                                    </div>
                                    <div className="w-16 flex justify-center">
                                        {task.type !== "milestone" && (editingHoursId === task.id ? (
                                            <input autoFocus type="number" className="hui-input text-[10px] py-0.5 w-12 text-center" value={editHoursVal} onChange={e => setEditHoursVal(e.target.value)} onBlur={() => handleEstimatedHoursSave(task.id)} onKeyDown={e => { if (e.key === "Enter") handleEstimatedHoursSave(task.id); }} onClick={e => e.stopPropagation()} placeholder="hrs" />
                                        ) : (
                                            <button onClick={e => { e.stopPropagation(); setEditingHoursId(task.id); setEditHoursVal(task.estimatedHours?.toString() || ""); }} className={`text-[10px] px-1 py-0.5 rounded ${hasTimeData ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-300 hover:bg-slate-100"}`}>
                                                {hasTimeData ? `${task.actualHours.toFixed(1)}/${task.estimatedHours}h` : task.estimatedHours ? `${task.estimatedHours}h` : "—"}
                                            </button>
                                        ))}
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
                        <button onClick={() => handleAddTask("task")} className="flex items-center px-3 w-full hover:bg-slate-50 transition text-xs text-indigo-500 font-medium gap-2" style={{ height: ROW_HEIGHT }} disabled={isAdding}>
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
                        <svg className="absolute top-0 left-0 pointer-events-none z-[4]" style={{ width: timelineWidth, height: 44 + tasks.length * ROW_HEIGHT }}>
                            <defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#94a3b8" /></marker></defs>
                            {arrows.map((arrow, i) => {
                                const ft = tasks.find(t => t.id === arrow.fromId), tt = tasks.find(t => t.id === arrow.toId);
                                if (!ft || !tt) return null;
                                const fb = getBarStyle(ft), tb = getBarStyle(tt);
                                const fromIsMilestone = ft.type === "milestone";
                                const toIsMilestone = tt.type === "milestone";
                                const x1 = fromIsMilestone ? fb.left + 8 : fb.left + fb.width;
                                const y1 = 44 + tasks.indexOf(ft) * ROW_HEIGHT + ROW_HEIGHT / 2;
                                const x2 = toIsMilestone ? tb.left + 8 : tb.left;
                                const y2 = 44 + tasks.indexOf(tt) * ROW_HEIGHT + ROW_HEIGHT / 2;
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

                        {/* Task Bars / Milestone Diamonds */}
                        {tasks.map((task, idx) => {
                            const bar = getBarStyle(task);
                            const ap = getAutoProgress(task);
                            const isCritical = showCriticalPath && criticalPathIds.has(task.id);
                            const topY = 44 + idx * ROW_HEIGHT;

                            if (task.type === "milestone") {
                                const cx = bar.left + 8; // center of diamond on start date
                                const cy = topY + ROW_HEIGHT / 2;
                                const size = 10;
                                return (
                                    <div key={task.id} className="absolute flex items-center justify-center" style={{ top: topY, left: cx - size - 4, width: (size + 4) * 2, height: ROW_HEIGHT }}>
                                        <div
                                            className={`relative cursor-pointer group select-none ${isCritical ? "drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]" : ""}`}
                                            onMouseDown={e => handleMouseDown(e, task.id, "move")}
                                            onTouchStart={e => handleTouchStart(e, task.id, "move")}
                                            title={task.name}
                                        >
                                            <div
                                                className={`w-5 h-5 rotate-45 border-2 shadow-md transition-transform group-hover:scale-110 ${isCritical ? "ring-2 ring-red-400/50" : ""}`}
                                                style={{ backgroundColor: task.color, borderColor: task.color }}
                                            />
                                            {/* Milestone label */}
                                            {colWidth > 10 && (
                                                <div className="absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-bold pointer-events-none" style={{ color: task.color }}>
                                                    {task.name}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            }

                            // Regular task bar
                            return (
                                <div key={task.id} className="absolute flex items-center" style={{ top: topY + 10, left: bar.left, width: bar.width, height: ROW_HEIGHT - 20 }}>
                                    <div className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-l-lg" onMouseDown={e => handleMouseDown(e, task.id, "resize-left")} onTouchStart={e => handleTouchStart(e, task.id, "resize-left")} />
                                    <div
                                        className={`w-full h-full rounded-lg shadow-md hover:shadow-lg cursor-grab active:cursor-grabbing relative overflow-hidden group border transition-shadow ${isCritical ? "ring-2 ring-red-400/60 shadow-[0_0_10px_rgba(239,68,68,0.25)]" : "border-black/[0.06]"}`}
                                        style={{ backgroundColor: task.color + "18" }}
                                        onMouseDown={e => handleMouseDown(e, task.id, "move")}
                                        onTouchStart={e => handleTouchStart(e, task.id, "move")}
                                        onMouseEnter={e => { if (task.estimateItem) { setHoveredTaskId(task.id); setTooltipPos({ x: e.clientX, y: e.clientY }); }}}
                                        onMouseMove={e => { if (task.estimateItem) setTooltipPos({ x: e.clientX, y: e.clientY }); }}
                                        onMouseLeave={() => setHoveredTaskId(null)}
                                    >
                                        <div className="absolute inset-0 rounded-lg transition-all" style={{ width: `${ap}%`, background: `linear-gradient(135deg, ${task.color}cc, ${task.color}99)` }} />
                                        <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg" style={{ backgroundColor: task.color }} />
                                        <div className="relative z-[2] flex items-center justify-between h-full px-2.5 pl-3">
                                            <span className="text-[10px] font-bold truncate" style={{ color: ap > 50 ? "#fff" : task.color, textShadow: ap > 50 ? '0 1px 2px rgba(0,0,0,0.15)' : 'none' }}>{task.name}</span>
                                            {(task.assignments || []).length > 0 && bar.width > 80 && (
                                                <div className="flex -space-x-1.5 ml-1">{(task.assignments || []).slice(0,3).map(a => (
                                                    <div key={a.userId} className="w-5 h-5 rounded-full bg-white text-[7px] font-bold flex items-center justify-center border-2 border-white shadow-sm" style={{ color: task.color }}>{getInitials(a.user.name, a.user.email)}</div>
                                                ))}</div>
                                            )}
                                        </div>
                                        {!(task.actualHours > 0 && task.estimatedHours) && (
                                            <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition z-10" title={`${task.progress}%`}>
                                                <input type="range" min={0} max={100} value={task.progress} onChange={e => handleProgressChange(task.id, parseInt(e.target.value))} onMouseDown={e => e.stopPropagation()} className="w-14 h-1 accent-current cursor-pointer" style={{ accentColor: task.color }} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-r-lg" onMouseDown={e => handleMouseDown(e, task.id, "resize-right")} onTouchStart={e => handleTouchStart(e, task.id, "resize-right")} />
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
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                {selectedTask.type === "milestone" && (
                                    <div className="w-3 h-3 rotate-45 shrink-0" style={{ backgroundColor: selectedTask.color }} />
                                )}
                                <h3 className="text-sm font-bold text-hui-textMain truncate">{selectedTask.name}</h3>
                            </div>
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
                                    {selectedTask.type === "milestone" ? (
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Date</label>
                                            <div className="text-sm font-medium text-hui-textMain mt-1">{selectedTask.startDate}</div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Start</label><div className="text-sm font-medium text-hui-textMain mt-1">{selectedTask.startDate}</div></div>
                                                <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">End</label><div className="text-sm font-medium text-hui-textMain mt-1">{selectedTask.endDate}</div></div>
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estimated Hours</label>
                                                <input type="number" value={selectedTask.estimatedHours ?? ""} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, estimatedHours: v } : t)); updateScheduleTask(selectedTask.id, { estimatedHours: v }); }}} className="hui-input text-sm mt-1 w-full" placeholder="e.g. 40" />
                                            </div>
                                        </>
                                    )}
                                    {/* Estimate Item Link */}
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estimate Link</label>
                                            {selectedTask.estimateItem ? (
                                                <button onClick={() => handleUnlinkEstimateItem(selectedTask.id)} className="text-[10px] text-red-500 hover:text-red-700 font-semibold transition">Remove</button>
                                            ) : (
                                                <div className="relative">
                                                    <button onClick={() => setShowEstimateLinkMenu(v => !v)} className="text-[10px] text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Link</button>
                                                    {showEstimateLinkMenu && (
                                                        <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] max-h-60 overflow-y-auto py-1 animate-in fade-in">
                                                            {estimateItems.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No estimate items found</div>}
                                                            {estimateItems.map(item => (
                                                                <button key={item.id} onClick={() => handleLinkEstimateItem(selectedTask.id, item)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-xs">
                                                                    <div className="font-medium truncate">{item.name}</div>
                                                                    <div className="text-slate-400">{item.type} · {formatCurrency(item.total)}</div>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        {selectedTask.estimateItem ? (
                                            <div className="bg-blue-50 rounded-lg px-3 py-2 border border-blue-100">
                                                <div className="text-xs font-semibold text-blue-800 truncate">{selectedTask.estimateItem.name}</div>
                                                <div className="flex items-center gap-3 mt-1">
                                                    <span className="text-[10px] text-blue-600 capitalize">{selectedTask.estimateItem.type}</span>
                                                    <span className="text-[10px] font-semibold text-blue-700">{formatCurrency(selectedTask.estimateItem.total)} budget</span>
                                                    {selectedTask.estimatedHours && <span className="text-[10px] text-blue-500">{selectedTask.estimatedHours}h est.</span>}
                                                </div>
                                            </div>
                                        ) : (
                                            <p className="text-xs text-slate-400 italic">Not linked to an estimate item</p>
                                        )}
                                    </div>
                                    {/* Critical Path indicator */}
                                    {showCriticalPath && criticalPathIds.has(selectedTask.id) && (
                                        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-2">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                                            <span className="text-xs font-semibold text-red-700">On critical path</span>
                                        </div>
                                    )}
                                    {/* Assigned Members */}
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned</label>
                                            <div className="relative">
                                                <button onClick={() => setShowAssignMenu(!showAssignMenu)} className="text-[10px] text-indigo-600 font-semibold hover:text-indigo-800 transition">+ Add</button>
                                                {showAssignMenu && (
                                                    <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[220px] py-1 animate-in fade-in max-h-60 overflow-y-auto">
                                                        <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50">Team Members</div>
                                                        {teamMembers.filter(m => !(selectedTask.assignments || []).some(a => a.userId === m.id)).map(m => (
                                                            <button key={m.id} onClick={() => handleAssign(m.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold flex items-center justify-center shrink-0">{getInitials(m.name, m.email)}</div>
                                                                <span className="truncate">{m.name || m.email}</span>
                                                            </button>
                                                        ))}
                                                        <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50 mt-1 border-t border-hui-border">Subcontractors</div>
                                                        {subcontractors.filter(s => !(selectedTask.subAssignments || []).some(a => a.subcontractorId === s.id)).map(s => (
                                                            <button key={s.id} onClick={() => handleAssignSub(s.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition flex items-center gap-2 text-xs">
                                                                <div className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[9px] font-bold flex items-center justify-center shrink-0">{s.companyName.substring(0,2).toUpperCase()}</div>
                                                                <span className="truncate flex-1">{s.companyName}</span>
                                                            </button>
                                                        ))}
                                                        {teamMembers.length === 0 && subcontractors.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No options found</div>}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="space-y-1.5">
                                            {(selectedTask.assignments || []).map(a => (
                                                <div key={a.userId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                                                    <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center shrink-0">{getInitials(a.user.name, a.user.email)}</div>
                                                    <span className="text-xs font-medium text-hui-textMain flex-1 truncate">{a.user.name || a.user.email}</span>
                                                    <button onClick={() => handleUnassign(a.userId)} className="text-slate-300 hover:text-red-500 transition shrink-0">
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                    </button>
                                                </div>
                                            ))}
                                            {(selectedTask.subAssignments || []).map(a => (
                                                <div key={a.subcontractorId} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2 border-l-2 border-purple-400">
                                                    <div className="w-7 h-7 rounded-full bg-purple-100 text-purple-700 text-[10px] font-bold flex items-center justify-center shrink-0">{a.subcontractor.companyName.substring(0, 2).toUpperCase()}</div>
                                                    <span className="text-xs font-medium text-hui-textMain flex-1 truncate">{a.subcontractor.companyName} <span className="text-purple-600/70 ml-1 text-[10px]">(Sub)</span></span>
                                                    <button onClick={() => handleUnassignSub(a.subcontractorId)} className="text-slate-300 hover:text-red-500 transition shrink-0">
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                    </button>
                                                </div>
                                            ))}
                                            {(selectedTask.assignments || []).length === 0 && (selectedTask.subAssignments || []).length === 0 && <p className="text-xs text-slate-400 italic">No one assigned</p>}
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

            {/* Hover tooltip for estimate budget */}
            {hoveredTaskId && (() => {
                const task = tasks.find(t => t.id === hoveredTaskId);
                if (!task?.estimateItem) return null;
                return (
                    <div
                        className="fixed z-[100] bg-slate-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none"
                        style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 40 }}
                    >
                        <div className="font-semibold">{task.estimateItem.name}</div>
                        <div className="flex items-center gap-3 mt-1 text-slate-300">
                            <span>Budget: <span className="text-green-400 font-semibold">{formatCurrency(task.estimateItem.total)}</span></span>
                            {task.estimatedHours && <span>{task.estimatedHours}h est.</span>}
                            {task.actualHours > 0 && <span>{task.actualHours.toFixed(1)}h actual</span>}
                        </div>
                    </div>
                );
            })()}

            {/* AI Risk Analysis panel */}
            {showRiskPanel && riskAnalysis && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center">
                    <div className="fixed inset-0 bg-black/40" onClick={() => setShowRiskPanel(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
                        <div className="flex items-center justify-between p-5 border-b border-hui-border">
                            <div className="flex items-center gap-2">
                                <span className="text-xl">⚠️</span>
                                <h2 className="font-bold text-hui-textMain text-lg">Schedule Risk Analysis</h2>
                            </div>
                            <button onClick={() => setShowRiskPanel(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1">
                            <div className="prose prose-sm max-w-none text-hui-textMain whitespace-pre-wrap text-sm leading-relaxed">
                                {riskAnalysis}
                            </div>
                        </div>
                        <div className="p-4 border-t border-hui-border">
                            <button onClick={() => setShowRiskPanel(false)} className="hui-btn hui-btn-secondary text-sm">Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
