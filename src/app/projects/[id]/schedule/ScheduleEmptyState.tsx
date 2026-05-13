"use client";

import type { EstimateSummary } from "./schedule-types";

type ScheduleEmptyStateProps = {
    estimates: EstimateSummary[];
    isAdding: boolean;
    isAiGenerating: boolean;
    isImporting: boolean;
    showAiMenu: boolean;
    showImportMenu: boolean;
    onAddTask: () => void;
    onToggleAiMenu: () => void;
    onAiSchedule: (estimateId?: string) => void;
    onToggleImportMenu: () => void;
    onImportEstimate: (estimateId: string) => void;
    viewMode?: "gantt" | "table" | "calendar";
    onViewModeChange?: (mode: "gantt" | "table" | "calendar") => void;
};

export default function ScheduleEmptyState({
    estimates, isAdding, isAiGenerating, isImporting,
    showAiMenu, showImportMenu,
    onAddTask, onToggleAiMenu, onAiSchedule, onToggleImportMenu, onImportEstimate,
    viewMode, onViewModeChange,
}: ScheduleEmptyStateProps) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 gap-6 py-20">
            {onViewModeChange && (
                <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
                    {(["gantt", "table", "calendar"] as const).map(m => (
                        <button key={m} onClick={() => onViewModeChange(m)} className={`px-3 py-1 text-xs font-medium rounded-md transition capitalize ${viewMode === m ? "bg-white text-hui-textMain shadow-sm" : "text-hui-textMuted hover:text-hui-textMain"}`}>{m === "gantt" ? "Gantt" : m === "table" ? "Table" : "Calendar"}</button>
                    ))}
                </div>
            )}
            <div className="relative">
                <div className="w-20 h-20 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-100/50">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="url(#emptyGrad)" strokeWidth="1.5">
                        <defs><linearGradient id="emptyGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#6366f1"/><stop offset="100%" stopColor="#8b5cf6"/></linearGradient></defs>
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
                <button onClick={onAddTask} className="hui-btn hui-btn-primary" disabled={isAdding}>+ Add First Task</button>
                <div className="relative">
                    <button
                        onClick={() => estimates.length > 0 ? onToggleAiMenu() : onAiSchedule()}
                        disabled={isAiGenerating}
                        className="hui-btn hui-btn-secondary bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 flex items-center gap-2"
                    >✨ {isAiGenerating ? "Generating..." : "AI Schedule"}</button>
                    {showAiMenu && estimates.length > 0 && (
                        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[260px] py-1 animate-in fade-in">
                            <button onClick={() => onAiSchedule()} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>🧠</span> General Schedule</button>
                            {estimates.map(est => (
                                <button key={est.id} onClick={() => onAiSchedule(est.id)} className="w-full text-left px-3 py-2.5 hover:bg-purple-50 transition text-sm flex items-center gap-2"><span>📋</span> {est.title}</button>
                            ))}
                        </div>
                    )}
                </div>
                {estimates.length > 0 && (
                    <div className="relative">
                        <button onClick={onToggleImportMenu} disabled={isImporting} className="hui-btn hui-btn-secondary flex items-center gap-2">{isImporting ? "Importing..." : "📋 Import"}</button>
                        {showImportMenu && (
                            <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 min-w-[240px] py-1 animate-in fade-in">
                                {estimates.map(est => (
                                    <button key={est.id} onClick={() => onImportEstimate(est.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition text-sm">{est.title}</button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
