"use client";

import { useState, useRef } from "react";

type MasterTask = {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    color: string;
    progress: number;
    status: string;
    estimatedHours: number | null;
    actualHours: number;
    projectId: string;
    projectName: string;
    projectType: string | null;
    assignments: { userId: string; userName: string; userEmail: string }[];
};

type TeamMember = { id: string; name: string | null; email: string; role: string };
type ZoomLevel = "day" | "week" | "month";

function getDaysBetween(a: Date, b: Date) { return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)); }
function addDays(date: Date, days: number) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function formatDate(d: Date) { return d.toISOString().split("T")[0]; }
function getMonday(d: Date) { const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.setDate(diff)); }
function isWeekend(d: Date) { return d.getDay() === 0 || d.getDay() === 6; }
function getInitials(name: string) { return name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2); }

const PROJECT_COLORS = ["#6366f1", "#8b5cf6", "#06b6d4", "#14b8a6", "#f59e0b", "#ef4444", "#ec4899", "#64748b"];
const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-600",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

export default function MasterGantt({ initialTasks, teamMembers }: {
    initialTasks: MasterTask[];
    teamMembers: TeamMember[];
}) {
    const [tasks] = useState<MasterTask[]>(initialTasks);
    const [zoom, setZoom] = useState<ZoomLevel>("week");
    const [filterMember, setFilterMember] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"project" | "member">("project");
    const scrollRef = useRef<HTMLDivElement>(null);

    const today = new Date();
    const ROW_HEIGHT = 44;
    const GROUP_HEADER_HEIGHT = 36;

    // Filter by member if selected
    const filteredTasks = filterMember
        ? tasks.filter(t => t.assignments.some(a => a.userId === filterMember))
        : tasks;

    // Group tasks
    const groups: { key: string; label: string; color: string; tasks: MasterTask[] }[] = [];
    if (viewMode === "project") {
        const projectMap = new Map<string, MasterTask[]>();
        filteredTasks.forEach(t => {
            if (!projectMap.has(t.projectId)) projectMap.set(t.projectId, []);
            projectMap.get(t.projectId)!.push(t);
        });
        let colorIdx = 0;
        projectMap.forEach((tasks, projectId) => {
            groups.push({ key: projectId, label: tasks[0].projectName, color: PROJECT_COLORS[colorIdx % PROJECT_COLORS.length], tasks });
            colorIdx++;
        });
    } else {
        const memberMap = new Map<string, MasterTask[]>();
        const unassigned: MasterTask[] = [];
        filteredTasks.forEach(t => {
            if (t.assignments.length === 0) { unassigned.push(t); return; }
            t.assignments.forEach(a => {
                if (!memberMap.has(a.userId)) memberMap.set(a.userId, []);
                memberMap.get(a.userId)!.push(t);
            });
        });
        let colorIdx = 0;
        memberMap.forEach((tasks, userId) => {
            const member = teamMembers.find(m => m.id === userId);
            groups.push({ key: userId, label: member?.name || member?.email || "Unknown", color: PROJECT_COLORS[colorIdx % PROJECT_COLORS.length], tasks });
            colorIdx++;
        });
        if (unassigned.length > 0) groups.push({ key: "unassigned", label: "Unassigned", color: "#94a3b8", tasks: unassigned });
    }

    // Timeline range
    const allDates = filteredTasks.flatMap(t => [new Date(t.startDate), new Date(t.endDate)]);
    if (allDates.length === 0) { allDates.push(addDays(today, -14), addDays(today, 60)); }
    const minDate = addDays(new Date(Math.min(...allDates.map(d => d.getTime()))), -14);
    const maxDate = addDays(new Date(Math.max(...allDates.map(d => d.getTime()))), 30);
    const totalDays = getDaysBetween(minDate, maxDate);
    const colWidth = zoom === "day" ? 36 : zoom === "week" ? 18 : 7;
    const timelineWidth = totalDays * colWidth;
    const todayOffset = getDaysBetween(minDate, today) * colWidth;

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

    function getWeekendColumns() {
        const cols: { left: number; width: number }[] = [];
        let cursor = new Date(minDate);
        for (let i = 0; i < totalDays; i++) { if (isWeekend(cursor)) cols.push({ left: i * colWidth, width: colWidth }); cursor = addDays(cursor, 1); }
        return cols;
    }

    function getBarStyle(task: MasterTask) {
        const start = new Date(task.startDate), end = new Date(task.endDate);
        return { left: getDaysBetween(minDate, start) * colWidth, width: Math.max(getDaysBetween(start, end) * colWidth, colWidth) };
    }

    const headers = getHeaders();
    const weekendCols = getWeekendColumns();

    // Flatten rows for positioning
    let totalRows = 0;
    const rowMap: { type: "group" | "task"; yOffset: number; group?: typeof groups[0]; task?: MasterTask; groupColor?: string }[] = [];
    groups.forEach(g => {
        rowMap.push({ type: "group", yOffset: totalRows, group: g });
        totalRows += GROUP_HEADER_HEIGHT;
        g.tasks.forEach(t => {
            rowMap.push({ type: "task", yOffset: totalRows, task: t, groupColor: g.color });
            totalRows += ROW_HEIGHT;
        });
    });

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="bg-white border-b border-hui-border px-6 py-3 flex items-center justify-between shrink-0 shadow-sm z-20">
                <div className="flex items-center gap-4">
                    <h1 className="text-xl font-bold text-hui-textMain">Master Schedule</h1>
                    <span className="text-sm text-hui-textMuted">{filteredTasks.length} tasks across {groups.length} {viewMode === "project" ? "projects" : "members"}</span>
                </div>
                <div className="flex items-center gap-3">
                    {/* View Mode Toggle */}
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                        <button onClick={() => setViewMode("project")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "project" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>
                            📁 By Project
                        </button>
                        <button onClick={() => setViewMode("member")} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "member" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>
                            👤 By Member
                        </button>
                    </div>
                    {/* Zoom */}
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                        {(["day", "week", "month"] as ZoomLevel[]).map(z => (
                            <button key={z} onClick={() => setZoom(z)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition capitalize ${zoom === z ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>{z}</button>
                        ))}
                    </div>
                    <button onClick={() => { if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, todayOffset - 300); }} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Today</button>
                    {/* Member Filter */}
                    <select value={filterMember || ""} onChange={e => setFilterMember(e.target.value || null)} className="hui-input text-xs py-1.5 w-48">
                        <option value="">All Members</option>
                        {teamMembers.map(m => (<option key={m.id} value={m.id}>{m.name || m.email}</option>))}
                    </select>
                </div>
            </div>

            <div className="flex flex-1 overflow-hidden">
                {/* Left Panel */}
                <div className="w-80 shrink-0 bg-white border-r border-hui-border flex flex-col z-10">
                    <div className="flex items-center px-4 py-2 bg-slate-50 border-b border-hui-border text-[10px] font-bold text-slate-400 uppercase tracking-wider h-[40px]">
                        <div className="flex-1">{viewMode === "project" ? "Project / Task" : "Member / Task"}</div>
                        <div className="w-16 text-center">Status</div>
                        <div className="w-20 text-center">Crew</div>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {rowMap.map((row, i) => {
                            if (row.type === "group") {
                                return (
                                    <div key={`g-${row.group!.key}`} className="flex items-center px-4 bg-slate-50/80 border-b border-slate-200" style={{ height: GROUP_HEADER_HEIGHT }}>
                                        <div className="w-2.5 h-2.5 rounded-full mr-2.5 shrink-0" style={{ backgroundColor: row.group!.color }} />
                                        <span className="text-xs font-bold text-hui-textMain truncate flex-1">{row.group!.label}</span>
                                        <span className="text-[10px] text-slate-400 font-medium">{row.group!.tasks.length} tasks</span>
                                    </div>
                                );
                            }
                            const task = row.task!;
                            return (
                                <div key={task.id} className="flex items-center px-4 pl-8 border-b border-slate-100 hover:bg-slate-50/80 transition" style={{ height: ROW_HEIGHT }}>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-medium text-hui-textMain truncate">{task.name}</div>
                                        {viewMode === "member" && <div className="text-[9px] text-slate-400 truncate">{task.projectName}</div>}
                                    </div>
                                    <div className="w-16 flex justify-center">
                                        <span className={`text-[8px] font-semibold rounded-full px-1.5 py-0.5 ${STATUS_COLORS[task.status] || "bg-slate-100 text-slate-600"}`}>{task.status.replace("Not ", "N/")}</span>
                                    </div>
                                    <div className="w-20 flex justify-center">
                                        <div className="flex -space-x-1.5">
                                            {task.assignments.slice(0, 3).map(a => (
                                                <div key={a.userId} className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[7px] font-bold flex items-center justify-center border border-white" title={a.userName}>
                                                    {getInitials(a.userName)}
                                                </div>
                                            ))}
                                            {task.assignments.length === 0 && <span className="text-[9px] text-slate-300">—</span>}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Timeline */}
                <div ref={scrollRef} className="flex-1 overflow-auto bg-slate-50/50 relative">
                    <div style={{ width: timelineWidth, minHeight: "100%" }} className="relative">
                        {/* Header */}
                        <div className="sticky top-0 z-10 flex bg-slate-50 border-b border-hui-border h-[40px]">
                            {headers.map(h => (<div key={h.key} className="text-[10px] font-semibold text-slate-500 border-r border-slate-200/60 flex items-center justify-center shrink-0 uppercase tracking-wider" style={{ width: h.span * colWidth }}>{h.label}</div>))}
                        </div>

                        {/* Weekend shading */}
                        {weekendCols.map((wc, i) => (<div key={`wk-${i}`} className="absolute top-[40px] bottom-0 bg-slate-200/25 pointer-events-none z-[1]" style={{ left: wc.left, width: wc.width }} />))}

                        {/* Today line */}
                        <div className="absolute top-0 bottom-0 w-px z-[5] pointer-events-none" style={{ left: todayOffset, background: "repeating-linear-gradient(to bottom, #ef4444 0, #ef4444 4px, transparent 4px, transparent 8px)" }}>
                            <div className="absolute -top-0 -translate-x-1/2 bg-red-500 text-white text-[8px] font-bold px-1 py-0.5 rounded-b-md shadow">TODAY</div>
                        </div>

                        {/* Group headers + Task bars */}
                        {rowMap.map((row, i) => {
                            if (row.type === "group") {
                                return (
                                    <div key={`gbar-${row.group!.key}`} className="absolute w-full border-b border-slate-200 bg-slate-50/60" style={{ top: 40 + row.yOffset, height: GROUP_HEADER_HEIGHT }} />
                                );
                            }
                            const task = row.task!;
                            const bar = getBarStyle(task);
                            const ap = task.estimatedHours && task.actualHours > 0 ? Math.min(100, Math.round((task.actualHours / task.estimatedHours) * 100)) : task.progress;
                            return (
                                <div key={task.id} className="absolute flex items-center" style={{ top: 40 + row.yOffset + 8, left: bar.left, width: bar.width, height: ROW_HEIGHT - 16 }}>
                                    <div className="w-full h-full rounded-md shadow-sm relative overflow-hidden border border-black/5" style={{ backgroundColor: (row.groupColor || task.color) + "22" }}>
                                        <div className="absolute inset-0 rounded-md" style={{ width: `${ap}%`, backgroundColor: row.groupColor || task.color, opacity: 0.6 }} />
                                        <div className="relative z-[2] flex items-center justify-between h-full px-1.5">
                                            <span className="text-[9px] font-semibold truncate" style={{ color: ap > 50 ? "#fff" : (row.groupColor || task.color) }}>{task.name}</span>
                                            {task.assignments.length > 0 && bar.width > 60 && (
                                                <div className="flex -space-x-1 ml-1">{task.assignments.slice(0,2).map(a => (
                                                    <div key={a.userId} className="w-3.5 h-3.5 rounded-full bg-white text-[6px] font-bold flex items-center justify-center border border-slate-200" style={{ color: row.groupColor || task.color }}>{getInitials(a.userName)}</div>
                                                ))}</div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}

                        {/* Grid lines */}
                        {headers.map((h, i) => { let x = 0; for (let j = 0; j < i; j++) x += headers[j].span * colWidth; return (<div key={`g-${h.key}`} className="absolute top-[40px] bottom-0 border-r border-slate-200/40 pointer-events-none" style={{ left: x }} />); })}
                    </div>
                </div>
            </div>
        </div>
    );
}
