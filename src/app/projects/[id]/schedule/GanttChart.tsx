"use client";

import { useState, useRef, useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { updateScheduleTask } from "@/lib/actions";
import type { Task, ZoomLevel, EstimateSummary, TeamMember, Subcontractor } from "./schedule-types";
import { STATUS_OPTIONS, STATUS_COLORS, getDaysBetween, addDays, formatDate, getMonday, isWeekend, getInitials, formatCurrency } from "./schedule-utils";
import { useScheduleActions } from "./useScheduleActions";
import TaskDetailPanel from "./TaskDetailPanel";
import ScheduleToolbar from "./ScheduleToolbar";
import ScheduleEmptyState from "./ScheduleEmptyState";
import RiskAnalysisModal from "./RiskAnalysisModal";
import ColorPicker from "./ColorPicker";

const DRAG_THRESHOLD_PX = 5;

export default function GanttChart({ projectId, projectName, tasks, setTasks, estimates = [], teamMembers = [], subcontractors = [], initialPublished, viewMode, onViewModeChange }: {
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

    // Gantt-specific local state
    const [zoom, setZoom] = useState<ZoomLevel>("week");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [editingHoursId, setEditingHoursId] = useState<string | null>(null);
    const [editHoursVal, setEditHoursVal] = useState("");
    const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const scrollRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ cleanup: () => void } | null>(null);
    const tasksRef = useRef<Task[]>([]);

    // Timeline range
    const allDates = tasks.flatMap(t => [new Date(t.startDate), new Date(t.endDate)]);
    const today = new Date();
    if (allDates.length === 0) { allDates.push(addDays(today, -14), addDays(today, 60)); }
    const rawMin = addDays(new Date(Math.min(...allDates.map(d => d.getTime()))), -14);
    const minDate = getMonday(rawMin);
    const maxDate = addDays(new Date(Math.max(...allDates.map(d => d.getTime()))), 30);
    const totalDays = getDaysBetween(minDate, maxDate);
    const colWidth = zoom === "day" ? 40 : zoom === "week" ? 20 : 8;
    const timelineWidth = totalDays * colWidth;
    const ROW_HEIGHT = 52;
    const BASE_HEADER_HEIGHT = 44;
    const DAY_SUB_ROW_HEIGHT = 18;
    const headerHeight = zoom === "week" ? BASE_HEADER_HEIGHT + DAY_SUB_ROW_HEIGHT : BASE_HEADER_HEIGHT;

    function getHeaders() {
        const headers: { label: string; span: number; key: string }[] = [];
        if (zoom === "month") {
            let cursor = new Date(minDate.getTime());
            while (cursor < maxDate) {
                const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
                const end = monthEnd > maxDate ? maxDate : monthEnd;
                headers.push({ label: cursor.toLocaleString("en", { month: "short", timeZone: "UTC" }), span: getDaysBetween(cursor, end) + 1, key: `m-${cursor.getUTCMonth()}-${cursor.getUTCFullYear()}` });
                cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
            }
        } else if (zoom === "week") {
            let cursor = new Date(minDate.getTime());
            while (cursor < maxDate) {
                headers.push({ label: cursor.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase(), span: 7, key: `w-${formatDate(cursor)}` });
                cursor = addDays(cursor, 7);
            }
        } else {
            let cursor = new Date(minDate.getTime());
            while (cursor < maxDate) {
                headers.push({ label: cursor.getUTCDate().toString(), span: 1, key: `d-${formatDate(cursor)}` });
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

    useEffect(() => { tasksRef.current = tasks; });

    async function handleSaveName(taskId: string) {
        if (editName.trim()) actions.handleNameSave(taskId, editName.trim());
        setEditingId(null);
    }

    async function handleEstimatedHoursSave(taskId: string) {
        const h = parseFloat(editHoursVal);
        if (!isNaN(h) && h >= 0) actions.handleEstimatedHoursSave(taskId, h);
        setEditingHoursId(null);
    }

    // Drag system
    const startDrag = useCallback((taskId: string, type: "move" | "resize-left" | "resize-right", startX: number, startY: number, isTouch: boolean) => {
        const task = tasksRef.current.find(t => t.id === taskId);
        if (!task) return;
        dragRef.current?.cleanup();

        const origStart = new Date(task.startDate);
        const origEnd = new Date(task.endDate);
        const isMilestone = task.type === "milestone";
        let active = false;
        let lastDayDelta = 0;

        const apply = (clientX: number) => {
            const dayDelta = Math.round((clientX - startX) / colWidth);
            if (dayDelta === lastDayDelta) return;
            lastDayDelta = dayDelta;
            setTasks(prev => prev.map(t => {
                if (t.id !== taskId) return t;
                if (type === "move") {
                    const newStart = formatDate(addDays(origStart, dayDelta));
                    const newEnd = isMilestone ? newStart : formatDate(addDays(origEnd, dayDelta));
                    return { ...t, startDate: newStart, endDate: newEnd };
                }
                if (type === "resize-right" && !isMilestone) {
                    const ne = addDays(origEnd, dayDelta);
                    return ne <= new Date(t.startDate) ? t : { ...t, endDate: formatDate(ne) };
                }
                if (type === "resize-left" && !isMilestone) {
                    const ns = addDays(origStart, dayDelta);
                    return ns >= new Date(t.endDate) ? t : { ...t, startDate: formatDate(ns) };
                }
                return t;
            }));
        };

        const onMouseMove = (ev: MouseEvent) => {
            if (!active) {
                if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
                active = true;
            }
            apply(ev.clientX);
        };
        const onTouchMove = (ev: TouchEvent) => {
            if (ev.touches.length !== 1) return;
            if (!active) {
                if (Math.abs(ev.touches[0].clientX - startX) + Math.abs(ev.touches[0].clientY - startY) < DRAG_THRESHOLD_PX) return;
                active = true;
            }
            ev.preventDefault();
            apply(ev.touches[0].clientX);
        };
        const onEnd = async () => {
            cleanup();
            if (!active) {
                if (type === "move") actions.selectTask(taskId);
                return;
            }
            const currentTask = tasksRef.current.find(t => t.id === taskId);
            if (!currentTask) return;
            await updateScheduleTask(taskId, { startDate: currentTask.startDate, endDate: currentTask.endDate });
            if (type === "move" && lastDayDelta !== 0) await actions.cascadeDependents(taskId, lastDayDelta);
        };
        const cleanup = () => {
            dragRef.current = null;
            if (isTouch) {
                window.removeEventListener("touchmove", onTouchMove);
                window.removeEventListener("touchend", onEnd);
                window.removeEventListener("touchcancel", onEnd);
            } else {
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onEnd);
            }
        };

        dragRef.current = { cleanup };
        if (isTouch) {
            window.addEventListener("touchmove", onTouchMove, { passive: false });
            window.addEventListener("touchend", onEnd);
            window.addEventListener("touchcancel", onEnd);
        } else {
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onEnd);
        }
    }, [colWidth, setTasks, actions]);

    const handleMouseDown = useCallback((e: React.MouseEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        e.preventDefault();
        startDrag(taskId, type, e.clientX, e.clientY, false);
    }, [startDrag]);

    const handleTouchStart = useCallback((e: React.TouchEvent, taskId: string, type: "move" | "resize-left" | "resize-right") => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        startDrag(taskId, type, e.touches[0].clientX, e.touches[0].clientY, true);
    }, [startDrag]);

    useEffect(() => { return () => { dragRef.current?.cleanup(); }; }, []);

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

    // Arrows
    const arrows: { fromId: string; toId: string; predecessorId: string; dependentId: string }[] = [];
    tasks.forEach(t => t.dependencies.forEach(d => arrows.push({ fromId: d.predecessorId, toId: d.dependentId, predecessorId: d.predecessorId, dependentId: d.dependentId })));

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
                            <h3 className="text-sm font-bold text-hui-textMain mb-4">New Task</h3>
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

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <ScheduleToolbar
                projectId={projectId}
                initialPublished={initialPublished}
                taskCount={tasks.length}
                completedCount={completedCount}
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
                zoom={zoom}
                onZoomChange={setZoom}
                onTodayClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayOffset - 300); }}
            />

            <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Left Panel — Task List */}
                <div className="w-80 shrink-0 bg-white border-r border-hui-border flex flex-col z-10 shadow-[2px_0_8px_rgba(0,0,0,0.03)]">
                    <div className="flex items-center px-3 py-3 bg-gradient-to-r from-slate-50 to-slate-100/50 border-b border-hui-border text-[10px] font-bold text-slate-400 uppercase tracking-wider" style={{ height: headerHeight }}>
                        <div className="flex-1">Task Name</div>
                        <div className="w-16 text-center">Hours</div>
                        <div className="w-20 text-center">Status</div>
                        <div className="w-8"></div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto">
                        {tasks.map(task => {
                            const hasTimeData = task.actualHours > 0 && task.estimatedHours;
                            const isCritical = actions.showCriticalPath && actions.criticalPathIds.has(task.id);
                            return (
                                <div key={task.id}
                                    onClick={() => { if (actions.linkMode === "__awaiting__") actions.setLinkMode(task.id); else if (actions.linkMode) actions.handleTaskClick(task.id); else actions.selectTask(task.id); }}
                                    className={`flex items-center px-3 border-b border-slate-100 hover:bg-slate-50/80 transition group cursor-pointer ${actions.selectedTaskId === task.id ? "bg-indigo-50/60 ring-1 ring-inset ring-indigo-200" : ""} ${actions.linkMode === task.id ? "bg-amber-50 ring-1 ring-inset ring-amber-300" : ""}`}
                                    style={{ height: ROW_HEIGHT, borderLeft: isCritical ? "3px solid #ef4444" : "" }}
                                >
                                    <div className="relative mr-2">
                                        {task.type === "milestone" ? (
                                            <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }} className="w-4 h-4 flex items-center justify-center" title="Milestone">
                                                <div className="w-3 h-3 rotate-45 border-2" style={{ backgroundColor: task.color, borderColor: task.color }} />
                                            </button>
                                        ) : (
                                            <button onClick={e => { e.stopPropagation(); setColorPickerId(colorPickerId === task.id ? null : task.id); }} className={`w-3 h-3 rounded-full border-2 border-white shadow-sm ring-1 ${task.color?.toLowerCase() === "#ffffff" ? "ring-slate-400" : "ring-slate-200"}`} style={{ backgroundColor: task.color }} />
                                        )}
                                        {colorPickerId === task.id && (
                                            <ColorPicker selected={task.color} onPick={c => actions.handleColorChange(task.id, c)} onClose={() => setColorPickerId(null)} className="absolute top-5 left-0 z-50 min-w-[200px]" />
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
                                                <span className="text-xs font-medium text-hui-textMain truncate text-left hover:text-hui-primary transition cursor-pointer">{task.name}</span>
                                                {task.estimateItem && <span className="ml-1 text-[9px] text-blue-500 bg-blue-50 rounded px-1 shrink-0">$</span>}
                                            </div>
                                        )}
                                    </div>
                                    <div className="w-16 flex justify-center">
                                        {task.type !== "milestone" && (editingHoursId === task.id ? (
                                            <input autoFocus type="number" className="hui-input text-[10px] py-0.5 w-12 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" value={editHoursVal} onChange={e => setEditHoursVal(e.target.value)} onBlur={() => handleEstimatedHoursSave(task.id)} onKeyDown={e => { if (e.key === "Enter") handleEstimatedHoursSave(task.id); }} onClick={e => e.stopPropagation()} placeholder="hrs" />
                                        ) : (
                                            <button onClick={e => { e.stopPropagation(); setEditingHoursId(task.id); setEditHoursVal(task.estimatedHours?.toString() || ""); }} className={`text-[10px] px-1 py-0.5 rounded ${hasTimeData ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-300 hover:bg-slate-100"}`}>
                                                {hasTimeData ? `${task.actualHours.toFixed(1)}/${task.estimatedHours}h` : task.estimatedHours ? `${task.estimatedHours}h` : "—"}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="w-20 flex justify-center">
                                        <select value={task.status} onChange={e => { e.stopPropagation(); actions.handleStatusChange(task.id, e.target.value); }} onClick={e => e.stopPropagation()} className={`text-[9px] font-semibold rounded-full px-1.5 py-0.5 border-0 cursor-pointer appearance-none text-center ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-700"}`}>
                                            {STATUS_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                                        </select>
                                    </div>
                                    <div className="w-8 flex justify-end">
                                        <button onClick={e => { e.stopPropagation(); actions.handleDelete(task.id); }} className="text-slate-300 hover:text-red-500 rounded p-0.5 transition opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                        {actions.showNewTaskForm ? (
                            <div className="px-3 py-3 border-b border-slate-200 bg-indigo-50/30 space-y-2">
                                <input autoFocus type="text" value={actions.newTaskName} onChange={e => actions.setNewTaskName(e.target.value)} className="hui-input text-xs w-full" placeholder="Task name" onKeyDown={e => { if (e.key === "Enter") actions.handleAddTask(); if (e.key === "Escape") actions.setShowNewTaskForm(false); }} />
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-[9px] font-bold text-slate-400 uppercase">Start</label>
                                        <input type="date" value={actions.newTaskStart} onChange={e => actions.setNewTaskStart(e.target.value)} className="hui-input text-xs w-full mt-0.5" />
                                    </div>
                                    {actions.newTaskType !== "milestone" && (
                                        <div>
                                            <label className="text-[9px] font-bold text-slate-400 uppercase">End</label>
                                            <input type="date" value={actions.newTaskEnd} onChange={e => actions.setNewTaskEnd(e.target.value)} className="hui-input text-xs w-full mt-0.5" />
                                        </div>
                                    )}
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={actions.handleAddTask} disabled={actions.isAdding} className="hui-btn hui-btn-primary text-xs flex-1">{actions.isAdding ? "Creating..." : "Create"}</button>
                                    <button onClick={() => actions.setShowNewTaskForm(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <button onClick={() => actions.openNewTaskForm("task")} className="flex items-center px-3 w-full hover:bg-slate-50 transition text-xs text-indigo-500 font-medium gap-2" style={{ height: ROW_HEIGHT }} disabled={actions.isAdding}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                                Add Task
                            </button>
                        )}
                    </div>
                </div>

                {/* Middle — Timeline */}
                <div ref={scrollRef} className="flex-1 min-h-0 min-w-0 overflow-auto bg-slate-50/50 relative">
                    <div style={{ width: timelineWidth, minHeight: "100%" }} className="relative">
                        <div className="sticky top-0 z-10 bg-slate-50 border-b border-hui-border" style={{ height: headerHeight }}>
                            <div className="flex" style={{ height: BASE_HEADER_HEIGHT }}>
                                {headers.map(h => (<div key={h.key} className="text-[10px] font-semibold text-slate-500 border-r border-slate-200/60 flex items-center justify-center shrink-0 uppercase tracking-wider" style={{ width: h.span * colWidth }}>{h.label}</div>))}
                            </div>
                            {zoom === "week" && (
                                <div className="flex border-t border-slate-200/40" style={{ height: DAY_SUB_ROW_HEIGHT }}>
                                    {headers.flatMap(h => {
                                        const dateStr = h.key.slice(2);
                                        const monday = new Date(dateStr + "T00:00:00Z");
                                        return Array.from({ length: 7 }, (_, i) => {
                                            const d = addDays(monday, i);
                                            const dayNum = d.getUTCDate();
                                            const isWknd = d.getUTCDay() === 0 || d.getUTCDay() === 6;
                                            const isToday = d.getUTCFullYear() === today.getUTCFullYear() && d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate();
                                            return (
                                                <div key={`ds-${h.key}-${i}`} className={`flex items-center justify-center shrink-0 text-[9px] ${isWknd ? "text-slate-300" : isToday ? "text-red-500 font-bold" : "text-slate-400"}`} style={{ width: colWidth }}>
                                                    {dayNum}
                                                </div>
                                            );
                                        });
                                    })}
                                </div>
                            )}
                        </div>

                        {weekendCols.map((wc, i) => (
                            <div key={`wk-${i}`} className="absolute bottom-0 bg-slate-200/25 pointer-events-none z-[1]" style={{ top: headerHeight, left: wc.left, width: wc.width }} />
                        ))}

                        <div className="absolute top-0 bottom-0 w-px z-[5] pointer-events-none" style={{ left: todayOffset, background: "repeating-linear-gradient(to bottom, #ef4444 0, #ef4444 4px, transparent 4px, transparent 8px)" }}>
                            <div className="absolute -top-0 -translate-x-1/2 bg-red-500 text-white text-[8px] font-bold px-1 py-0.5 rounded-b-md shadow">TODAY</div>
                        </div>

                        <svg className="absolute top-0 left-0 pointer-events-none z-[4]" style={{ width: timelineWidth, height: headerHeight + tasks.length * ROW_HEIGHT }}>
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
                                        <circle cx={mx} cy={(y1+y2)/2} r="7" fill="transparent" className="pointer-events-auto cursor-pointer" onClick={() => actions.handleUnlink(arrow.predecessorId, arrow.dependentId)}><title>Remove link</title></circle>
                                        <text x={mx} y={(y1+y2)/2+3} textAnchor="middle" fill="#94a3b8" fontSize="9" fontWeight="bold" className="pointer-events-none">×</text>
                                    </g>
                                );
                            })}
                        </svg>

                        {tasks.map((task, idx) => {
                            const bar = getBarStyle(task);
                            const isCritical = actions.showCriticalPath && actions.criticalPathIds.has(task.id);
                            const topY = 44 + idx * ROW_HEIGHT;

                            if (task.type === "milestone") {
                                const cx = bar.left + 8;
                                const size = 10;
                                return (
                                    <div key={task.id} className="absolute flex items-center justify-center" style={{ top: topY, left: cx - size - 4, width: (size + 4) * 2, height: ROW_HEIGHT }}>
                                        <div className={`relative cursor-pointer group select-none ${isCritical ? "drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]" : ""}`} onMouseDown={e => handleMouseDown(e, task.id, "move")} onTouchStart={e => handleTouchStart(e, task.id, "move")} title={task.name}>
                                            <div className={`w-5 h-5 rotate-45 border-2 shadow-md transition-transform group-hover:scale-110 ${isCritical ? "ring-2 ring-red-400/50" : ""}`} style={{ backgroundColor: task.color, borderColor: task.color }} />
                                            {colWidth > 10 && (
                                                <div className="absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-bold pointer-events-none" style={{ color: task.color }}>{task.name}</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            }

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
                                        <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg" style={{ backgroundColor: task.color }} />
                                        <div className="relative z-[2] flex items-center justify-between h-full px-2.5 pl-3">
                                            <span className="text-[10px] font-bold truncate" style={{ color: task.color }}>{task.name}</span>
                                            {(task.assignments || []).length > 0 && bar.width > 80 && (
                                                <div className="flex -space-x-1.5 ml-1">{(task.assignments || []).slice(0,3).map(a => (
                                                    <div key={a.userId} className="w-5 h-5 rounded-full bg-white text-[7px] font-bold flex items-center justify-center border-2 border-white shadow-sm" style={{ color: task.color }}>{getInitials(a.user.name, a.user.email)}</div>
                                                ))}</div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-10 hover:bg-black/10 rounded-r-lg" onMouseDown={e => handleMouseDown(e, task.id, "resize-right")} onTouchStart={e => handleTouchStart(e, task.id, "resize-right")} />
                                </div>
                            );
                        })}

                        {headers.map((h, i) => { let x = 0; for (let j = 0; j < i; j++) x += headers[j].span * colWidth; return (<div key={`g-${h.key}`} className="absolute bottom-0 border-r border-slate-200/40 pointer-events-none" style={{ top: headerHeight, left: x }} />); })}
                    </div>
                </div>

                {/* Right Panel — Task Detail */}
                {actions.selectedTask && (
                    <TaskDetailPanel
                        task={actions.selectedTask}
                        onClose={() => actions.setSelectedTaskId(null)}
                        panelTab={actions.panelTab}
                        setPanelTab={actions.setPanelTab}
                        onStatusChange={actions.handleStatusChange}
                        onNameChange={actions.handleNameSave}
                        onDoneWhenChange={actions.handleDoneWhenChange}
                        onClientStageChange={actions.handleClientStageChange}
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
                        onSetLead={actions.handleSetLead}
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
                        onAppointmentChange={actions.handleAppointmentChange}
                    />
                )}
            </div>

            {/* Hover tooltip for estimate budget */}
            {hoveredTaskId && (() => {
                const task = tasks.find(t => t.id === hoveredTaskId);
                if (!task?.estimateItem) return null;
                return (
                    <div className="fixed z-[100] bg-slate-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none" style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 40 }}>
                        <div className="font-semibold">{task.estimateItem.name}</div>
                        <div className="flex items-center gap-3 mt-1 text-slate-300">
                            <span>Budget: <span className="text-green-400 font-semibold">{formatCurrency(task.estimateItem.total)}</span></span>
                            {task.estimatedHours && <span>{task.estimatedHours}h est.</span>}
                            {task.actualHours > 0 && <span>{task.actualHours.toFixed(1)}h actual</span>}
                        </div>
                    </div>
                );
            })()}

            {/* AI Risk Analysis modal */}
            {actions.showRiskPanel && actions.riskAnalysis && (
                <RiskAnalysisModal analysis={actions.riskAnalysis} onClose={() => actions.setShowRiskPanel(false)} />
            )}
        </div>
    );
}
