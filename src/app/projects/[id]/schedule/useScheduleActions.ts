"use client";

import { useState, useRef, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import {
    createScheduleTask, updateScheduleTask, deleteScheduleTask,
    importEstimateToSchedule, linkTasks, unlinkTasks, clearAllTasks,
    aiGenerateSchedule,
    addTaskComment, getTaskComments, addTaskPunchItem, togglePunchItem,
    deletePunchItem, getTaskPunchItems, aiGeneratePunchlist,
    assignUserToTask, unassignUserFromTask, setTaskLead, assignSubToTask, unassignSubFromTask,
    getEstimateItemsForProject,
} from "@/lib/actions";
import { toast } from "sonner";
import type { Task, EstimateItemSummary, PunchItem, Comment } from "./schedule-types";
import { getDaysBetween, addDays, formatDate, computeCriticalPath } from "./schedule-utils";
import { storedEndDate } from "@/lib/schedule-dates";

export function useScheduleActions(
    projectId: string,
    tasks: Task[],
    setTasks: Dispatch<SetStateAction<Task[]>>,
) {
    // --- Detail panel state ---
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [panelTab, setPanelTab] = useState<"details" | "punch" | "conversation">("details");
    const [punchItems, setPunchItems] = useState<PunchItem[]>([]);
    const [comments, setComments] = useState<Comment[]>([]);
    const [isAiPunching, setIsAiPunching] = useState(false);
    const [estimateItems, setEstimateItems] = useState<EstimateItemSummary[]>([]);

    // --- New task form state ---
    const [isAdding, setIsAdding] = useState(false);
    const [showNewTaskForm, setShowNewTaskForm] = useState(false);
    const [newTaskType, setNewTaskType] = useState<"task" | "milestone">("task");
    const [newTaskName, setNewTaskName] = useState("");
    const [newTaskStart, setNewTaskStart] = useState("");
    const [newTaskEnd, setNewTaskEnd] = useState("");

    // --- Toolbar toggle state ---
    const [linkMode, setLinkMode] = useState<string | null>(null);
    const [showCriticalPath, setShowCriticalPath] = useState(false);
    const [showMoreMenu, setShowMoreMenu] = useState(false);

    // --- AI + Import state ---
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [showAiMenu, setShowAiMenu] = useState(false);
    const [isAiRisk, setIsAiRisk] = useState(false);
    const [showRiskPanel, setShowRiskPanel] = useState(false);
    const [riskAnalysis, setRiskAnalysis] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [showImportMenu, setShowImportMenu] = useState(false);

    // --- Refs ---
    const tasksRef = useRef<Task[]>(tasks);
    useEffect(() => { tasksRef.current = tasks; });

    const selectedTask = tasks.find(t => t.id === selectedTaskId);
    const criticalPathIds = useMemo(() => computeCriticalPath(tasks), [tasks]);
    const today = new Date();

    // Load detail data when task selected
    useEffect(() => {
        if (selectedTaskId) {
            getTaskPunchItems(selectedTaskId).then(items => setPunchItems(items as any));
            getTaskComments(selectedTaskId).then(c => setComments(c.map((x: any) => ({ ...x, createdAt: x.createdAt.toISOString?.() || x.createdAt }))));
        }
    }, [selectedTaskId]);

    // --- Cascade dependents (recursive) ---
    async function cascadeDependents(taskId: string, dayDelta: number, visited: Set<string> = new Set()) {
        if (visited.has(taskId)) return;
        visited.add(taskId);
        const deps = tasksRef.current.filter(t => t.dependencies.some(d => d.predecessorId === taskId));
        for (const dep of deps) {
            if (visited.has(dep.id)) continue;
            const prevStart = dep.startDate;
            const prevEnd = dep.endDate;
            const ns = formatDate(addDays(new Date(dep.startDate), dayDelta));
            const ne = dep.type === "milestone" ? ns : formatDate(addDays(new Date(dep.endDate), dayDelta));
            setTasks(prev => prev.map(t => t.id === dep.id ? { ...t, startDate: ns, endDate: ne } : t));
            const res = await updateScheduleTask(dep.id, { startDate: ns, endDate: ne });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === dep.id ? { ...t, startDate: prevStart, endDate: prevEnd } : t));
                toast.error(res.error);
                continue;
            }
            await cascadeDependents(dep.id, dayDelta, visited);
        }
    }

    // --- New task form ---
    function openNewTaskForm(type: "task" | "milestone") {
        setNewTaskType(type);
        setNewTaskName(type === "milestone" ? "New Milestone" : "New Task");
        setNewTaskStart(formatDate(today));
        setNewTaskEnd(type === "milestone" ? formatDate(today) : formatDate(addDays(today, 4)));
        setShowNewTaskForm(true);
    }

    async function handleAddTask() {
        if (!newTaskName.trim()) { toast.error("Name is required"); return; }
        if (!newTaskStart || (newTaskType !== "milestone" && !newTaskEnd)) { toast.error("Dates are required"); return; }
        if (newTaskType !== "milestone" && newTaskStart > newTaskEnd) { toast.error("End date must be on or after start date"); return; }
        setIsAdding(true);
        try {
            const start = newTaskStart;
            const displayEnd = newTaskType === "milestone" ? start : newTaskEnd;
            const end = storedEndDate(start, displayEnd, newTaskType);
            const res = await createScheduleTask(projectId, { name: newTaskName.trim(), startDate: start, endDate: end, type: newTaskType });
            if (!res.ok) { toast.error(res.error); return; }
            const created = res.task as any;
            const createdStart = created.startDate instanceof Date ? created.startDate.toISOString().slice(0, 10) : created.startDate;
            const createdEnd = created.endDate instanceof Date ? created.endDate.toISOString().slice(0, 10) : created.endDate;
            setTasks(prev => [...prev, { ...created, startDate: createdStart, endDate: createdEnd, type: newTaskType, actualHours: 0, estimatedHours: null, doneWhen: null, blockedReason: null, clientStage: null, scheduledTime: null, confirmationStatus: null, dependencies: [], dependents: [], assignments: [], estimateItemId: null, estimateItem: null }]);
            toast.success(newTaskType === "milestone" ? "Milestone added" : "Task added");
            setShowNewTaskForm(false);
        } finally { setIsAdding(false); }
    }

    // --- Task CRUD ---
    // `value` arriving here is already a STORED date — TaskDetailPanel and
    // TableView convert from the displayed inclusive date before calling.
    async function handleDateChange(taskId: string, field: "startDate" | "endDate", value: string) {
        if (!value) return;
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        if (task.type === "milestone") {
            const oldStart = task.startDate;
            const oldEnd = task.endDate;
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, startDate: value, endDate: value } : t));
            const res = await updateScheduleTask(taskId, { startDate: value, endDate: value });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, startDate: oldStart, endDate: oldEnd } : t));
                toast.error(res.error);
                return;
            }
            if (value !== oldStart) {
                const dayDelta = getDaysBetween(new Date(oldStart), new Date(value));
                if (dayDelta !== 0) await cascadeDependents(taskId, dayDelta);
            }
            return;
        }
        if (field === "startDate" && value >= task.endDate) { toast.error("Start date must be on or before the end date"); return; }
        if (field === "endDate" && value <= task.startDate) { toast.error("End date must be on or after the start date"); return; }
        const oldStart = task.startDate;
        const oldEnd = task.endDate;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, [field]: value } : t));
        const res = await updateScheduleTask(taskId, { [field]: value });
        if (!res.ok) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, startDate: oldStart, endDate: oldEnd } : t));
            toast.error(res.error);
            return;
        }
        if (field === "startDate" && value !== oldStart) {
            const dayDelta = getDaysBetween(new Date(oldStart), new Date(value));
            if (dayDelta !== 0) await cascadeDependents(taskId, dayDelta);
        }
    }

    async function handleStatusChange(taskId: string, status: string, blockedReason?: string) {
        if (status === "Blocked" && !blockedReason?.trim()) {
            const promptedReason = window.prompt("Why is this task blocked?", "");
            if (!promptedReason?.trim()) return;
            blockedReason = promptedReason.trim();
        }
        const previous = tasksRef.current.find(t => t.id === taskId);
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status, blockedReason: status === "Blocked" ? (blockedReason ?? t.blockedReason) : null } : t));
        try {
            const res = await updateScheduleTask(taskId, { status, blockedReason: status === "Blocked" ? blockedReason : null });
            if (!res.ok) {
                if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
                toast.error(res.error);
            }
        } catch (error) {
            if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
            toast.error(error instanceof Error ? error.message : "Failed to update status");
        }
    }

    async function handleDoneWhenChange(taskId: string, doneWhen: string | null) {
        const previous = tasksRef.current.find(t => t.id === taskId)?.doneWhen ?? null;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, doneWhen } : t));
        try {
            const res = await updateScheduleTask(taskId, { doneWhen });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, doneWhen: previous } : t));
                toast.error(res.error);
            }
        } catch (error) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, doneWhen: previous } : t));
            toast.error(error instanceof Error ? error.message : "Failed to update completion criteria");
        }
    }

    async function handleClientStageChange(taskId: string, clientStage: string | null) {
        const previous = tasksRef.current.find(t => t.id === taskId)?.clientStage ?? null;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, clientStage } : t));
        try {
            const res = await updateScheduleTask(taskId, { clientStage });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, clientStage: previous } : t));
                toast.error(res.error);
            }
        } catch (error) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, clientStage: previous } : t));
            toast.error(error instanceof Error ? error.message : "Failed to update client stage");
        }
    }

    async function handleAppointmentChange(taskId: string, data: { scheduledTime?: string | null; confirmationStatus?: "planned" | "requested" | "confirmed" | null }) {
        const previous = tasksRef.current.find(t => t.id === taskId);
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...data } : t));
        try {
            const res = await updateScheduleTask(taskId, data);
            if (!res.ok) {
                if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
                toast.error(res.error);
            }
        } catch (error) {
            if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
            toast.error(error instanceof Error ? error.message : "Failed to update appointment");
        }
    }

    async function handleColorChange(taskId: string, color: string) {
        const previous = tasksRef.current.find(t => t.id === taskId)?.color;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color } : t));
        try {
            const res = await updateScheduleTask(taskId, { color });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color: previous ?? t.color } : t));
                toast.error(res.error);
            }
        } catch (error) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, color: previous ?? t.color } : t));
            toast.error(error instanceof Error ? error.message : "Failed to update color");
        }
    }

    async function handleDelete(taskId: string) {
        const previousTasks = tasksRef.current;
        const wasSelected = selectedTaskId === taskId;
        setTasks(prev => prev.filter(t => t.id !== taskId));
        if (wasSelected) setSelectedTaskId(null);
        try {
            const res = await deleteScheduleTask(taskId);
            if (!res.ok) {
                setTasks(previousTasks);
                if (wasSelected) setSelectedTaskId(taskId);
                toast.error(res.error);
                return;
            }
            toast.success("Task deleted");
        } catch (error) {
            setTasks(previousTasks);
            if (wasSelected) setSelectedTaskId(taskId);
            toast.error(error instanceof Error ? error.message : "Failed to delete task");
        }
    }

    async function handleNameSave(taskId: string, name: string) {
        const previous = tasksRef.current.find(t => t.id === taskId)?.name;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name } : t));
        try {
            const res = await updateScheduleTask(taskId, { name });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: previous ?? t.name } : t));
                toast.error(res.error);
            }
        } catch (error) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, name: previous ?? t.name } : t));
            toast.error(error instanceof Error ? error.message : "Failed to save name");
        }
    }

    async function handleEstimatedHoursSave(taskId: string, hours: number) {
        const previous = tasksRef.current.find(t => t.id === taskId)?.estimatedHours ?? null;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: hours } : t));
        try {
            const res = await updateScheduleTask(taskId, { estimatedHours: hours });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: previous } : t));
                toast.error(res.error);
            }
        } catch (error) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimatedHours: previous } : t));
            toast.error(error instanceof Error ? error.message : "Failed to save estimated hours");
        }
    }

    async function handleProgressChange(taskId: string, progress: number) {
        const previous = tasksRef.current.find(t => t.id === taskId)?.progress;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress } : t));
        try {
            const res = await updateScheduleTask(taskId, { progress });
            if (!res.ok) {
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress: previous ?? t.progress } : t));
                toast.error(res.error);
            }
        } catch (error) {
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress: previous ?? t.progress } : t));
            toast.error(error instanceof Error ? error.message : "Failed to save progress");
        }
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

    async function handleLinkPredecessor(predId: string) {
        if (!selectedTaskId) return;
        try {
            const dep = await linkTasks(predId, selectedTaskId);
            setTasks(prev => prev.map(t => {
                if (t.id === selectedTaskId) return { ...t, dependencies: [...t.dependencies, { id: dep.id, predecessorId: predId, dependentId: selectedTaskId }] };
                if (t.id === predId) return { ...t, dependents: [...t.dependents, { id: dep.id, predecessorId: predId, dependentId: selectedTaskId }] };
                return t;
            }));
            toast.success("Predecessor added");
        } catch { toast.error("Already linked or invalid"); }
    }

    async function handleUnlinkPredecessor(predId: string) {
        if (!selectedTaskId) return;
        await unlinkTasks(predId, selectedTaskId);
        setTasks(prev => prev.map(t => ({
            ...t,
            dependencies: t.dependencies.filter(d => !(d.predecessorId === predId && d.dependentId === selectedTaskId)),
            dependents: t.dependents.filter(d => !(d.predecessorId === predId && d.dependentId === selectedTaskId)),
        })));
        toast.success("Predecessor removed");
    }

    async function handleUnlink(pid: string, did: string) {
        await unlinkTasks(pid, did);
        setTasks(prev => prev.map(t => ({
            ...t,
            dependencies: t.dependencies.filter(d => !(d.predecessorId === pid && d.dependentId === did)),
            dependents: t.dependents.filter(d => !(d.predecessorId === pid && d.dependentId === did)),
        })));
        toast.success("Link removed");
    }

    // --- AI + Import ---
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
                doneWhen: null, blockedReason: null, clientStage: null, scheduledTime: null, confirmationStatus: null,
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

    async function handleImportEstimate(estimateId: string) {
        setIsImporting(true);
        setShowImportMenu(false);
        try {
            const newTasks = await importEstimateToSchedule(projectId, estimateId);
            setTasks(prev => [...prev, ...newTasks.map((t: any) => ({
                ...t,
                startDate: formatDate(new Date(t.startDate)),
                endDate: formatDate(new Date(t.endDate)),
                type: "task" as const,
                actualHours: 0, estimatedHours: null,
                doneWhen: null, blockedReason: null, clientStage: null, scheduledTime: null, confirmationStatus: null,
                dependencies: [], dependents: [], assignments: [],
                estimateItemId: t.estimateItemId || null, estimateItem: null,
            }))]);
            toast.success(`Imported ${newTasks.length} tasks`);
        } catch { toast.error("Import failed"); }
        finally { setIsImporting(false); }
    }

    async function handleClearAll() {
        if (!confirm("Delete ALL tasks from this schedule? This cannot be undone.")) return;
        setShowMoreMenu(false);
        await clearAllTasks(projectId);
        setTasks([]);
        setSelectedTaskId(null);
        toast.success("Schedule cleared");
    }

    function handleSyncCalendar() {
        if (tasks.length === 0) { toast.error("No tasks to sync"); return; }
        const a = document.createElement("a");
        a.href = `/api/calendar/sync?projectId=${projectId}`;
        a.download = "schedule.ics";
        a.click();
        toast.success("Calendar file downloaded — import into Google Calendar, Apple Calendar, or Outlook");
    }

    // --- Estimate linking ---
    async function handleLinkEstimateItem(taskId: string, item: EstimateItemSummary) {
        const autoHours = (item.type === "Labor" || item.budgetUnit === "hours") ? (item.quantity ?? null) : null;
        const taskName = tasks.find(t => t.id === taskId)?.name ?? "";
        const previous = tasksRef.current.find(t => t.id === taskId);
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimateItemId: item.id, estimateItem: item, ...(autoHours != null ? { estimatedHours: autoHours } : {}) } : t));
        setEstimateItems(prev => prev.map(ei => ei.id === item.id ? { ...ei, linkedTaskId: taskId, linkedTaskName: taskName } : ei));
        try {
            const res = await updateScheduleTask(taskId, { estimateItemId: item.id });
            if (!res.ok) {
                if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
                setEstimateItems(prev => prev.map(ei => ei.id === item.id ? { ...ei, linkedTaskId: null, linkedTaskName: null } : ei));
                toast.error(res.error);
                return;
            }
            toast.success(autoHours != null ? `Linked — ${autoHours}h estimated` : "Linked to estimate item");
        } catch (error) {
            if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
            setEstimateItems(prev => prev.map(ei => ei.id === item.id ? { ...ei, linkedTaskId: null, linkedTaskName: null } : ei));
            toast.error(error instanceof Error ? error.message : "Failed to link estimate item");
        }
    }

    async function handleUnlinkEstimateItem(taskId: string) {
        const itemId = tasks.find(t => t.id === taskId)?.estimateItemId;
        const previous = tasksRef.current.find(t => t.id === taskId);
        const previousItem = itemId ? estimateItems.find(ei => ei.id === itemId) : undefined;
        const previousLinkedTaskId = previousItem?.linkedTaskId ?? null;
        const previousLinkedTaskName = previousItem?.linkedTaskName ?? null;
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, estimateItemId: null, estimateItem: null } : t));
        if (itemId) setEstimateItems(prev => prev.map(ei => ei.id === itemId ? { ...ei, linkedTaskId: null, linkedTaskName: null } : ei));
        try {
            const res = await updateScheduleTask(taskId, { estimateItemId: null });
            if (!res.ok) {
                if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
                if (itemId) setEstimateItems(prev => prev.map(ei => ei.id === itemId ? { ...ei, linkedTaskId: previousLinkedTaskId, linkedTaskName: previousLinkedTaskName } : ei));
                toast.error(res.error);
                return;
            }
            toast.success("Estimate link removed");
        } catch (error) {
            if (previous) setTasks(prev => prev.map(t => t.id === taskId ? previous : t));
            if (itemId) setEstimateItems(prev => prev.map(ei => ei.id === itemId ? { ...ei, linkedTaskId: previousLinkedTaskId, linkedTaskName: previousLinkedTaskName } : ei));
            toast.error(error instanceof Error ? error.message : "Failed to remove estimate link");
        }
    }

    function fetchEstimateItems() {
        getEstimateItemsForProject(projectId).then(items => setEstimateItems(items as any));
    }

    // --- Detail panel: punch, comments, assignments ---
    async function handleAddPunch(name: string) {
        if (!name || !selectedTaskId) return;
        const item = await addTaskPunchItem(selectedTaskId, name);
        setPunchItems(prev => [...prev, item as any]);
    }

    async function handleTogglePunch(id: string) {
        await togglePunchItem(id);
        setPunchItems(prev => prev.map(p => p.id === id ? { ...p, completed: !p.completed } : p));
    }

    async function handleDeletePunch(id: string) {
        await deletePunchItem(id);
        setPunchItems(prev => prev.filter(p => p.id !== id));
    }

    async function handleAiPunchlist() {
        if (!selectedTaskId) return;
        setIsAiPunching(true);
        try {
            const items = await aiGeneratePunchlist(selectedTaskId);
            setPunchItems(prev => [...prev, ...(items as any)]);
            toast.success(`AI generated ${items.length} punch items`);
        } catch { toast.error("AI punchlist failed"); }
        finally { setIsAiPunching(false); }
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
        try {
            const a = await assignUserToTask(selectedTaskId, userId);
            setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: [...(t.assignments || []), a as any] } : t));
            toast.success("Member assigned");
        } catch { toast.error("Already assigned"); }
    }

    async function handleUnassign(userId: string) {
        if (!selectedTaskId) return;
        await unassignUserFromTask(selectedTaskId, userId);
        setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: (t.assignments || []).filter(a => a.userId !== userId) } : t));
    }

    async function handleSetLead(userId: string | null) {
        if (!selectedTaskId) return;
        try {
            const assignments = await setTaskLead(selectedTaskId, userId);
            setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, assignments: assignments as any } : t));
            toast.success(userId ? "Task lead updated" : "Task lead removed");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to update task lead");
        }
    }

    async function handleAssignSub(subId: string) {
        if (!selectedTaskId) return;
        try {
            const a = await assignSubToTask(selectedTaskId, subId);
            setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, subAssignments: [...(t.subAssignments || []), a as any] } : t));
            toast.success("Subcontractor assigned");
        } catch { toast.error("Already assigned"); }
    }

    async function handleUnassignSub(subId: string) {
        if (!selectedTaskId) return;
        await unassignSubFromTask(selectedTaskId, subId);
        setTasks(prev => prev.map(t => t.id === selectedTaskId ? { ...t, subAssignments: (t.subAssignments || []).filter(a => a.subcontractorId !== subId) } : t));
    }

    function selectTask(taskId: string) {
        setSelectedTaskId(taskId);
        setPanelTab("details");
    }

    return {
        // Selected task + panel
        selectedTaskId, setSelectedTaskId, selectedTask,
        panelTab, setPanelTab,

        // New task form
        isAdding, showNewTaskForm, setShowNewTaskForm,
        newTaskType, newTaskName, newTaskStart, newTaskEnd,
        setNewTaskName, setNewTaskStart, setNewTaskEnd,
        openNewTaskForm, handleAddTask,

        // Task CRUD
        handleDateChange, handleStatusChange, handleDoneWhenChange, handleClientStageChange, handleAppointmentChange, handleColorChange,
        handleDelete, handleNameSave, handleEstimatedHoursSave,
        handleProgressChange, cascadeDependents,

        // Linking
        linkMode, setLinkMode,
        handleTaskClick, handleLinkPredecessor, handleUnlinkPredecessor, handleUnlink,

        // AI + Import
        handleAiSchedule, isAiGenerating, showAiMenu, setShowAiMenu,
        handleAiRisk, isAiRisk, showRiskPanel, setShowRiskPanel, riskAnalysis,
        handleImportEstimate, isImporting, showImportMenu, setShowImportMenu,
        handleClearAll, handleSyncCalendar,

        // Toolbar toggles
        showCriticalPath, setShowCriticalPath,
        showMoreMenu, setShowMoreMenu,
        criticalPathIds,

        // Estimate linking
        estimateItems, handleLinkEstimateItem, handleUnlinkEstimateItem, fetchEstimateItems,

        // Detail panel
        punchItems, handleAddPunch, handleTogglePunch, handleDeletePunch,
        handleAiPunchlist, isAiPunching,
        comments, handleAddComment,
        handleAssign, handleUnassign, handleSetLead, handleAssignSub, handleUnassignSub,
        selectTask,
    };
}
