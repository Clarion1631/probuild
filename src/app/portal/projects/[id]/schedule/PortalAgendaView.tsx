"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { addTaskCommentAsSub, updateTaskStatusAsSub } from "@/lib/actions";
import type { PortalTask, PortalViewMode } from "./PortalScheduleView";

const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

const SUB_ALLOWED_STATUSES = ["In Progress", "Complete"];

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseUTCDate(yyyyMmDd: string): Date {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}
function todayUTC(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
function getMonday(d: Date) {
    const c = new Date(d.getTime());
    const day = c.getUTCDay();
    c.setUTCDate(c.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return c;
}
function fmtDay(d: Date) {
    return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function fmtRange(task: PortalTask) {
    const start = parseUTCDate(task.startDate);
    const end = parseUTCDate(task.endDate);
    if (task.type === "milestone" || start.getTime() === end.getTime()) return fmtDay(start);
    return `${fmtDay(start)} – ${fmtDay(end)}`;
}
function weekLabel(monday: Date, currentMonday: Date) {
    const diffWeeks = Math.round((monday.getTime() - currentMonday.getTime()) / (7 * 24 * 3600 * 1000));
    if (diffWeeks === 0) return "This week";
    if (diffWeeks === 1) return "Next week";
    const year = monday.getUTCFullYear() === todayUTC().getUTCFullYear() ? "" : `, ${monday.getUTCFullYear()}`;
    return `Week of ${fmtDay(monday)}${year}`;
}

interface Props {
    tasks: PortalTask[];
    setTasks: Dispatch<SetStateAction<PortalTask[]>>;
    subcontractorId: string | null;
    viewMode: PortalViewMode;
    onViewModeChange: (m: PortalViewMode) => void;
}

export default function PortalAgendaView({ tasks, setTasks, subcontractorId, viewMode, onViewModeChange }: Props) {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [commentText, setCommentText] = useState("");
    const [submittingComment, setSubmittingComment] = useState(false);
    const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
    const currentWeekRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const today = todayUTC();
    const currentMonday = getMonday(today);

    // Chronological, grouped by the Monday of each task's start week.
    const groups = useMemo(() => {
        const sorted = [...tasks].sort((a, b) =>
            a.startDate === b.startDate ? a.order - b.order : a.startDate.localeCompare(b.startDate));
        const byWeek = new Map<number, PortalTask[]>();
        for (const t of sorted) {
            const key = getMonday(parseUTCDate(t.startDate)).getTime();
            const list = byWeek.get(key) || [];
            list.push(t);
            byWeek.set(key, list);
        }
        return [...byWeek.entries()]
            .sort(([a], [b]) => a - b)
            .map(([ms, list]) => ({ monday: new Date(ms), tasks: list }));
    }, [tasks]);

    // Anchor "Today" on the first group that is current/future OR still has a running task;
    // when the whole schedule is in the past, land on the final week.
    let anchorIdx = groups.findIndex(g =>
        g.monday.getTime() >= currentMonday.getTime()
        || g.tasks.some(t => parseUTCDate(t.endDate).getTime() >= today.getTime()));
    if (anchorIdx === -1) anchorIdx = groups.length - 1;
    const anchorTime = groups[anchorIdx]?.monday.getTime();

    // Land the reader on the anchor week instead of the project's start.
    useEffect(() => {
        currentWeekRef.current?.scrollIntoView({ block: "start" });
        // Re-run when the anchor week changes, not on status/comment updates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchorTime]);

    async function handleStatusChange(taskId: string, status: string) {
        if (!subcontractorId) return;
        setUpdatingStatus(taskId);
        try {
            await updateTaskStatusAsSub(taskId, subcontractorId, status);
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
        } catch (e) {
            console.error(e);
        } finally {
            setUpdatingStatus(null);
        }
    }

    function toggleExpanded(taskId: string) {
        setExpandedId(prev => {
            if (prev !== taskId) setCommentText("");
            return prev === taskId ? null : taskId;
        });
    }

    async function handleAddComment(taskId: string) {
        if (!subcontractorId || !commentText.trim() || submittingComment) return;
        setSubmittingComment(true);
        try {
            const created = await addTaskCommentAsSub(taskId, subcontractorId, commentText.trim());
            const newComment = {
                id: created.id,
                text: created.text,
                createdAt: created.createdAt instanceof Date ? created.createdAt.toISOString() : new Date(created.createdAt as string).toISOString(),
                authorName: "You",
            };
            setTasks(prev => prev.map(t => t.id === taskId
                ? { ...t, comments: [...(t.comments || []), newComment] }
                : t
            ));
            setCommentText("");
        } catch (e) {
            console.error(e);
        } finally {
            setSubmittingComment(false);
        }
    }

    const completedCount = tasks.filter(t => t.status === "Complete").length;
    const progressPct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-slate-200 shrink-0 gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                    <button
                        onClick={() => currentWeekRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}
                        className="px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 rounded hover:bg-slate-50"
                    >Today</button>
                    {tasks.length > 0 && (
                        <div className="flex items-center gap-2">
                            <div className="w-20 h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-green-500 transition-all" style={{ width: `${progressPct}%` }} />
                            </div>
                            <span className="text-xs font-semibold text-slate-500 whitespace-nowrap">{progressPct}% · {completedCount}/{tasks.length} done</span>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                    {(["agenda", "calendar", "gantt"] as PortalViewMode[]).map(m => (
                        <button
                            key={m}
                            onClick={() => onViewModeChange(m)}
                            aria-pressed={viewMode === m}
                            className={`px-3 py-1 text-xs font-medium rounded-md transition capitalize ${viewMode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >{m}</button>
                    ))}
                </div>
            </div>

            {tasks.length === 0 ? (
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
            ) : (
                <div ref={scrollRef} className="flex-1 overflow-y-auto">
                    {groups.map((group, gi) => {
                        const isPastWeek = group.monday.getTime() < currentMonday.getTime();
                        const isCurrent = group.monday.getTime() === currentMonday.getTime();
                        return (
                            <div key={group.monday.getTime()} ref={gi === anchorIdx ? currentWeekRef : undefined} className="scroll-mt-2">
                                <div className={`sticky top-0 z-10 px-4 sm:px-6 py-2 text-[11px] font-bold uppercase tracking-wider border-b border-slate-100 ${isCurrent ? "bg-amber-50 text-amber-700" : "bg-slate-50 text-slate-500"}`}>
                                    {weekLabel(group.monday, currentMonday)}
                                </div>
                                <div className="divide-y divide-slate-100">
                                    {group.tasks.map(task => {
                                        const isDone = task.status === "Complete";
                                        const expanded = expandedId === task.id;
                                        const assignees = [
                                            ...(task.assignments || []).map(a => a.firstName),
                                            ...(task.subAssignments || []).map(a => a.companyName),
                                        ];
                                        return (
                                            <div key={task.id} className={isPastWeek && isDone ? "opacity-60" : ""}>
                                                <div
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => toggleExpanded(task.id)}
                                                    onKeyDown={e => {
                                                        // Only act on keys aimed at the row itself — the nested
                                                        // status <select> must keep its native keyboard behavior.
                                                        if (e.target !== e.currentTarget) return;
                                                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(task.id); }
                                                    }}
                                                    className="flex items-center gap-3 px-4 sm:px-6 py-3 cursor-pointer hover:bg-slate-50 transition"
                                                    style={{ borderLeft: `3px solid ${task.color}` }}
                                                >
                                                    {task.type === "milestone" ? (
                                                        <div className="w-3 h-3 rotate-45 border-2 shrink-0" style={{ backgroundColor: task.color, borderColor: task.color }} />
                                                    ) : (
                                                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: task.color }} />
                                                    )}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium text-slate-800">{task.name}</div>
                                                        <div className="text-xs text-slate-500 mt-0.5">
                                                            {fmtRange(task)}
                                                            {task.progress > 0 && !isDone && <> · {task.progress}%</>}
                                                            {assignees.length > 0 && <> · {assignees.slice(0, 2).join(", ")}</>}
                                                        </div>
                                                    </div>
                                                    {subcontractorId ? (
                                                        <select
                                                            value={SUB_ALLOWED_STATUSES.includes(task.status) ? task.status : ""}
                                                            onChange={e => { e.stopPropagation(); e.target.value && handleStatusChange(task.id, e.target.value); }}
                                                            onClick={e => e.stopPropagation()}
                                                            disabled={updatingStatus === task.id}
                                                            className="text-xs border border-slate-200 rounded px-1.5 py-1 bg-white shrink-0 disabled:opacity-50"
                                                        >
                                                            {!SUB_ALLOWED_STATUSES.includes(task.status) && (
                                                                <option value="" disabled>{task.status}</option>
                                                            )}
                                                            {SUB_ALLOWED_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                                        </select>
                                                    ) : (
                                                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-700"}`}>
                                                            {task.status}
                                                        </span>
                                                    )}
                                                </div>
                                                {expanded && (
                                                    <div className="px-4 sm:px-6 pb-4 pt-1 bg-slate-50/60">
                                                        <div className="space-y-2 mb-2">
                                                            {(task.comments || []).length === 0 ? (
                                                                <p className="text-xs text-slate-400 italic">No comments yet.</p>
                                                            ) : (
                                                                (task.comments || []).map(c => (
                                                                    <div key={c.id} className="bg-white rounded px-3 py-2 border border-slate-100">
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
                                                                    onKeyDown={e => { if (e.key === "Enter") handleAddComment(task.id); }}
                                                                    placeholder="Add a comment..."
                                                                    className="flex-1 text-xs border border-slate-200 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400"
                                                                />
                                                                <button
                                                                    onClick={() => handleAddComment(task.id)}
                                                                    disabled={submittingComment || !commentText.trim()}
                                                                    className="px-3 py-1.5 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50 transition"
                                                                >
                                                                    {submittingComment ? "..." : "Send"}
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                    <div className="py-8 text-center text-xs text-slate-400">End of schedule</div>
                </div>
            )}
        </div>
    );
}
