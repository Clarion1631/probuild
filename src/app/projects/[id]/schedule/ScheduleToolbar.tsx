"use client";

import { type ReactNode, useRef, useState } from "react";
import type { EstimateSummary } from "./schedule-types";
import MenuPortal from "./MenuPortal";
import SchedulePublishButton from "./SchedulePublishButton";

type ViewMode = "gantt" | "table" | "calendar";
type ZoomLevel = "day" | "week" | "month";

type ScheduleToolbarProps = {
    projectId: string;
    initialPublished: boolean;
    taskCount: number;
    completedCount: number;
    filteredCount?: number;
    estimates: EstimateSummary[];
    viewMode?: ViewMode;
    onViewModeChange?: (mode: ViewMode) => void;
    // Task creation
    isAdding: boolean;
    onAddTask: () => void;
    onAddMilestone: () => void;
    // AI Schedule
    isAiGenerating: boolean;
    showAiMenu: boolean;
    onToggleAiMenu: () => void;
    onAiSchedule: (estimateId?: string) => void;
    // Tools menu state
    showToolsMenu: boolean;
    onToggleToolsMenu: () => void;
    // Tools menu items
    showCriticalPath: boolean;
    onToggleCriticalPath: () => void;
    linkMode: string | null;
    onToggleLinkMode: () => void;
    onSyncCalendar: () => void;
    isAiRisk: boolean;
    onAiRisk: () => void;
    isImporting: boolean;
    onImportEstimate: (estimateId: string) => void;
    onClearAll: () => void;
    // Gantt-specific (optional)
    zoom?: ZoomLevel;
    onZoomChange?: (zoom: ZoomLevel) => void;
    onTodayClick?: () => void;
    // Table-specific slot
    secondaryContent?: ReactNode;
};

const VIEW_ICONS: Record<ViewMode, ReactNode> = {
    gantt: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="6" y="10" width="12" height="4" rx="1"/><rect x="3" y="16" width="15" height="4" rx="1"/></svg>,
    table: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18"/><path d="M9 6v12"/></svg>,
    calendar: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
};

