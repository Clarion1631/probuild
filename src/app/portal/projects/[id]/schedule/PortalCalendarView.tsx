"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { addTaskCommentAsSub, updateTaskStatusAsSub } from "@/lib/actions";
import type { PortalTask, PortalViewMode, PortalCalendarSubMode } from "./PortalScheduleView";

const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

const SUB_ALLOWED_STATUSES = ["In Progress", "Complete"];

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

function parseUTCDate(yyyyMmDd: string): Date {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}
function addDays(date: Date, days: number) {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}
function todayUTC(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
function getMonday(d: Date) {
    const c = new Date(d.getTime());
    const day = c.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    c.setUTCDate(c.getUTCDate() + diff);
    return c;
}
function getMonthGrid(anchor: Date): Date[] {
    const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const start = getMonday(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
function getWeekDays(anchor: Date): Date[] {
    const monday = getMonday(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
function isSameUTCDay(a: Date, b: Date) {
    return a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth()
        && a.getUTCDate() === b.getUTCDate();
}
function taskCoversDay(task: PortalTask, day: Date): boolean {
    const start = parseUTCDate(task.startDate);
    const end = parseUTCDate(task.endDate);
    return day.getTime() >= start.getTime() && day.getTime() <= end.getTime();
}

interface Props {
    projectId: string;
    tasks: PortalTask[];
    setTasks: Dispatch<SetStateAction<PortalTask[]>>;
    subcontractorId: string | null;
    viewMode: PortalViewMode;
    onViewModeChange: (m: PortalViewMode) => void;
    subMode: PortalCalendarSubMode;
    onSubModeChange: (m: PortalCalendarSubMode) => void;
}

export default function PortalCalendarView({
    projectId: _projectId, tasks, setTasks, subcontractorId,
    viewMode, onViewModeChange, subMode, onSubModeChange,
}: Props) {
    const [anchor, setAnchor] = useState<Date>(() => todayUTC());
    const [selectedTask, setSelectedTask] = useState<PortalTask | null>(null);
    const [commentText, setCommentText] = useState("");
    const [submittingComment, setSubmittingComment] = useState(false);
    const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);

    const today = todayUTC();

    const gridDays = useMemo(
        () => subMode === "month" ? getMonthGrid(anchor) : getWeekDays(anchor),
        [subMode, anchor]
    );

    const tasksByDayKey = useMemo(() => {
        const map = new Map<string, PortalTask[]>();
        for (const day of gridDays) {
            const key = day.toISOString().split("T")[0];
            const matched = tasks.filter(t => taskCoversDay(t, day));
            map.set(key, matched);
        }
        return map;
    }, [gridDays, tasks]);

    function navPrev() {
        if (subMode === "week") setAnchor(prev => addDays(prev, -7));
        else setAnchor(prev => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)));
    }
    function navNext() {
        if (subMode === "week") setAnchor(prev => addDays(prev, 7));
        else setAnchor(prev => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)));
    }
    function navToday() { setAnchor(todayUTC()); }

    async function handleStatusChange(taskId: string, status: string) {
        if (!subcontractorId) return;
        setUpdatingStatus(taskId);
        try {
            await updateTaskStatusAsSub(taskId, subcontractorId, status);
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
            setSelectedTask(prev => prev && prev.id === taskId ? { ...prev, status } : prev);
        } catch (e) {
            console.error(e);
        } finally {
            setUpdatingStatus(null);
        }
    }

    async function handleAddComment() {
        if (!subcontractorId || !selectedTask || !commentText.trim()) return;
        const targetTaskId = selectedTask.id;
        setSubmittingComment(true);
        try {
            const created = await addTaskCommentAsSub(targetTaskId, subcontractorId, commentText.trim());
            const newComment = {
                id: created.id,
                text: created.text,
                createdAt: created.createdAt instanceof Date ? created.createdAt.toISOString() : new Date(created.createdAt as string).toISOString(),
                authorName: "You",
            };
            setTasks(prev => prev.map(t => t.id === targetTaskId
                ? { ...t, comments: [...(t.comments || []), newComment] }
                : t
            ));
            setSelectedTask(prev => prev && prev.id === targetTaskId
                ? { ...prev, comments: [...(prev.comments || []), newComment] }
                : prev);
            setCommentText("");
        } catch (e) {
            console.error(e);
        } finally {
            setSubmittingComment(false);
        }
    }

    const completedCount = tasks.filter(t => t.status === "Complete").length;
    const progressPct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

    if (tasks.length === 0) {
        return (
            <div className="flex flex-col h-full bg-white">
                <Toolbar
                    title={subMode === "week" ? formatWeekTitle(getMonday(anchor)) : `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`}
                    onPrev={navPrev} onNext={navNext} onToday={navToday}
                    subMode={subMode} onSubModeChange={onSubModeChange}
                    viewMode={viewMode} onViewModeChange={onViewModeChange}
                    progressPct={progressPct} totalTasks={tasks.length}
                />
                <div className="flex-1 flex flex-col items-center justify-center bg-slate-50 gap-4 py-20 px-6 text-center">
                    <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center">
                        <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-slate-700">No schedule available</h3>
                        <p className="text-sm text-slate-500 mt-1 max-w-sm">
                            {subcontractorId
                                ? "You have no tasks assigned to you on this project yet."
                                : "The project timeline has not been published yet. Please check back later."}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const headerTitle = subMode === "week"
        ? formatWeekTitle(getMonday(anchor))
        : `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;

    return (
        <div className="flex flex-col h-full bg-white relative">
            <Toolbar
                title={headerTitle}
                onPrev={navPrev} onNext={navNext} onToday={navToday}
                subMode={subMode} onSubModeChange={onSubModeChange}
                viewMode={viewMode} onViewModeChange={onViewModeChange}
                progressPct={progressPct} totalTasks={tasks.length}
            />

            {/* Calendar grid */}
            <div className="flex-1 overflow-auto">
                <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 sticky top-0 z-10">
                    {WEEKDAY_LABELS.map(l => (
                        <div key={l} className="px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center">
                            {l}
                        </div>
                    ))}
                </div>
                <div className={`grid grid-cols-7 ${subMode === "month" ? "auto-rows-fr min-h-full" : ""}`}>
                    {gridDays.map(day => {
                        const key = day.toISOString().split("T")[0];
                        const dayTasks = tasksByDayKey.get(key) || [];
                        const isToday = isSameUTCDay(day, today);
                        const isOtherMonth = subMode === "month" && day.getUTCMonth() !== anchor.getUTCMonth();
                        const maxVisible = subMode === "week" ? 8 : 3;
                        const hidden = Math.max(0, dayTasks.length - maxVisible);
                        return (
                            <div
                                key={key}
                                className={`relative border-r border-b border-slate-200 p-1.5 ${subMode === "week" ? "min-h-[420px]" : "min-h-[110px]"} ${isOtherMonth ? "bg-slate-50/60" : "bg-white"}`}
                            >
                                <div className={`text-xs font-semibold mb-1 ${isOtherMonth ? "text-slate-400" : "text-slate-700"}`}>
                                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${isToday ? "bg-blue-500 text-white" : ""}`}>
                                        {day.getUTCDate()}
                                    </span>
                                </div>
                                <div className="space-y-1">
                                    {dayTasks.slice(0, maxVisible).map(task => (
                                        <button
                                            key={task.id}
                                            onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                                            className="w-full text-left rounded px-1.5 py-1 text-[10px] font-medium leading-tight truncate hover:shadow-sm transition cursor-pointer"
                                            style={{ backgroundColor: task.color + "22", color: darkenForReadability(task.color), borderLeft: `3px solid ${task.color}` }}
                                            title={`${task.name} (${task.status})`}
                                        >
                                            {task.type === "milestone" ? "◆ " : ""}{task.name}
                                        </button>
                                    ))}
                                    {hidden > 0 && (
                                        <div className="text-[9px] font-semibold text-slate-500 px-1.5">+{hidden} more</div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Detail panel */}
            {selectedTask && (
                <div className="border-t border-slate-200 bg-white shrink-0 max-h-72 overflow-y-auto">
                    <div className="px-6 py-4">
                        <div className="flex items-start justify-between mb-3 gap-3">
                            <div className="min-w-0">
                                <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2 flex-wrap">
                                    {selectedTask.type === "milestone" ? "◆" : ""}
                                    <span className="truncate">{selectedTask.name}</span>
                                    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[selectedTask.status] || "bg-slate-100 text-slate-700"}`}>
                                        {selectedTask.status}
                                    </span>
                                </h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    {selectedTask.startDate} → {selectedTask.endDate}
                                    {selectedTask.progress > 0 && <> · {selectedTask.progress}% complete</>}
                                </p>
                            </div>
                            <button
                                onClick={() => setSelectedTask(null)}
                                aria-label="Close task details"
                                className="text-slate-400 hover:text-slate-600 text-lg leading-none shrink-0"
                            >×</button>
                        </div>

                        {subcontractorId && (
                            <div className="mb-3 flex items-center gap-2">
                                <span className="text-xs text-slate-500">Update status:</span>
                                <select
                                    value={SUB_ALLOWED_STATUSES.includes(selectedTask.status) ? selectedTask.status : ""}
                                    onChange={e => e.target.value && handleStatusChange(selectedTask.id, e.target.value)}
                                    disabled={updatingStatus === selectedTask.id}
                                    className="text-xs border border-slate-200 rounded px-2 py-1 bg-white disabled:opacity-50"
                                >
                                    {!SUB_ALLOWED_STATUSES.includes(selectedTask.status) && (
                                        <option value="" disabled>{selectedTask.status}</option>
                                    )}
                                    {SUB_ALLOWED_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>
                        )}

                        <div className="mb-3 space-y-2">
                            {(selectedTask.comments || []).length === 0 ? (
                                <p className="text-xs text-slate-400 italic">No comments yet.</p>
                            ) : (
                                (selectedTask.comments || []).map(c => (
                                    <div key={c.id} className="bg-slate-50 rounded px-3 py-2">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <span className="text-[10px] font-semibold text-amber-700">{c.authorName}</span>
                                            <span className="text-[9px] text-slate-400">{new Date(c.createdAt).toLocaleDateString()}</span>
                                        </div>
                                        <p className="text-xs text-slate-700">{c.text}</p>
                                    </div>
                                ))
                            )}
                        </div>

                        {subcontractorId && (
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={commentText}
                                    onChange={e => setCommentText(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") handleAddComment(); }}
                                    placeholder="Add a comment..."
                                    className="flex-1 text-xs border border-slate-200 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400"
                                />
                                <button
                                    onClick={handleAddComment}
                                    disabled={submittingComment || !commentText.trim()}
                                    className="px-3 py-1.5 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50 transition"
                                >
                                    {submittingComment ? "..." : "Send"}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatWeekTitle(monday: Date) {
    const sunday = addDays(monday, 6);
    const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth();
    const m1 = MONTH_LABELS[monday.getUTCMonth()].slice(0, 3);
    const m2 = MONTH_LABELS[sunday.getUTCMonth()].slice(0, 3);
    if (sameMonth) return `${m1} ${monday.getUTCDate()} – ${sunday.getUTCDate()}, ${monday.getUTCFullYear()}`;
    return `${m1} ${monday.getUTCDate()} – ${m2} ${sunday.getUTCDate()}, ${sunday.getUTCFullYear()}`;
}

function darkenForReadability(hex: string): string {
    // For light backgrounds (color+"22"), use a darker shade of the same hue for chip text.
    // Quick approximation: return the original color — most preset colors are dark enough.
    return hex;
}

function Toolbar({
    title, onPrev, onNext, onToday,
    subMode, onSubModeChange,
    viewMode, onViewModeChange,
    progressPct, totalTasks,
}: {
    title: string;
    onPrev: () => void;
    onNext: () => void;
    onToday: () => void;
    subMode: PortalCalendarSubMode;
    onSubModeChange: (m: PortalCalendarSubMode) => void;
    viewMode: PortalViewMode;
    onViewModeChange: (m: PortalViewMode) => void;
    progressPct: number;
    totalTasks: number;
}) {
    return (
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 shrink-0 gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-1">
                    <button onClick={onPrev} aria-label="Previous" className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-slate-100 text-slate-500 hover:text-slate-700">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    </button>
                    <button onClick={onNext} aria-label="Next" className="w-7 h-7 inline-flex items-center justify-center rounded hover:bg-slate-100 text-slate-500 hover:text-slate-700">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </button>
                </div>
                <button onClick={onToday} className="px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 rounded hover:bg-slate-50">
                    Today
                </button>
                <h2 className="text-sm font-semibold text-slate-800 truncate">{title}</h2>
                {totalTasks > 0 && (
                    <>
                        <span className="text-slate-300">•</span>
                        <div className="flex items-center gap-2">
                            <div className="w-20 h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-green-500 transition-all" style={{ width: `${progressPct}%` }} />
                            </div>
                            <span className="text-xs font-semibold text-slate-500 whitespace-nowrap">{progressPct}%</span>
                        </div>
                    </>
                )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                    {(["month", "week"] as PortalCalendarSubMode[]).map(s => (
                        <button
                            key={s}
                            onClick={() => onSubModeChange(s)}
                            className={`px-3 py-1 text-xs font-medium rounded-md transition capitalize ${subMode === s ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >{s}</button>
                    ))}
                </div>
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                    <button
                        onClick={() => onViewModeChange("calendar")}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition ${viewMode === "calendar" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >Calendar</button>
                    <button
                        onClick={() => onViewModeChange("gantt")}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition ${viewMode === "gantt" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >Gantt</button>
                </div>
            </div>
        </div>
    );
}
