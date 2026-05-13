"use client";

import { useState, useEffect, useRef, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { Task, EstimateSummary } from "./schedule-types";
import { formatDate, addDays } from "./schedule-utils";
import {
    createScheduleTask, importEstimateToSchedule, clearAllTasks,
    aiGenerateSchedule,
} from "@/lib/actions";
import SchedulePublishButton from "./SchedulePublishButton";

type Props = {
    projectId: string;
    tasks: Task[];
    setTasks: Dispatch<SetStateAction<Task[]>>;
    estimates?: EstimateSummary[];
    initialPublished: boolean;
    viewMode?: "gantt" | "table" | "calendar";
    onViewModeChange?: (mode: "gantt" | "table" | "calendar") => void;
    showCriticalPath: boolean;
    onToggleCriticalPath: () => void;
    linkMode: string | null;
    onToggleLinkMode: () => void;
    viewControls?: ReactNode;
};

export default function ScheduleToolbar({
    projectId, tasks, setTasks, estimates = [], initialPublished,
    viewMode, onViewModeChange,
    showCriticalPath, onToggleCriticalPath,
    linkMode, onToggleLinkMode,
    viewControls,
}: Props) {
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [expandedSection, setExpandedSection] = useState<string | null>(null);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [isAiRisk, setIsAiRisk] = useState(false);
    const [showRiskPanel, setShowRiskPanel] = useState(false);
    const [riskAnalysis, setRiskAnalysis] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [showNewTaskForm, setShowNewTaskForm] = useState(false);
    const [newTaskType, setNewTaskType] = useState<"task" | "milestone">("task");
    const [newTaskName, setNewTaskName] = useState("");
    const [newTaskStart, setNewTaskStart] = useState("");
    const [newTaskEnd, setNewTaskEnd] = useState("");
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!showMoreMenu) setExpandedSection(null);
    }, [showMoreMenu]);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setShowMoreMenu(false);
            }
        }
        if (showMoreMenu) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [showMoreMenu]);

    const completedCount = tasks.filter(t => t.status === "Complete").length;
    const progressPct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

    function openNewTaskForm(type: "task" | "milestone") {
        const today = new Date();
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

    async function handleAiSchedule(estimateId?: string) {
        setIsAiGenerating(true);
        setShowMoreMenu(false);
        try {
            const created = await aiGenerateSchedule(projectId, estimateId);
            const newTasks: Task[] = created.map((t: any) => ({
                id: t.id, name: t.name,
                startDate: new Date(t.startDate).toISOString().split("T")[0],
                endDate: new Date(t.endDate).toISOString().split("T")[0],
                color: t.color, progress: 0, status: t.status, type: "task" as const,
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
        setShowMoreMenu(false);
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
        } catch (e: any) { toast.error(e.message || "Schedule risk analysis failed"); }
        finally { setIsAiRisk(false); }
    }

    async function handleImportEstimate(estimateId: string) {
        setIsImporting(true);
        setShowMoreMenu(false);
        try {
            const newTasks = await importEstimateToSchedule(projectId, estimateId);
            setTasks(prev => [...prev, ...newTasks.map((t: any) => ({
                ...t,
                startDate: formatDate(new Date(t.startDate)),
                endDate: formatDate(new Date(t.endDate)),
                type: "task" as const, actualHours: 0, estimatedHours: null,
                dependencies: [], dependents: [], assignments: [],
                estimateItemId: t.estimateItemId || null, estimateItem: null,
            }))]);
            toast.success(`Imported ${newTasks.length} tasks`);
        } catch { toast.error("Import failed"); }
        finally { setIsImporting(false); }
    }

    const hasActiveFeature = showCriticalPath || !!linkMode;

    return (
        <>
            <div className="bg-white border-b border-hui-border shrink-0 z-20 relative">
                <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
                <div className="px-6 py-3 flex items-center justify-between flex-wrap gap-2">
                    {/* Left: title + progress */}
                    <div className="flex items-center gap-4">
                        <div>
                            <h1 className="text-lg font-bold text-hui-textMain">Schedule</h1>
                            <div className="flex items-center gap-3 mt-0.5">
                                <span className="text-xs text-hui-textMuted">
                                    {tasks.length} task{tasks.length !== 1 ? "s" : ""}
                                </span>
                                <span className="text-xs text-hui-textMuted">&middot;</span>
                                <span className="text-xs text-green-600 font-medium">{completedCount} done</span>
                                <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
                                </div>
                                <span className="text-[10px] text-slate-400 font-medium">{progressPct}%</span>
                            </div>
                        </div>
                    </div>

                    {/* Right: controls */}
                    <div className="flex items-center gap-2 flex-wrap">
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

                        {/* Per-view controls slot */}
                        {viewControls}

                        {/* Published */}
                        <SchedulePublishButton projectId={projectId} initialPublished={initialPublished} />

                        {/* + Milestone */}
                        <button onClick={() => openNewTaskForm("milestone")} disabled={isAdding} className="hui-btn hui-btn-secondary text-xs flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0L10.5 5.5L16 8L10.5 10.5L8 16L5.5 10.5L0 8L5.5 5.5Z"/></svg>Milestone
                        </button>

                        {/* + Task (primary) */}
                        <button onClick={() => openNewTaskForm("task")} disabled={isAdding} className="hui-btn hui-btn-primary text-xs">+ Task</button>

                        {/* More menu */}
                        <div className="relative" ref={menuRef}>
                            <button
                                onClick={() => setShowMoreMenu(!showMoreMenu)}
                                className={`hui-btn hui-btn-secondary text-xs py-1.5 px-2 relative ${hasActiveFeature ? "ring-2 ring-indigo-300" : ""}`}
                                title="More actions"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                                {hasActiveFeature && (
                                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-indigo-500 rounded-full border-2 border-white" />
                                )}
                            </button>
                            {showMoreMenu && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] py-1 animate-in fade-in">
                                    {/* TOOLS section */}
                                    <div className="px-3 py-1.5 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">Tools</div>
                                    <button
                                        onClick={onToggleCriticalPath}
                                        className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2.5 ${showCriticalPath ? "bg-red-50" : ""}`}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={showCriticalPath ? "text-red-600" : "text-slate-400"}>
                                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                                        </svg>
                                        <span className={showCriticalPath ? "text-red-700 font-medium" : ""}>Critical Path</span>
                                        {showCriticalPath && (
                                            <svg className="w-4 h-4 ml-auto text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => { onToggleLinkMode(); setShowMoreMenu(false); }}
                                        className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2.5 ${linkMode ? "bg-amber-50" : ""}`}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={linkMode ? "text-amber-600" : "text-slate-400"}>
                                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                        </svg>
                                        <span className={linkMode ? "text-amber-800 font-medium" : ""}>{linkMode ? "Cancel Linking" : "Link Tasks"}</span>
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (tasks.length === 0) { toast.error("No tasks to sync"); return; }
                                            const a = document.createElement("a");
                                            a.href = `/api/calendar/sync?projectId=${projectId}`;
                                            a.download = "schedule.ics";
                                            a.click();
                                            toast.success("Calendar file downloaded");
                                            setShowMoreMenu(false);
                                        }}
                                        disabled={tasks.length === 0}
                                        className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2.5 disabled:opacity-40"
                                    >
                                        <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                        <span>Sync to Calendar</span>
                                    </button>

                                    <div className="border-t border-slate-100 my-1" />

                                    {/* AI section */}
                                    <div className="px-3 py-1.5 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">AI</div>
                                    <button
                                        onClick={handleAiRisk}
                                        disabled={isAiRisk || tasks.length === 0}
                                        className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2.5 disabled:opacity-40 ${isAiRisk ? "animate-pulse" : ""}`}
                                    >
                                        <span className="text-sm">⚠️</span>
                                        <span>{isAiRisk ? "Analyzing..." : "Risk Analysis"}</span>
                                    </button>
                                    <div className="relative">
                                        <button
                                            onClick={() => {
                                                if (estimates.length === 0) { handleAiSchedule(); return; }
                                                setExpandedSection(expandedSection === "ai-schedule" ? null : "ai-schedule");
                                            }}
                                            disabled={isAiGenerating}
                                            className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2.5 disabled:opacity-40 ${isAiGenerating ? "animate-pulse" : ""}`}
                                        >
                                            <span className="text-sm">✨</span>
                                            <span>{isAiGenerating ? "Generating..." : "AI Schedule"}</span>
                                            {estimates.length > 0 && (
                                                <svg className={`w-3.5 h-3.5 ml-auto text-slate-400 transition-transform ${expandedSection === "ai-schedule" ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                            )}
                                        </button>
                                        {expandedSection === "ai-schedule" && estimates.length > 0 && (
                                            <div className="bg-slate-50/50">
                                                <button onClick={() => handleAiSchedule()} className="w-full text-left pl-10 pr-3 py-2 hover:bg-purple-50 transition text-sm flex items-center gap-2">
                                                    <span>🧠</span> General Schedule
                                                </button>
                                                {estimates.map(est => (
                                                    <button key={est.id} onClick={() => handleAiSchedule(est.id)} className="w-full text-left pl-10 pr-3 py-2 hover:bg-purple-50 transition text-sm flex items-center gap-2">
                                                        <span>📋</span> {est.title}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="border-t border-slate-100 my-1" />

                                    {/* DATA section */}
                                    <div className="px-3 py-1.5 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">Data</div>
                                    {estimates.length > 0 && (
                                        <div className="relative">
                                            <button
                                                onClick={() => setExpandedSection(expandedSection === "import" ? null : "import")}
                                                disabled={isImporting}
                                                className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2.5 disabled:opacity-40"
                                            >
                                                <span className="text-sm">📋</span>
                                                <span>{isImporting ? "Importing..." : "Import from Estimate"}</span>
                                                <svg className={`w-3.5 h-3.5 ml-auto text-slate-400 transition-transform ${expandedSection === "import" ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                            </button>
                                            {expandedSection === "import" && (
                                                <div className="bg-slate-50/50">
                                                    {estimates.map(est => (
                                                        <button key={est.id} onClick={() => handleImportEstimate(est.id)} className="w-full text-left pl-10 pr-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">
                                                            📋 {est.title}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    <button
                                        onClick={async () => {
                                            if (confirm("Delete ALL tasks from this schedule? This cannot be undone.")) {
                                                setShowMoreMenu(false);
                                                await clearAllTasks(projectId);
                                                setTasks([]);
                                                toast.success("Schedule cleared");
                                            }
                                        }}
                                        className="w-full text-left px-3 py-2 hover:bg-red-50 transition text-sm flex items-center gap-2.5 text-red-600"
                                    >
                                        <span className="text-sm">🗑️</span>
                                        <span>Clear All Tasks</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
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
                            <div className="flex items-center gap-2">
                                <span className="text-xl">⚠️</span>
                                <h2 className="font-bold text-hui-textMain text-lg">Schedule Risk Analysis</h2>
                            </div>
                            <button onClick={() => setShowRiskPanel(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1">
                            <div className="prose prose-sm max-w-none text-hui-textMain whitespace-pre-wrap text-sm leading-relaxed">{riskAnalysis}</div>
                        </div>
                        <div className="p-4 border-t border-hui-border">
                            <button onClick={() => setShowRiskPanel(false)} className="hui-btn hui-btn-secondary text-sm">Close</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
