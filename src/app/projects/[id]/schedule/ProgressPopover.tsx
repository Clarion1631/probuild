"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { getTaskTimeEntries } from "@/lib/actions";
import type { TimeEntryDetail } from "./schedule-types";

type SortField = "date" | "person" | "hours" | "costCode";

export type ProgressPopoverProps = {
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

function personName(user: { name: string | null; email: string }): string {
    if (user.name) return user.name;
    return user.email.split("@")[0];
}

export default function ProgressPopover({ taskId, taskColor, progress, estimatedHours, actualHours, projectId, onClose }: ProgressPopoverProps) {
    const containerRef = useRef<HTMLDivElement>(null);
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

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
        }
        function handleEsc(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEsc);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEsc);
        };
    }, [onClose]);

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

    const arrow = (field: SortField) => sortField === field ? (sortAsc ? " ↑" : " ↓") : "";

    return (
        <div ref={containerRef} className="absolute right-0 top-full mt-1 bg-white border border-hui-border rounded-lg shadow-xl z-50 w-[360px] animate-in fade-in" onClick={e => e.stopPropagation()}>
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
            <div className="max-h-52 overflow-y-auto">
                {/* Column headers */}
                <div className="grid grid-cols-[72px_1fr_52px_72px] px-3 py-1.5 text-[9px] font-bold text-slate-400 uppercase tracking-wider bg-white border-b border-slate-100 sticky top-0">
                    <button onClick={() => toggleSort("date")} className="text-left hover:text-slate-600 transition">Date{arrow("date")}</button>
                    <button onClick={() => toggleSort("person")} className="text-left hover:text-slate-600 transition">Person{arrow("person")}</button>
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

                {/* Rows */}
                {!loading && sorted.map(entry => (
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
                    {total > 0 && (total > 50 ? `Showing 50 of ${total}` : `${total} entr${total === 1 ? "y" : "ies"}`)}
                </span>
                <Link href={`/projects/${projectId}/time-expenses`} className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition">
                    View all →
                </Link>
            </div>
        </div>
    );
}