function AddTaskDropdown({ isAdding, onAddTask, onAddMilestone }: { isAdding: boolean; onAddTask: () => void; onAddMilestone: () => void }) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);
    const [pos, setPos] = useState({ top: 0, right: 0 });
    return (
        <div className="relative">
            <div className="inline-flex items-center rounded-lg shadow-sm">
                <button onClick={onAddTask} disabled={isAdding} className="inline-flex items-center justify-center h-[30px] px-4 text-sm font-medium bg-slate-900 text-white hover:bg-slate-800 transition-colors rounded-l-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900 focus:z-10">+ Task</button>
                <button
                    ref={btnRef}
                    onClick={() => {
                        if (!open && btnRef.current) {
                            const rect = btnRef.current.getBoundingClientRect();
                            setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                        }
                        setOpen(v => !v);
                    }}
                    disabled={isAdding}
                    className="inline-flex items-center justify-center h-[30px] px-2.5 text-sm font-medium bg-slate-900 text-white hover:bg-slate-800 transition-colors rounded-r-lg border-l border-indigo-400/40 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900 focus:z-10"
                >
                    <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor"><path d="M6 8.5L1.5 4h9z"/></svg>
                </button>
            </div>
            {open && (
                <MenuPortal>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="fixed bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[160px] py-1 animate-in fade-in" style={{ top: pos.top, right: pos.right }}>
                        <button onClick={() => { onAddTask(); setOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Task
                        </button>
                        <button onClick={() => { onAddMilestone(); setOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L10 6L15 8L10 10L8 15L6 10L1 8L6 6Z"/></svg>
                            Milestone
                        </button>
                    </div>
                </MenuPortal>
            )}
        </div>
    );
}

export default function ScheduleToolbar({
    projectId, initialPublished, taskCount, completedCount, filteredCount, estimates,
    viewMode, onViewModeChange,
    isAdding, onAddTask, onAddMilestone,
    isAiGenerating, showAiMenu, onToggleAiMenu, onAiSchedule,
    showToolsMenu, onToggleToolsMenu,
    showCriticalPath, onToggleCriticalPath,
    linkMode, onToggleLinkMode,
    onSyncCalendar, isAiRisk, onAiRisk, isImporting, onImportEstimate, onClearAll,
    zoom, onZoomChange, onTodayClick,
    secondaryContent,
}: ScheduleToolbarProps) {
    const progressPct = taskCount > 0 ? Math.round((completedCount / taskCount) * 100) : 0;
    const hasEstimates = estimates.length > 0;
    const moreBtnRef = useRef<HTMLButtonElement>(null);
    const [moreMenuPos, setMoreMenuPos] = useState({ top: 0, right: 0 });
    const aiBtnRef = useRef<HTMLButtonElement>(null);
    const [aiMenuPos, setAiMenuPos] = useState({ top: 0, right: 0 });

    return (
        <>
            <div className="bg-white border-b border-hui-border shrink-0 z-20 relative">
                <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
                <div className="px-6 py-3 flex items-center gap-2 flex-wrap">
                    {/* Left: title + stats */}
                    <div className="shrink-0">
                        <h1 className="text-lg font-bold text-hui-textMain">Schedule</h1>
                        <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs text-hui-textMuted">
                                {filteredCount !== undefined && filteredCount !== taskCount
                                    ? `${filteredCount} of ${taskCount}`
                                    : taskCount} task{taskCount !== 1 ? "s" : ""}
                            </span>
                            <span className="text-xs text-hui-textMuted">&middot;</span>
                            <span className="text-xs text-green-600 font-medium">{completedCount} done</span>
                            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
                            </div>
                            <span className="text-[10px] text-slate-400 font-medium">{progressPct}%</span>
                        </div>
                    </div>

                    {/* Center: view toggle — flex-1 keeps it stable when right-side buttons change */}
                    {onViewModeChange && (
                        <div className="flex-1 flex justify-center">
                            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                                {(["gantt", "table", "calendar"] as ViewMode[]).map(m => (
                                    <button key={m} onClick={() => onViewModeChange(m)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition flex items-center gap-1 capitalize ${viewMode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                                        {VIEW_ICONS[m]}
                                        {m === "gantt" ? "Gantt" : m === "table" ? "Table" : "Calendar"}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Right: controls */}
                    <div className="flex items-center gap-2 shrink-0">
                        {/* Zoom (Gantt only) */}
                        {onZoomChange && zoom && (
                            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                                {(["day", "week", "month"] as ZoomLevel[]).map(z => (
                                    <button key={z} onClick={() => onZoomChange(z)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition capitalize ${zoom === z ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{z}</button>
                                ))}
                            </div>
                        )}

                        {/* Today (Gantt only) */}
                        {onTodayClick && (
                            <button onClick={onTodayClick} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Today</button>
                        )}

                        {/* AI Schedule */}
                        <div className="relative">
                            <button
                                ref={aiBtnRef}
                                onClick={() => {
                                    if (!hasEstimates) { onAiSchedule(); return; }
                                    if (!showAiMenu && aiBtnRef.current) {
                                        const rect = aiBtnRef.current.getBoundingClientRect();
                                        setAiMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                                    }
                                    onToggleAiMenu();
                                }}
                                disabled={isAiGenerating}
                                className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition border ${isAiGenerating ? "bg-gradient-to-r from-purple-500 to-indigo-500 text-white border-purple-600 animate-pulse" : "bg-gradient-to-r from-purple-50 to-indigo-50 text-purple-700 border-purple-200 hover:shadow-md hover:from-purple-100 hover:to-indigo-100"}`}
                            >
                                ✨ {isAiGenerating ? "AI thinking..." : "AI Schedule"}
                            </button>
                            {showAiMenu && hasEstimates && (
                                <MenuPortal>
                                    <div className="fixed inset-0 z-40" onClick={onToggleAiMenu} />
                                    <div className="fixed bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[260px] py-1 animate-in fade-in" style={{ top: aiMenuPos.top, right: aiMenuPos.right }}>
                                        <button onClick={() => onAiSchedule()} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>🧠</span> General Schedule</button>
                                        {estimates.map(est => (
                                            <button key={est.id} onClick={() => onAiSchedule(est.id)} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>📋</span> {est.title}</button>
                                        ))}
                                    </div>
                                </MenuPortal>
                            )}
                        </div>

                        {/* Published toggle */}
                        <SchedulePublishButton projectId={projectId} initialPublished={initialPublished} />

                        {/* + Task with dropdown */}
                        <AddTaskDropdown isAdding={isAdding} onAddTask={onAddTask} onAddMilestone={onAddMilestone} />

                        {/* Tools overflow menu */}
                        <div className="relative">
                            <button ref={moreBtnRef} onClick={() => { if (!showToolsMenu && moreBtnRef.current) { const rect = moreBtnRef.current.getBoundingClientRect(); setMoreMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right }); } onToggleToolsMenu(); }} className={`hui-btn hui-btn-secondary text-xs py-1.5 px-2 ${showToolsMenu ? "bg-slate-200" : ""}`} title="Tools">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                            </button>
                            {showToolsMenu && (
                                <MenuPortal>
                                    <div className="fixed inset-0 z-40" onClick={onToggleToolsMenu} />
                                    <div className="fixed bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[220px] py-1 animate-in fade-in" style={{ top: moreMenuPos.top, right: moreMenuPos.right }}>
                                        {/* View section */}
                                        <div className="px-3 py-1 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">View</div>
                                        <button onClick={() => { onToggleCriticalPath(); onToggleToolsMenu(); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2">
                                            {showCriticalPath ? (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5"/></svg>
                                            ) : <span className="w-[14px]" />}
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                                            Critical Path
                                        </button>
                                        <button onClick={() => { onToggleLinkMode(); onToggleToolsMenu(); }} className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2 ${linkMode ? "text-amber-700" : ""}`}>
                                            {linkMode ? (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5"/></svg>
                                            ) : <span className="w-[14px]" />}
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                                            {linkMode ? "Cancel Link" : "Link Tasks"}
                                        </button>

                                        <div className="border-t border-slate-100 my-1" />

                                        {/* Share section */}
                                        <div className="px-3 py-1 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">Share</div>
                                        <button onClick={() => { onSyncCalendar(); onToggleToolsMenu(); }} disabled={taskCount === 0} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2 disabled:opacity-40">
                                            <span className="w-[14px]" />
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                            Sync to Calendar
                                        </button>

                                        <div className="border-t border-slate-100 my-1" />

                                        {/* AI section */}
                                        <div className="px-3 py-1 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">AI</div>
                                        <button onClick={() => { onAiRisk(); onToggleToolsMenu(); }} disabled={isAiRisk || taskCount === 0} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2 disabled:opacity-40">
                                            <span className="w-[14px]" />
                                            <span>⚠️</span>
                                            {isAiRisk ? "Analyzing…" : "AI Risk Analysis"}
                                        </button>

                                        <div className="border-t border-slate-100 my-1" />

                                        {/* Data section */}
                                        <div className="px-3 py-1 text-[10px] text-slate-400 uppercase font-semibold tracking-wider">Data</div>
                                        {hasEstimates && estimates.map(est => (
                                            <button key={est.id} onClick={() => { onImportEstimate(est.id); onToggleToolsMenu(); }} disabled={isImporting} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm flex items-center gap-2 disabled:opacity-40">
                                                <span className="w-[14px]" />
                                                <span>📋</span>
                                                Import: {est.title}
                                            </button>
                                        ))}
                                        <div className="border-t border-slate-100 my-1" />
                                        <button onClick={() => { onClearAll(); onToggleToolsMenu(); }} className="w-full text-left px-3 py-2 hover:bg-red-50 transition text-sm flex items-center gap-2 text-red-600">
                                            <span className="w-[14px]" />
                                            <span>🗑️</span>
                                            Clear All Tasks
                                        </button>
                                    </div>
                                </MenuPortal>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Link mode banner */}
            {linkMode && (
                <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-xs text-amber-800 shrink-0 z-20">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span className="font-medium">{linkMode === "__awaiting__" ? "Click the predecessor task" : "Now click the dependent task"}</span>
                    <button onClick={onToggleLinkMode} className="ml-auto text-amber-600 hover:text-amber-800 text-xs font-medium">Cancel</button>
                </div>
            )}

            {/* Secondary content slot (Table's search/filter/sort row) */}
            {secondaryContent}
        </>
    );
}
