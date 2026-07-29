"use client";

import { useState, useEffect, useMemo, type RefObject } from "react";
import Link from "next/link";
import { FloatingPopover } from "@/app/company-dashboard/schedule-board/FloatingPopover";
import { getTaskTimeEntries } from "@/lib/actions";
import type { TimeEntryDetail } from "./schedule-types";

type SortField = "date" | "person" | "hours" | "costCode";
type DayGroup = { dateKey: string; label: string; entries: TimeEntryDetail[]; total: number };
type WeekGroup = { weekKey: string; label: string; days: DayGroup[]; total: number };

export type ProgressPopoverProps = {
    open: boolean;
    /** The progress bar button the panel opens from. */
    anchorRef: RefObject<HTMLElement | null>;
    taskId: string;
    taskColor: string;
    progress: number;
    estimatedHours: number | null;
    actualHours: number;
    projectId: string;
    onClose: () => void;
};

function formatDate(d: string | Date): string {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDayLabel(d: string | Date): string {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function getMonday(d: Date): Date {
    const date = new Date(d);
    const day = date.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setUTCDate(date.getUTCDate() + diff);
    date.setUTCHours(0, 0, 0, 0);
    return date;
}

function personName(user: { name: string | null; email: string }): string {
    if (user.name) return user.name;
    return user.email.split("@")[0];
}

function fmt(n: number): string {
    return n % 1 === 0 ? String(n) : n.toFixed(1);
}

export default function ProgressPopover({ open, anchorRef, taskId, taskColor, progress, estimatedHours, actualHours, projectId, onClose }: ProgressPopoverProps) {
    const [entries, setEntries] = useState<TimeEntryDetail[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [sortField, setSortField] = useState<SortField>("date");
    const [sortAsc, setSortAsc] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        getTaskTimeEntries(taskId)
            .then(data => {
                if (cancelled) return;
                setEntries(data.entries.map((e: any) => ({ ...e, startTime: typeof e.startTime === "object" ? (e.startTime as Date).toISOString() : e.startTime })));
                setTotal(data.total);
                setLoading(false);
            })
            .catch(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [taskId]);


    function toggleSort(field: SortField) {
        if (sortField === field) setSortAsc(!sortAsc);
        else { setSortField(field); setSortAsc(field === "person" || field === "costCode"); }
    }

    const sorted = useMemo(() => {
        const arr = [...entries];
        arr.sort((a, b) => {
            let cmp = 0;
            switch (sortField) {
                case "date": cmp = new Date(a.startTime).getTime() - new Date(b.startTime).getTime(); break;
                case "person": cmp = personName(a.user).localeCompare(personName(b.user)); break;
                case "hours": cmp = (a.durationHours ?? 0) - (b.durationHours ?? 0); break;
                case "costCode": cmp = (a.costCode?.code ?? "").localeCompare(b.costCode?.code ?? ""); break;
            }
            return sortAsc ? cmp : -cmp;
        });
        return arr;
    }, [entries, sortField, sortAsc]);

    const grouped = useMemo((): { weeks: WeekGroup[]; grandTotal: number } | null => {
        if (sortField !== "date" || entries.length === 0) return null;
        const byDate = [...entries].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

        const days: DayGroup[] = [];
        let curDay: DayGroup | null = null;
        for (const e of byDate) {
            const dk = new Date(e.startTime).toISOString().split("T")[0];
            if (!curDay || curDay.dateKey !== dk) {
                curDay = { dateKey: dk, label: formatDayLabel(e.startTime), entries: [], total: 0 };
                days.push(curDay);
            }
            curDay.entries.push(e);
            curDay.total += e.durationHours ?? 0;
        }

        const weeks: WeekGroup[] = [];
        let curWeek: WeekGroup | null = null;
        for (const day of days) {
            const mon = getMonday(new Date(day.dateKey));
            const wk = mon.toISOString().split("T")[0];
            if (!curWeek || curWeek.weekKey !== wk) {
                curWeek = { weekKey: wk, label: `Wk of ${formatDate(mon)}`, days: [], total: 0 };
                weeks.push(curWeek);
            }
            curWeek.days.push(day);
            curWeek.total += day.total;
        }

        return { weeks, grandTotal: entries.reduce((s, e) => s + (e.durationHours ?? 0), 0) };
    }, [entries, sortField]);

    const grandTotal = useMemo(() => entries.reduce((s, e) => s + (e.durationHours ?? 0), 0), [entries]);
    const isDateSort = sortField === "date";
    const multiWeek = grouped ? grouped.weeks.length > 1 : false;
    const arrow = (field: SortField) => sortField === field ? (sortAsc ? " ↑" : " ↓") : "";

    return (
        <FloatingPopover open={open} anchorRef={anchorRef} onClose={onClose} width={360} padded={false} dismissible={false}>
            {/* Portalled to body, but React events still bubble through the
                React tree — without this the row's onClick would fire. */}
            <div onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Time Entries</span>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
            </div>

            {/* Summary strip */}
            <div className="px-3 py-2 bg-slate-50/60 flex items-center gap-3 border-b border-slate-100">
                <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, backgroundColor: taskColor + "cc" }} />
                </div>
                <span className="text-xs font-semibold text-slate-600 whitespace-nowrap">
                    {actualHours > 0 ? actualHours.toFixed(1) : "0"}h
                    {estimatedHours != null && estimatedHours > 0 && <span className="text-slate-400 font-normal"> / {estimatedHours}h</span>}
                    <span className="ml-1.5 text-[10px] font-bold" style={{ color: taskColor }}>{progress}%</span>
                </span>
            </div>

            {/* Table */}
            <div className="max-h-64 overflow-y-auto">
                {/* Column headers */}
                <div className={`grid ${isDateSort ? "grid-cols-[1fr_52px_72px]" : "grid-cols-[72px_1fr_52px_72px]"} px-3 py-1.5 text-[9px] font-bold text-slate-400 uppercase tracking-wider bg-white border-b border-slate-100 sticky top-0 z-10`}>
                    {!isDateSort && <button onClick={() => toggleSort("date")} className="text-left hover:text-slate-600 transition">Date{arrow("date")}</button>}
                    {isDateSort && <button onClick={() => toggleSort("date")} className="text-left hover:text-slate-600 transition">Person</button>}
                    {!isDateSort && <button onClick={() => toggleSort("person")} className="text-left hover:text-slate-600 transition">Person{arrow("person")}</button>}
                    <button onClick={() => toggleSort("hours")} className="text-right hover:text-slate-600 transition">Hrs{arrow("hours")}</button>
                    <button onClick={() => toggleSort("costCode")} className="text-right hover:text-slate-600 transition">Code{arrow("costCode")}</button>
                </div>

                {/* Loading */}
                {loading && (
                    <div className="px-3 py-6 text-center">
                        <div className="inline-block w-4 h-4 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
                    </div>
                )}

                {/* Empty state */}
                {!loading && entries.length === 0 && (
                    <div className="px-3 py-6 text-center">
                        <svg className="mx-auto mb-2 text-slate-300" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                        <p className="text-xs text-slate-400">No time logged yet</p>
                        {estimatedHours == null && <p className="text-[10px] text-slate-300 mt-1">Set estimated hours to track progress</p>}
                    </div>
                )}

                {/* Grouped rows (date sort) */}
                {!loading && isDateSort && grouped && grouped.weeks.map((week, wi) => (
                    <div key={week.weekKey}>
                        {multiWeek && (
                            <div className="px-3 py-1 bg-indigo-50/50 flex items-center justify-between border-b border-indigo-100">
                                <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-wider">{week.label}</span>
                                <span className="text-[10px] font-bold text-indigo-500">{fmt(week.total)}h</span>
                            </div>
                        )}
                        {week.days.map(day => (
                            <div key={day.dateKey}>
                                <div className="px-3 py-1 bg-slate-50 flex items-center justify-between border-b border-slate-100">
                                    <span className="text-[10px] font-semibold text-slate-500">{day.label}</span>
                                    <span className="text-[10px] font-bold text-slate-500">{fmt(day.total)}h</span>
                                </div>
                                {day.entries.map(entry => (
                                    <div key={entry.id} className="grid grid-cols-[1fr_52px_72px] px-3 py-1 text-xs hover:bg-slate-50/50 transition border-b border-slate-50 last:border-0">
                                        <span className="text-slate-700 truncate pr-2" title={entry.user.name || entry.user.email}>{personName(entry.user)}</span>
                                        <span className="text-right text-slate-600 font-medium">{entry.durationHours != null ? entry.durationHours.toFixed(1) : "—"}</span>
                                        <span className="text-right text-slate-400 truncate" title={entry.costCode?.name}>{entry.costCode?.code ?? "—"}</span>
                                    </div>
                                ))}
                            </div>
                        ))}
                        {multiWeek && wi < grouped.weeks.length - 1 && <div className="h-px bg-slate-200" />}
                    </div>
                ))}

                {/* Flat rows (non-date sort) */}
                {!loading && !isDateSort && sorted.map(entry => (
                    <div key={entry.id} className="grid grid-cols-[72px_1fr_52px_72px] px-3 py-1.5 text-xs hover:bg-slate-50 transition border-b border-slate-50 last:border-0">
                        <span className="text-slate-500">{formatDate(entry.startTime)}</span>
                        <span className="text-slate-700 truncate pr-2" title={entry.user.name || entry.user.email}>{personName(entry.user)}</span>
                        <span className="text-right text-slate-600 font-medium">{entry.durationHours != null ? entry.durationHours.toFixed(1) : "—"}</span>
                        <span className="text-right text-slate-400 truncate" title={entry.costCode?.name}>{entry.costCode?.code ?? "—"}</span>
                    </div>
                ))}
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between">
                <span className="text-[10px] text-slate-400">
                    {total > 0 && (
                        <>
                            {total > 50 ? `50 of ${total}` : `${total} entr${total === 1 ? "y" : "ies"}`}
                            {grandTotal > 0 && <span className="ml-1.5 font-bold text-slate-600">· {fmt(grandTotal)}h total</span>}
                        </>
                    )}
                </span>
                <Link href={`/projects/${projectId}/time-expenses`} className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition">
                    View all →
                </Link>
            </div>
            </div>
        </FloatingPopover>
    );
}
