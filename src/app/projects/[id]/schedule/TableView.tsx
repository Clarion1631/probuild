"use client";

import { useState, useEffect, useMemo, useRef, useCallback, type Dispatch, type SetStateAction } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import {
    updateScheduleTask, linkTasks, unlinkTasks, reorderScheduleTasks,
} from "@/lib/actions";
import { toast } from "sonner";
import type { Task, EstimateSummary, TeamMember, Subcontractor, SortKey, SortDir, FilterState } from "./schedule-types";
import { STATUS_OPTIONS, STATUS_COLORS, getDaysBetween, addDays, formatDate, getInitials, formatCurrency } from "./schedule-utils";
import { useScheduleActions } from "./useScheduleActions";
import TaskDetailPanel from "./TaskDetailPanel";
import DependencyPicker from "./DependencyPicker";
import ScheduleToolbar from "./ScheduleToolbar";
import ScheduleEmptyState from "./ScheduleEmptyState";
import RiskAnalysisModal from "./RiskAnalysisModal";
import ColorPicker from "./ColorPicker";
import ProgressPopover from "./ProgressPopover";

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

export default function TableView({ projectId, projectName, tasks, setTasks, estimates = [], teamMembers = [], subcontractors = [], initialPublished, viewMode, onViewModeChange }: {
    projectId: string;
    projectName: string;
    tasks: Task[];
    setTasks: Dispatch<SetStateAction<Task[]>>;
    estimates?: EstimateSummary[];
    teamMembers?: TeamMember[];
    subcontractors?: Subcontractor[];
    initialPublished: boolean;
    viewMode?: "gantt" | "table" | "calendar";
    onViewModeChange?: (mode: "gantt" | "table" | "calendar") => void;
}) {
    const actions = useScheduleActions(projectId, tasks, setTasks);

    // Table-specific local state
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
    const [editingCell, setEditingCell] = useState<{ taskId: string; field: string } | null>(null);
    const [editValue, setEditValue] = useState("");
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [depsPopoverId, setDepsPopoverId] = useState<string | null>(null);
    const [progressPopoverId, setProgressPopoverId] = useState<string | null>(null);
    const [depsPickerId, setDepsPickerId] = useState<string | null>(null);
    const editRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

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

    useEffect(() => {
        setSearchInput(prev => prev === filters.q ? prev : filters.q);
    }, [filters.q]);

    useEffect(() => {
        const t = setTimeout(() => {
            if (searchInput !== filters.q) updateUrl({ q: searchInput || null });
        }, 300);
        return () => clearTimeout(t);
    }, [searchInput, filters.q, updateUrl]);

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
        const priorOrder = new Map(tasks.map(t => [t.id, t.order]));

        setTasks(p => p.map(t => newOrderMap.has(t.id) ? { ...t, order: newOrderMap.get(t.id)! } : t));
        try {
            await reorderScheduleTasks(projectId, newOrderIds);
        } catch {
            setTasks(p => p.map(t => priorOrder.has(t.id) ? { ...t, order: priorOrder.get(t.id)! } : t));
            toast.error("Failed to reorder tasks");
        }
    }

    // --- Inline editing (table-specific) ---
    function startEdit(taskId: string, field: string, currentValue: string) {
        setEditingCell({ taskId, field }); setEditValue(currentValue);
    }
    async function commitEdit() {
        if (!editingCell) return;
        const { taskId, field } = editingCell;
        if (field === "name" && editValue.trim()) {
            actions.handleNameSave(taskId, editValue.trim());
        } else if (field === "estimatedHours") {
            const h = parseFloat(editValue);
            if (!isNaN(h) && h >= 0) {
                actions.handleEstimatedHoursSave(taskId, h);
            }
        }
        setEditingCell(null);
    }

    // --- Table-specific dependency helpers (for inline deps popover) ---
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

    // --- Sort header helper ---
    function SortHeader({ label, sortable, field }: { label: string; sortable: boolean; field?: SortKey }) {
        if (!sortable || !field) return <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</span>;
        return (
            <button onClick={() => handleSort(field)} className="text-[10px] font-bold text-slate-400 uppercase tracking-wider hover:text-slate-600 transition flex items-center gap-1 group">
                {label}
                <span className={`transition ${sortKey === field ? "text-indigo-500" : "text-slate-300 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"}`}>
                    {sortKey === field && sortDir === "desc" ? "▼" : "▲"}
                </span>
            </button>
        );
    }

    // --- EMPTY STATE ---
    if (tasks.length === 0) {
        return (
            <div className="flex flex-col h-full">
                <ScheduleEmptyState
                    estimates={estimates}
                    isAdding={actions.isAdding}
                    isAiGenerating={actions.isAiGenerating}
                    isImporting={actions.isImporting}
                    showAiMenu={actions.showAiMenu}
                    showImportMenu={actions.showImportMenu}
                    onAddTask={() => actions.openNewTaskForm("task")}
                    onToggleAiMenu={() => actions.setShowAiMenu(!actions.showAiMenu)}
                    onAiSchedule={actions.handleAiSchedule}
                    onToggleImportMenu={() => actions.setShowImportMenu(!actions.showImportMenu)}
                    onImportEstimate={actions.handleImportEstimate}
                    viewMode={viewMode}
                    onViewModeChange={onViewModeChange}
                />
                {actions.showNewTaskForm && (
                    <div className="fixed inset-0 z-[200] flex items-center justify-center">
                        <div className="fixed inset-0 bg-black/40" onClick={() => actions.setShowNewTaskForm(false)} />
                        <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
                            <h3 className="text-sm font-bold text-hui-textMain mb-4">{actions.newTaskType === "milestone" ? "New Milestone" : "New Task"}</h3>
                            <div className="space-y-3">
                                <input value={actions.newTaskName} onChange={e => actions.setNewTaskName(e.target.value)} className="hui-input text-sm w-full" placeholder="Task name" autoFocus onKeyDown={e => { if (e.key === "Enter") actions.handleAddTask(); if (e.key === "Escape") actions.setShowNewTaskForm(false); }} />
                                <div className="grid grid-cols-2 gap-3">
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Start</label><input type="date" value={actions.newTaskStart} onChange={e => actions.setNewTaskStart(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>
                                    {actions.newTaskType !== "milestone" && <div><label className="text-[10px] font-bold text-slate-400 uppercase">End</label><input type="date" value={actions.newTaskEnd} onChange={e => actions.setNewTaskEnd(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>}
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 mt-5">
                                <button onClick={() => actions.setShowNewTaskForm(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                                <button onClick={actions.handleAddTask} disabled={actions.isAdding} className="hui-btn hui-btn-primary text-xs">{actions.isAdding ? "Adding..." : "Add"}</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const completedCount = tasks.filter(t => t.status === "Complete").length;

    // Build secondary content for ScheduleToolbar (search/filter/sort + filter chips)
    const secondaryContent = (
        <>
            <div className="bg-white border-b border-hui-border shrink-0 relative z-20 px-6 py-2 flex items-center gap-2 flex-wrap">
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
                                <div className="mb-4">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned to</label>
                                    <select value={filters.assignee || ""} onChange={e => updateUrl({ assignee: e.target.value || null })} className="hui-input text-xs w-full mt-1.5">
                                        <option value="">Anyone</option>
                                        {teamMembers.length > 0 && <optgroup label="Team">{teamMembers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}</optgroup>}
                                        {subcontractors.length > 0 && <optgroup label="Subcontractors">{subcontractors.map(s => <option key={s.id} value={s.id}>{s.companyName}</option>)}</optgroup>}
                                    </select>
                                </div>
                                <div className="mb-3">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Start date range</label>
                                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                                        <div>
                                            <span className="text-[9px] font-semibold text-slate-500 block mb-0.5">From (on or after)</span>
                                            <input type="date" value={filters.startFrom || ""} max={filters.startTo || undefined} onChange={e => updateUrl({ from: e.target.value || null })} className="hui-input text-xs w-full" />
                                        </div>
                                        <div>
                                            <span className="text-[9px] font-semibold text-slate-500 block mb-0.5">To (on or before)</span>
                                            <input type="date" value={filters.startTo || ""} min={filters.startFrom || undefined} onChange={e => updateUrl({ to: e.target.value || null })} className="hui-input text-xs w-full" />
                                        </div>
                                    </div>
                                    {(filters.startFrom || filters.startTo) && (
                                        <button onClick={() => updateUrl({ from: null, to: null })} className="text-[10px] text-indigo-600 hover:text-indigo-800 font-medium mt-1.5 transition">Clear dates</button>
                                    )}
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
        </>
    );

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <ScheduleToolbar
                projectId={projectId}
                initialPublished={initialPublished}
                taskCount={tasks.length}
                completedCount={completedCount}
                filteredCount={filtersActive ? filteredSortedTasks.length : undefined}
                estimates={estimates}
                viewMode={viewMode}
                onViewModeChange={onViewModeChange}
                isAdding={actions.isAdding}
                onAddTask={() => actions.openNewTaskForm("task")}
                onAddMilestone={() => actions.openNewTaskForm("milestone")}
                isAiGenerating={actions.isAiGenerating}
                showAiMenu={actions.showAiMenu}
                onToggleAiMenu={() => actions.setShowAiMenu(!actions.showAiMenu)}
                onAiSchedule={actions.handleAiSchedule}
                showToolsMenu={actions.showMoreMenu}
                onToggleToolsMenu={() => actions.setShowMoreMenu(!actions.showMoreMenu)}
                showCriticalPath={actions.showCriticalPath}
                onToggleCriticalPath={() => actions.setShowCriticalPath((v: boolean) => !v)}
                linkMode={actions.linkMode}
                onToggleLinkMode={() => actions.setLinkMode(actions.linkMode ? null : "__awaiting__")}
                onSyncCalendar={actions.handleSyncCalendar}
                isAiRisk={actions.isAiRisk}
                onAiRisk={actions.handleAiRisk}
                isImporting={actions.isImporting}
                onImportEstimate={actions.handleImportEstimate}
                onClearAll={actions.handleClearAll}
                secondaryContent={secondaryContent}
            />

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

                        {filteredSortedTasks.length === 0 && (
                            <div className="px-6 py-10 text-center text-sm text-slate-400">
                                <p>No tasks match your filters.</p>
                                <button onClick={clearAllFilters} className="text-indigo-600 hover:text-indigo-800 font-medium mt-2 text-xs">Clear all filters</button>
                            </div>
                        )}

                        <DragDropContext onDragEnd={handleDragEnd}>
                            <Droppable droppableId="schedule-tasks">
                                {(dropProvided) => (
                                    <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                                        {filteredSortedTasks.map((task, index) => {
                                            const duration = getDaysBetween(new Date(task.startDate), new Date(task.endDate));
                                            const isSelected = task.id === actions.selectedTaskId;
                                            const isCritical = actions.showCriticalPath && actions.criticalPathIds.has(task.id);
                                            const isLinkSource = actions.linkMode === task.id;
                                            const progress = (task.estimatedHours && task.estimatedHours > 0 && task.actualHours > 0) ? Math.min(100, Math.round((task.actualHours / task.estimatedHours) * 100)) : task.progress;

                                            return (
                                                <Draggable key={task.id} draggableId={task.id} index={index} isDragDisabled={!canDrag}>
                                                    {(dragProvided, snapshot) => (
                                                        <div
                                                            ref={dragProvided.innerRef}
                                                            {...dragProvided.draggableProps}
                                                            onClick={() => { if (actions.linkMode) { if (actions.linkMode === "__awaiting__") actions.setLinkMode(task.id); else actions.handleTaskClick(task.id); } else actions.selectTask(task.id); }}
                                                            className={`grid items-center border-b border-slate-100 cursor-pointer transition group hover:bg-slate-50 ${isSelected ? "bg-indigo-50/60 ring-1 ring-inset ring-indigo-200" : ""} ${isLinkSource ? "bg-amber-50" : ""} ${isCritical ? "border-l-[3px] border-l-red-500" : ""} ${snapshot.isDragging ? "shadow-xl bg-white ring-2 ring-indigo-300 z-50" : ""}`}
                                                            style={{ ...dragProvided.draggableProps.style, gridTemplateColumns: GRID_COLS }}
                                                        >
                                                            <div
                                                                {...(canDrag ? dragProvided.dragHandleProps : {})}
                                                                onClick={e => {
                                                                    e.stopPropagation();
                                                                    if (canDrag) return;
                                                                    setSearchInput("");
                                                                    updateUrl({ sort: "manual", dir: "asc", q: null, status: null, type: null, assignee: null, from: null, to: null });
                                                                }}
                                                                title={canDrag ? "Drag to reorder" : (filtersActive && sortKey === "manual") ? "Reordering disabled while filters are active — click to clear filters" : `Sorted by ${SORT_OPTIONS.find(o => o.key === sortKey && o.dir === sortDir)?.label || sortKey}${filtersActive ? " with filters" : ""} — click to enable manual reordering`}
                                                                className={`flex items-center justify-center self-stretch transition ${canDrag ? "text-slate-300 hover:text-indigo-600 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto" : "text-slate-200 hover:text-indigo-400 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto cursor-pointer"}`}
                                                            >
                                                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>
                                                            </div>
                                                            <div className="px-2 py-2 flex items-center">
                                                                <div className="relative">
                                                                    <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); setProgressPopoverId(null); }} className={`w-4 h-4 rounded-full border border-white shadow-sm ring-1 ${task.color?.toLowerCase() === "#ffffff" ? "ring-slate-400" : "ring-slate-200"}`} style={{ backgroundColor: task.color }} />
                                                                    {colorPickerId === task.id && (
                                                                        <ColorPicker selected={task.color} onPick={c => actions.handleColorChange(task.id, c)} onClose={() => setColorPickerId(null)} className="absolute left-0 top-full mt-1 z-50 min-w-[200px]" />
                                                                    )}
                                                                </div>
                                                            </div>
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
                                                            <div className="px-3 py-2">
                                                                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${task.type === "milestone" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                                                                    {task.type === "milestone" ? "Mile." : "Task"}
                                                                </span>
                                                            </div>
                                                            <div className="px-3 py-2">
                                                                <input type="date" value={task.startDate} onChange={e => { e.stopPropagation(); actions.handleDateChange(task.id, "startDate", e.target.value); }} onClick={e => e.stopPropagation()} className="bg-transparent text-xs text-hui-textMain cursor-pointer hover:text-indigo-600 transition w-full border-0 p-0 focus:ring-0" />
                                                            </div>
                                                            <div className="px-3 py-2">
                                                                {task.type === "milestone" ? (
                                                                    <span className="text-slate-300">—</span>
                                                                ) : (
                                                                    <input type="date" value={task.endDate} onChange={e => { e.stopPropagation(); actions.handleDateChange(task.id, "endDate", e.target.value); }} onClick={e => e.stopPropagation()} className="bg-transparent text-xs text-hui-textMain cursor-pointer hover:text-indigo-600 transition w-full border-0 p-0 focus:ring-0" />
                                                                )}
                                                            </div>
                                                            <div className="px-3 py-2 text-hui-textMuted">{task.type === "milestone" ? "0d" : `${duration}d`}</div>
                                                            <div className="px-3 py-2">
                                                                <select value={task.status} onChange={e => { e.stopPropagation(); actions.handleStatusChange(task.id, e.target.value); }} onClick={e => e.stopPropagation()} className={`text-[10px] font-semibold px-2 py-1 rounded-full border-0 cursor-pointer ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-600"}`}>
                                                                    {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                                                </select>
                                                            </div>
                                                            <div className="px-3 py-2">
                                                                <div className="relative inline-block" onClick={e => e.stopPropagation()}>
                                                                    <button
                                                                        onClick={() => {
                                                                            setProgressPopoverId(progressPopoverId === task.id ? null : task.id);
                                                                            setDepsPopoverId(null);
                                                                            setDepsPickerId(null);
                                                                            setColorPickerId(null);
                                                                        }}
                                                                        className="flex items-center gap-2 group/progress cursor-pointer"
                                                                        title="View time entries"
                                                                    >
                                                                        <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                                            <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, backgroundColor: task.color + "cc" }} />
                                                                        </div>
                                                                        <span className="text-[10px] text-slate-500 w-7 text-right group-hover/progress:text-indigo-600 transition">{progress}%</span>
                                                                    </button>
                                                                    {progressPopoverId === task.id && (
                                                                        <ProgressPopover
                                                                            taskId={task.id}
                                                                            taskColor={task.color}
                                                                            progress={progress}
                                                                            estimatedHours={task.estimatedHours}
                                                                            actualHours={task.actualHours}
                                                                            projectId={projectId}
                                                                            onClose={() => setProgressPopoverId(null)}
                                                                        />
                                                                    )}
                                                                </div>
                                                            </div>
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
                                                            <div className="px-3 py-2 text-right">
                                                                {editingCell?.taskId === task.id && editingCell.field === "estimatedHours" ? (
                                                                    <input ref={editRef as any} type="number" value={editValue} onChange={e => setEditValue(e.target.value)} onBlur={commitEdit} onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingCell(null); }} className="hui-input text-xs w-16 py-0.5 text-right" onClick={e => e.stopPropagation()} />
                                                                ) : (
                                                                    <span className="text-hui-textMuted cursor-pointer hover:text-indigo-600" onDoubleClick={e => { e.stopPropagation(); startEdit(task.id, "estimatedHours", String(task.estimatedHours ?? "")); }}>
                                                                        {task.estimatedHours != null ? `${task.estimatedHours}h` : "—"}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="px-3 py-2 text-right text-hui-textMuted">{task.actualHours > 0 ? `${task.actualHours.toFixed(1)}h` : "—"}</div>
                                                            <div className="px-3 py-2">
                                                                <div className="relative inline-block" onClick={e => e.stopPropagation()}>
                                                                    <button
                                                                        onClick={() => { setDepsPopoverId(depsPopoverId === task.id ? null : task.id); setDepsPickerId(null); setProgressPopoverId(null); }}
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
                                                                                <button onClick={() => setDepsPickerId(depsPickerId === task.id ? null : task.id)} className="w-full text-left px-2 py-1.5 hover:bg-indigo-50 transition text-xs text-indigo-600 font-semibold rounded">
                                                                                    + Add predecessor
                                                                                </button>
                                                                                {depsPickerId === task.id && (
                                                                                    <DependencyPicker task={task} allTasks={tasks} onPick={(predId) => addPredecessor(task.id, predId)} onClose={() => setDepsPickerId(null)} align="left" />
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="px-2 py-2">
                                                                <button onClick={e => { e.stopPropagation(); if (confirm("Delete this task?")) actions.handleDelete(task.id); }} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition p-1">
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
                {actions.selectedTask && !actions.linkMode && (
                    <TaskDetailPanel
                        task={actions.selectedTask}
                        onClose={() => actions.setSelectedTaskId(null)}
                        panelTab={actions.panelTab}
                        setPanelTab={actions.setPanelTab}
                        onStatusChange={actions.handleStatusChange}
                        onNameChange={actions.handleNameSave}
                        onDateChange={actions.handleDateChange}
                        onEstimatedHoursChange={actions.handleEstimatedHoursSave}
                        onColorChange={actions.handleColorChange}
                        onDelete={actions.handleDelete}
                        estimateItems={actions.estimateItems}
                        onLinkEstimateItem={actions.handleLinkEstimateItem}
                        onUnlinkEstimateItem={actions.handleUnlinkEstimateItem}
                        onFetchEstimateItems={actions.fetchEstimateItems}
                        teamMembers={teamMembers}
                        subcontractors={subcontractors}
                        onAssign={actions.handleAssign}
                        onUnassign={actions.handleUnassign}
                        onAssignSub={actions.handleAssignSub}
                        onUnassignSub={actions.handleUnassignSub}
                        punchItems={actions.punchItems}
                        onAddPunch={actions.handleAddPunch}
                        onTogglePunch={actions.handleTogglePunch}
                        onDeletePunch={actions.handleDeletePunch}
                        onAiPunchlist={actions.handleAiPunchlist}
                        isAiPunching={actions.isAiPunching}
                        comments={actions.comments}
                        onAddComment={actions.handleAddComment}
                        showCriticalPath={actions.showCriticalPath}
                        criticalPathIds={actions.criticalPathIds}
                        allTasks={tasks}
                        onLinkPredecessor={actions.handleLinkPredecessor}
                        onUnlinkPredecessor={actions.handleUnlinkPredecessor}
                        onSelectTask={actions.selectTask}
                    />
                )}
            </div>

            {/* New task form modal */}
            {actions.showNewTaskForm && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center">
                    <div className="fixed inset-0 bg-black/40" onClick={() => actions.setShowNewTaskForm(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
                        <h3 className="text-sm font-bold text-hui-textMain mb-4">{actions.newTaskType === "milestone" ? "New Milestone" : "New Task"}</h3>
                        <div className="space-y-3">
                            <input value={actions.newTaskName} onChange={e => actions.setNewTaskName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") actions.handleAddTask(); }} className="hui-input text-sm w-full" placeholder="Task name" autoFocus />
                            <div className="grid grid-cols-2 gap-3">
                                <div><label className="text-[10px] font-bold text-slate-400 uppercase">Start</label><input type="date" value={actions.newTaskStart} onChange={e => actions.setNewTaskStart(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>
                                {actions.newTaskType !== "milestone" && <div><label className="text-[10px] font-bold text-slate-400 uppercase">End</label><input type="date" value={actions.newTaskEnd} onChange={e => actions.setNewTaskEnd(e.target.value)} className="hui-input text-sm mt-1 w-full" /></div>}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 mt-5">
                            <button onClick={() => actions.setShowNewTaskForm(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                            <button onClick={actions.handleAddTask} disabled={actions.isAdding} className="hui-btn hui-btn-primary text-xs">{actions.isAdding ? "Adding..." : "Add"}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* AI Risk Analysis modal */}
            {actions.showRiskPanel && actions.riskAnalysis && (
                <RiskAnalysisModal analysis={actions.riskAnalysis} onClose={() => actions.setShowRiskPanel(false)} />
            )}
        </div>
    );
}
