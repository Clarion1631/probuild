"use client";

import { useState, useRef } from "react";
import { addTaskCommentAsSub, updateTaskStatusAsSub } from "@/lib/actions";

type Dependency = { id: string; predecessorId: string; dependentId: string };
type TeamMember = { id: string; name: string | null; email: string };
type Assignment = { id: string; userId: string; user: TeamMember };
type Comment = { id: string; text: string; createdAt: string; authorName: string };

type Task = {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    type: "task" | "milestone";
    order: number;
    dependencies: Dependency[];
    assignments?: Assignment[];
    comments?: Comment[];
};

type ZoomLevel = "day" | "week" | "month";

const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

const SUB_ALLOWED_STATUSES = ["In Progress", "Complete"];

function getDaysBetween(a: Date, b: Date) { return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))); }
function addDays(date: Date, days: number) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function formatDate(d: Date) { return d.toISOString().split("T")[0]; }
function getMonday(d: Date) { const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.setDate(diff)); }
function isWeekend(d: Date) { const day = d.getDay(); return day === 0 || day === 6; }

export default function PortalGanttChart({
    initialTasks,
    subcontractorId,
}: {
    initialTasks: Task[];
    subcontractorId: string | null;
}) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [zoom, setZoom] = useState<ZoomLevel>("week");
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [commentText, setCommentText] = useState("");
    const [submittingComment, setSubmittingComment] = useState(false);
    const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const allDates = tasks.flatMap(t => [new Date(t.startDate), new Date(t.endDate)]);
    const today = new Date();
    if (allDates.length === 0) { allDates.push(addDays(today, -14), addDays(today, 60)); }
    const minDate = addDays(new Date(Math.min(...allDates.map(d => d.getTime()))), -14);
    const maxDate = addDays(new Date(Math.max(...allDates.map(d => d.getTime()))), 30);
    const totalDays = getDaysBetween(minDate, maxDate);
    const colWidth = zoom === "day" ? 40 : zoom === "week" ? 20 : 8;
    const timelineWidth = totalDays * colWidth;
    const ROW_HEIGHT = 44;

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
        return {
            left: Math.max(0, getDaysBetween(minDate, start) * colWidth),
            width: Math.max(getDaysBetween(start, end) * colWidth, colWidth)
        };
    }

    function getWeekendColumns() {
        if (zoom === "month") return [];
        const cols: { left: number; width: number }[] = [];
        let cursor = new Date(minDate);
        for (let i = 0; i < totalDays; i++) {
            if (isWeekend(cursor)) cols.push({ left: i * colWidth, width: colWidth });
            cursor = addDays(cursor, 1);
        }
        return cols;
    }

    async function handleStatusChange(taskId: string, status: string) {
        if (!subcontractorId) return;
        setUpdatingStatus(taskId);
        try {
            await updateTaskStatusAsSub(taskId, subcontractorId, status);
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
            if (selectedTask?.id === taskId) setSelectedTask(prev => prev ? { ...prev, status } : prev);
        } catch (e) {
            console.error(e);
        } finally {
            setUpdatingStatus(null);
        }
    }

    async function handleAddComment() {
        if (!subcontractorId || !selectedTask || !commentText.trim()) return;
        setSubmittingComment(true);
        try {
            await addTaskCommentAsSub(selectedTask.id, subcontractorId, commentText.trim());
            const newComment: Comment = {
                id: Math.random().toString(),
                text: commentText.trim(),
                createdAt: new Date().toISOString(),
                authorName: "You",
            };
            setTasks(prev => prev.map(t => t.id === selectedTask.id
                ? { ...t, comments: [...(t.comments || []), newComment] }
                : t
            ));
            setSelectedTask(prev => prev ? { ...prev, comments: [...(prev.comments || []), newComment] } : prev);
            setCommentText("");
        } catch (e) {
            console.error(e);
        } finally {
            setSubmittingComment(false);
        }
    }

    const todayOffset = getDaysBetween(minDate, today) * colWidth;
    const headers = getHeaders();
    const weekendCols = getWeekendColumns();

    const arrows: { fromId: string; toId: string }[] = [];
    tasks.forEach(t => t.dependencies.forEach(d => arrows.push({ fromId: d.predecessorId, toId: d.dependentId })));

    if (tasks.length === 0) {
        return (
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
        );
    }

    const completedCount = tasks.filter(t => t.status === "Complete").length;
    const progressPct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

    return (
        <div className="flex flex-col h-full bg-white relative">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 shrink-0">
                <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-slate-600">{tasks.length} tasks</span>
                    <span className="text-slate-300">•</span>
                    <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 transition-all" style={{ width: `${progressPct}%` }} />
                        </div>
                        <span className="text-xs font-semibold text-slate-500">{progressPct}% Complete</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-lg">
                    {(["day", "week", "month"] as ZoomLevel[]).map(z => (
                        <button key={z} onClick={() => setZoom(z)} className={`px-3 py-1 text-xs font-medium rounded-md transition capitalize ${zoom === z ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{z}</button>
                    ))}
                </div>
                <button onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayOffset - 200); }} className="px-3 py-1 text-xs font-medium bg-white border border-slate-200 rounded-md hover:bg-slate-50">Today</button>
            </div>

            <div className="flex flex-1 overflow-hidden">
                {/* Task List */}
                <div className="w-72 shrink-0 bg-white border-r border-slate-200 flex flex-col z-10 shadow-[2px_0_8px_rgba(0,0,0,0.03)]">
                    <div className="flex items-center px-4 h-[36px] bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        <div className="flex-1">Task Name</div>
                        <div className="w-24 text-center">Status</div>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {tasks.map(task => (
                            <div
                                key={task.id}
                                onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                                className={`flex items-center px-4 border-b border-slate-100 hover:bg-slate-50 transition min-h-[44px] cursor-pointer ${selectedTask?.id === task.id ? "bg-amber-50" : ""}`}
                                style={subcontractorId ? { borderLeft: "3px solid #f59e0b" } : undefined}
                            >
                                {task.type === "milestone" ? (
                                    <div className="w-3 h-3 rotate-45 border-2 mr-3 shrink-0" style={{ backgroundColor: task.color, borderColor: task.color }} />
                                ) : (
                                    <div className="w-2.5 h-2.5 rounded-full mr-3 shrink-0" style={{ backgroundColor: task.color }} />
                                )}
                                <div className="flex-1 min-w-0 pr-2">
                                    <div className="text-xs font-medium text-slate-800 truncate" title={task.name}>{task.name}</div>
                                    {(task.assignments || []).length > 0 && (
                                        <div className="flex items-center gap-1 mt-0.5">
                                            {(task.assignments || []).slice(0, 2).map(a => (
                                                <span key={a.userId} className="text-[9px] text-slate-500 truncate">{a.user.name || a.user.email}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="w-24 shrink-0 flex justify-end">
                                    {subcontractorId ? (
                                        <select
                                            value={task.status}
                                            onChange={e => { e.stopPropagation(); handleStatusChange(task.id, e.target.value); }}
                                            disabled={updatingStatus === task.id}
                                            onClick={e => e.stopPropagation()}
                                            className="text-[9px] font-semibold px-1 py-0.5 rounded border border-slate-200 bg-white cursor-pointer disabled:opacity-50"
                                        >
                                            {SUB_ALLOWED_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                            {!SUB_ALLOWED_STATUSES.includes(task.status) && (
                                                <option value={task.status} disabled>{task.status}</option>
                                            )}
                                        </select>
                                    ) : (
                                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-700"}`}>
                                            {task.status}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Timeline */}
                <div ref={scrollRef} className="flex-1 overflow-auto bg-slate-50/50 relative">
                    <div style={{ width: timelineWidth, minHeight: "100%" }} className="relative bg-white">
                        <div className="sticky top-0 z-20 flex bg-slate-50 border-b border-slate-200 h-[36px]">
                            {headers.map(h => (
                                <div key={h.key} className="text-[10px] font-semibold text-slate-500 border-r border-slate-200/60 flex items-center justify-center shrink-0 uppercase tracking-wider" style={{ width: h.span * colWidth }}>
                                    {h.label}
                                </div>
                            ))}
                        </div>

                        {weekendCols.map((wc, i) => (
                            <div key={`wk-${i}`} className="absolute top-[36px] bottom-0 bg-slate-100/50 pointer-events-none z-[1]" style={{ left: wc.left, width: wc.width }} />
                        ))}

                        <div className="absolute top-0 bottom-0 w-px z-[5] pointer-events-none" style={{ left: todayOffset, background: "repeating-linear-gradient(to bottom, #ef4444 0, #ef4444 4px, transparent 4px, transparent 8px)" }}>
                            <div className="absolute top-10 -translate-x-1/2 bg-red-500 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-md shadow">TODAY</div>
                        </div>

                        <svg className="absolute top-0 left-0 pointer-events-none z-[4]" style={{ width: timelineWidth, height: 36 + tasks.length * ROW_HEIGHT }}>
                            <defs><marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" fill="#cbd5e1" /></marker></defs>
                            {arrows.map((arrow, i) => {
                                const ft = tasks.find(t => t.id === arrow.fromId), tt = tasks.find(t => t.id === arrow.toId);
                                if (!ft || !tt) return null;
                                const fb = getBarStyle(ft), tb = getBarStyle(tt);
                                const x1 = fb.left + fb.width, y1 = 36 + tasks.indexOf(ft) * ROW_HEIGHT + ROW_HEIGHT / 2;
                                const x2 = tb.left, y2 = 36 + tasks.indexOf(tt) * ROW_HEIGHT + ROW_HEIGHT / 2;
                                const mx = x2 - 5 > x1 + 5 ? (x1 + x2) / 2 : x1 + 10;
                                return <path key={`a-${i}`} d={`M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`} fill="none" stroke="#cbd5e1" strokeWidth="1.5" markerEnd="url(#arrowhead)" />;
                            })}
                        </svg>

                        {tasks.map((task, idx) => {
                            const bar = getBarStyle(task);
                            const topY = 36 + idx * ROW_HEIGHT;
                            if (task.type === "milestone") {
                                const cx = bar.left + 8;
                                return (
                                    <div key={task.id} className="absolute flex items-center" style={{ top: topY, left: cx - 12, width: 100, height: ROW_HEIGHT }}>
                                        <div className="flex items-center gap-2">
                                            <div className="w-4 h-4 rotate-45 border-2 shadow-sm shrink-0" style={{ backgroundColor: task.color, borderColor: task.color }} />
                                            {colWidth > 10 && <span className="text-[10px] font-bold whitespace-nowrap" style={{ color: task.color }}>{task.name}</span>}
                                        </div>
                                    </div>
                                );
                            }
                            return (
                                <div key={task.id} className="absolute flex items-center px-1" style={{ top: topY, left: bar.left, width: bar.width, height: ROW_HEIGHT }}>
                                    <div className="w-full h-6 rounded-md shadow-sm relative overflow-hidden border border-black/5" style={{ backgroundColor: task.color + "22" }}>
                                        <div className="absolute inset-0 rounded-md transition-all" style={{ width: `${task.progress}%`, backgroundColor: task.color }} />
                                        <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-md" style={{ backgroundColor: task.color }} />
                                        <div className="relative z-[2] flex items-center justify-between h-full px-2" title={`${task.name} (${task.progress}%)`}>
                                            <span className="text-[10px] font-bold truncate leading-none" style={{ color: task.progress > 50 ? "#fff" : task.color, textShadow: task.progress > 50 ? '0 1px 1px rgba(0,0,0,0.1)' : 'none' }}>
                                                {bar.width > 50 ? task.name : ""}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}

                        {headers.map((h, i) => {
                            let x = 0;
                            for (let j = 0; j < i; j++) x += headers[j].span * colWidth;
                            return <div key={`g-${h.key}`} className="absolute top-[36px] bottom-0 border-r border-slate-200/40 pointer-events-none" style={{ left: x }} />;
                        })}
                    </div>
                </div>
            </div>

            {/* Sub detail panel — shown when a task is selected and subcontractor is viewing */}
            {selectedTask && subcontractorId && (
                <div className="border-t border-slate-200 bg-white shrink-0 max-h-64 overflow-y-auto">
                    <div className="px-6 py-4">
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <h3 className="font-semibold text-slate-800 text-sm">{selectedTask.name}</h3>
                                <p className="text-xs text-slate-500 mt-0.5">{selectedTask.startDate} → {selectedTask.endDate}</p>
                            </div>
                            <button onClick={() => setSelectedTask(null)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
                        </div>

                        {/* Comments */}
                        <div className="mb-3 space-y-2">
                            {(selectedTask.comments || []).length === 0 && (
                                <p className="text-xs text-slate-400 italic">No comments yet.</p>
                            )}
                            {(selectedTask.comments || []).map(c => (
                                <div key={c.id} className="bg-slate-50 rounded px-3 py-2">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-[10px] font-semibold text-amber-700">{c.authorName}</span>
                                        <span className="text-[9px] text-slate-400">{new Date(c.createdAt).toLocaleDateString()}</span>
                                    </div>
                                    <p className="text-xs text-slate-700">{c.text}</p>
                                </div>
                            ))}
                        </div>

                        {/* Add comment */}
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
                    </div>
                </div>
            )}
        </div>
    );
}
