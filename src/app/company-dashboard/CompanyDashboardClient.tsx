"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CashflowOutlook, CompanyPipeline, StartCalendar } from "@/lib/schedule-core";
import { updateProjectStartDateAction } from "@/lib/actions";
import {
    formatCurrency,
    formatDate,
    getMonthGrid,
    isSameUTCDay,
    isWeekend,
    parseUTCDate,
    todayUTC,
} from "@/app/projects/[id]/schedule/schedule-utils";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="hui-card p-5">
            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold text-hui-textMain mt-1">{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}

function shiftMonth(month: string, delta: number): string {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Inline date setter for one waiting-to-start project. Setting a date moves
// the project into "Scheduled" on the funnel; the server action revalidates
// and we refresh to pull the new grid.
function StartDateRow({ project }: { project: CompanyPipeline["waitingToStart"][number] }) {
    const router = useRouter();
    const [date, setDate] = useState("");
    const [isPending, startTransition] = useTransition();

    function handleSet() {
        if (!date) {
            toast.error("Pick a start date first");
            return;
        }
        startTransition(async () => {
            try {
                const result = await updateProjectStartDateAction(project.id, date, true);
                toast.success(
                    result.shiftedTasks > 0
                        ? `Start set — ${result.shiftedTasks} job task${result.shiftedTasks === 1 ? "" : "s"} shifted`
                        : "Start date set"
                );
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Failed to set start date");
            }
        });
    }

    return (
        <tr className="hover:bg-slate-50 transition">
            <td className="px-4 py-3">
                <Link href={`/projects/${project.id}`} className="text-sm font-medium text-hui-textMain hover:text-hui-primary">
                    {project.name}
                </Link>
            </td>
            <td className="px-4 py-3 text-sm text-hui-textMuted">{project.client ?? "—"}</td>
            <td className="px-4 py-3 text-sm text-hui-textMain">
                {project.contractValue != null ? formatCurrency(project.contractValue) : "—"}
            </td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                    <input
                        type="date"
                        value={date}
                        onChange={e => setDate(e.target.value)}
                        className="hui-input text-sm"
                        disabled={isPending}
                    />
                    <button
                        onClick={handleSet}
                        disabled={isPending}
                        className="hui-btn hui-btn-green text-sm whitespace-nowrap"
                    >
                        {isPending ? "Setting..." : "Set"}
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function CompanyDashboardClient({
    pipeline,
    calendar,
    cashflow,
    month,
    canEdit,
}: {
    pipeline: CompanyPipeline;
    calendar: StartCalendar;
    cashflow: CashflowOutlook | null;
    month: string;
    canEdit: boolean;
}) {
    const router = useRouter();
    const anchor = parseUTCDate(`${month}-01`);
    const days = getMonthGrid(anchor);
    const today = todayUTC();
    const currentMonth = anchor.getUTCMonth();
    const monthLabel = `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;

    // Bucket calendar entries by UTC day key (YYYY-MM-DD) for O(1) cell lookup.
    const projectStartsByDay = new Map<string, StartCalendar["projectStarts"]>();
    for (const p of calendar.projectStarts) {
        const key = p.startDate.slice(0, 10);
        projectStartsByDay.set(key, [...(projectStartsByDay.get(key) ?? []), p]);
    }
    const leadStartsByDay = new Map<string, StartCalendar["leadStarts"]>();
    for (const l of calendar.leadStarts) {
        const key = l.expectedStartDate.slice(0, 10);
        leadStartsByDay.set(key, [...(leadStartsByDay.get(key) ?? []), l]);
    }
    // Per-day milestone totals are only present for ADMIN (server omits the
    // data entirely otherwise).
    const milestoneTotalsByDay = new Map<string, number>();
    for (const m of calendar.milestones ?? []) {
        const key = m.dueDate.slice(0, 10);
        milestoneTotalsByDay.set(key, (milestoneTotalsByDay.get(key) ?? 0) + m.amount);
    }

    const sumContract = (rows: CompanyPipeline["waitingToStart"]) =>
        rows.reduce((s, r) => s + (r.contractValue ?? 0), 0);
    const estimatingTotal = pipeline.estimating.reduce((s, l) => s + (l.targetRevenue ?? 0), 0);

    return (
        <div className="max-w-6xl mx-auto py-8 px-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Company Dashboard</h1>
                    <p className="text-sm text-hui-textMuted mt-1">The whole book of work — pipeline, project starts, and cash outlook.</p>
                </div>
            </div>

            {/* Funnel */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <StatCard label="Estimating" value={String(pipeline.estimating.length)} sub={`${formatCurrency(estimatingTotal)} pipeline`} />
                <StatCard label="Waiting to Start" value={String(pipeline.waitingToStart.length)} sub={`${formatCurrency(sumContract(pipeline.waitingToStart))} contracted`} />
                <StatCard label="Scheduled" value={String(pipeline.scheduled.length)} sub={`${formatCurrency(sumContract(pipeline.scheduled))} contracted`} />
                <StatCard label="In Progress" value={String(pipeline.inProgress.length)} sub={`${formatCurrency(sumContract(pipeline.inProgress))} contracted`} />
            </div>

            {/* Start calendar */}
            <div className="hui-card mb-6 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-hui-border">
                    <h2 className="text-base font-semibold text-hui-textMain">Project Starts — {monthLabel}</h2>
                    <div className="flex items-center gap-2">
                        <button onClick={() => router.push(`?month=${shiftMonth(month, -1)}`)} className="hui-btn hui-btn-secondary text-sm">← Prev</button>
                        <button onClick={() => router.push("?")} className="hui-btn hui-btn-secondary text-sm">Today</button>
                        <button onClick={() => router.push(`?month=${shiftMonth(month, 1)}`)} className="hui-btn hui-btn-secondary text-sm">Next →</button>
                    </div>
                </div>
                <div className="grid grid-cols-7 bg-white border-b border-hui-border">
                    {WEEKDAY_LABELS.map(w => (
                        <div key={w} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{w}</div>
                    ))}
                </div>
                <div className="grid grid-cols-7 grid-rows-6">
                    {days.map((day, idx) => {
                        const dayKey = formatDate(day);
                        const isToday = isSameUTCDay(day, today);
                        const isCurrentMonth = day.getUTCMonth() === currentMonth;
                        const projectStarts = projectStartsByDay.get(dayKey) ?? [];
                        const leadStarts = leadStartsByDay.get(dayKey) ?? [];
                        const milestoneTotal = milestoneTotalsByDay.get(dayKey);
                        return (
                            <div
                                key={idx}
                                className={`border-r border-b border-hui-border p-1.5 min-h-[96px] ${isCurrentMonth ? (isWeekend(day) ? "bg-slate-50/60" : "bg-white") : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""}`}
                            >
                                <span className={`text-xs font-semibold ${isToday ? "inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white" : isCurrentMonth ? "text-hui-textMain" : "text-slate-400"}`}>
                                    {day.getUTCDate()}
                                </span>
                                <div className="mt-1 flex flex-col gap-0.5">
                                    {projectStarts.map(p => (
                                        <Link
                                            key={p.id}
                                            href={`/projects/${p.id}`}
                                            title={`${p.name}${p.client ? ` — ${p.client}` : ""}`}
                                            className="block text-[11px] px-1.5 py-0.5 rounded truncate bg-hui-primary text-white hover:opacity-90 transition"
                                        >
                                            {p.name}
                                        </Link>
                                    ))}
                                    {leadStarts.map(l => (
                                        <Link
                                            key={l.id}
                                            href={`/leads/${l.id}`}
                                            title={`${l.name}${l.client ? ` — ${l.client}` : ""} (lead)`}
                                            className="block text-[11px] px-1.5 py-0.5 rounded truncate border border-dashed border-hui-primary text-hui-primary hover:bg-green-50 transition"
                                        >
                                            {l.name}
                                        </Link>
                                    ))}
                                    {milestoneTotal != null && milestoneTotal > 0 && (
                                        <span className="text-[10px] font-medium text-amber-700 px-1.5" title="Milestones due this day">
                                            {formatCurrency(milestoneTotal)} due
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Waiting to start — ADMIN/MANAGER editor only */}
            {canEdit && (
                <div className="hui-card mb-6">
                    <div className="px-4 py-3 border-b border-hui-border">
                        <h2 className="text-base font-semibold text-hui-textMain">Waiting to start</h2>
                        <p className="text-xs text-hui-textMuted mt-1">
                            Set a project start date to move it onto the calendar. Moving a start date also shifts the job&apos;s
                            tasks and any linked milestones (milestones already pushed to QuickBooks are skipped and reported).
                        </p>
                    </div>
                    {pipeline.waitingToStart.length === 0 ? (
                        <p className="px-4 py-8 text-sm text-hui-textMuted text-center">No projects waiting to start.</p>
                    ) : (
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Client</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Contract Value</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Start Date</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {pipeline.waitingToStart.map(p => (
                                    <StartDateRow key={p.id} project={p} />
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* Cashflow outlook — ADMIN only (never serialized for other roles) */}
            {cashflow && (
                <div className="hui-card">
                    <div className="px-4 py-3 border-b border-hui-border">
                        <h2 className="text-base font-semibold text-hui-textMain">Cash expected</h2>
                        <p className="text-xs text-hui-textMuted mt-1">
                            Pending milestones by due date. {cashflow.noDueDateCount > 0 && `${cashflow.noDueDateCount} pending milestone${cashflow.noDueDateCount === 1 ? "" : "s"} with no due date (not shown below).`}
                        </p>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
                        <div>
                            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Overdue</p>
                            <p className="text-lg font-bold text-red-600 mt-1">{formatCurrency(cashflow.overdue.total)}</p>
                            <p className="text-xs text-hui-textMuted">{cashflow.overdue.count} milestone{cashflow.overdue.count === 1 ? "" : "s"}</p>
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">0–30 days</p>
                            <p className="text-lg font-bold text-hui-textMain mt-1">{formatCurrency(cashflow.days0to30.total)}</p>
                            <p className="text-xs text-hui-textMuted">{cashflow.days0to30.count} milestone{cashflow.days0to30.count === 1 ? "" : "s"}</p>
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">31–60 days</p>
                            <p className="text-lg font-bold text-hui-textMain mt-1">{formatCurrency(cashflow.days31to60.total)}</p>
                            <p className="text-xs text-hui-textMuted">{cashflow.days31to60.count} milestone{cashflow.days31to60.count === 1 ? "" : "s"}</p>
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">61–90 days</p>
                            <p className="text-lg font-bold text-hui-textMain mt-1">{formatCurrency(cashflow.days61to90.total)}</p>
                            <p className="text-xs text-hui-textMuted">{cashflow.days61to90.count} milestone{cashflow.days61to90.count === 1 ? "" : "s"}</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
