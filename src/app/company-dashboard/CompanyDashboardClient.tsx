"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CompanyDashboardData, DashboardProjectRow, ProjectCrewMember } from "@/lib/schedule-core";
import { PROJECT_STATUSES } from "@/lib/project-status";
import { generateProjectScheduleAction, updateProjectCrewAction, updateProjectStartDateAction } from "@/lib/actions";
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

function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    return parts.map(p => p[0]).join("").toUpperCase().slice(0, 2) || "?";
}

function statusColor(status: string): string {
    return PROJECT_STATUSES.find(s => s.value === status)?.color ?? "bg-slate-100 text-slate-700";
}

// Compact crew picker (checkbox popover) — the list is pre-filtered to
// ACTIVATED users server-side; every toggle replaces the crew idempotently.
function CrewPicker({
    projectId,
    crew,
    teamMembers,
}: {
    projectId: string;
    crew: ProjectCrewMember[];
    teamMembers: { id: string; name: string; email: string }[];
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [isPending, startTransition] = useTransition();

    // Selection mirrors the server crew unless the user just toggled (the
    // override keys on the crew contents, so refreshed props take back over).
    const crewKey = crew.map(c => c.id).sort().join(",");
    const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
    const selected = override && override.key === crewKey ? override.ids : crew.map(c => c.id);

    function toggle(userId: string) {
        const next = selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId];
        setOverride({ key: crewKey, ids: next });
        startTransition(async () => {
            try {
                await updateProjectCrewAction(projectId, next);
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Failed to update crew");
                setOverride(null);
            }
        });
    }

    // Option list: the ACTIVATED team list PLUS any currently-assigned member
    // who is no longer ACTIVATED — rendered as a removable "(inactive)" entry,
    // checked by default (they ARE assigned); unchecking them before saving
    // removes them (the core validates the FINAL set).
    const inactiveAssigned = crew.filter(c => !teamMembers.some(m => m.id === c.id));
    const options = [
        ...teamMembers.map(m => ({ id: m.id, label: m.name || m.email })),
        ...inactiveAssigned.map(c => ({ id: c.id, label: `${c.name} (inactive)` })),
    ];
    const selectedNames = options.filter(o => selected.includes(o.id));
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                disabled={isPending}
                className="hui-btn hui-btn-secondary text-xs px-2 py-1"
                title="Assign crew"
            >
                {selectedNames.length === 0 ? "Assign crew" : selectedNames.map(o => initials(o.label)).join(" ")}
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
                    <div className="absolute z-30 mt-1 w-56 bg-white border border-hui-border rounded-lg shadow-lg p-2 max-h-64 overflow-y-auto">
                        {options.length === 0 && <p className="text-xs text-hui-textMuted px-2 py-1">No active team members.</p>}
                        {options.map(o => (
                            <label key={o.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={selected.includes(o.id)}
                                    onChange={() => toggle(o.id)}
                                    className="accent-hui-primary"
                                />
                                <span className="text-sm text-hui-textMain">{o.label}</span>
                            </label>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

// "Generate schedule" button — Waiting/Scheduled rows with a qualifying
// estimate and zero tasks (the server resolves the most recent qualifying one).
function GenerateScheduleButton({ projectId }: { projectId: string }) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    function handle() {
        startTransition(async () => {
            try {
                const result = await generateProjectScheduleAction(projectId);
                toast.success(`Schedule generated from ${result.estimateCode} — ${result.created.length} task${result.created.length === 1 ? "" : "s"}, ${result.milestonesLinked} milestone${result.milestonesLinked === 1 ? "" : "s"} linked`);
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Schedule generation failed");
            }
        });
    }
    return (
        <button onClick={handle} disabled={isPending} className="hui-btn hui-btn-green text-xs px-2 py-1 whitespace-nowrap">
            {isPending ? "Generating..." : "Generate schedule"}
        </button>
    );
}

// Inline date setter for one waiting-to-start project (P1).
function StartDateRow({ project }: { project: DashboardProjectRow }) {
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

export default function CompanyDashboardClient({ data }: { data: CompanyDashboardData }) {
    const router = useRouter();
    const { month, canEdit, isAdmin, pipeline, calendar, cashflow, teamMembers, crewConflicts, overlays, strip } = data;

    // Overlay layer toggles (ADMIN only): income default on, others off.
    const [showIncome, setShowIncome] = useState(true);
    const [showExpenses, setShowExpenses] = useState(false);
    const [showHours, setShowHours] = useState(false);

    const anchor = parseUTCDate(`${month}-01`);
    const days = getMonthGrid(anchor);
    const today = todayUTC();
    const currentMonth = anchor.getUTCMonth();
    const monthLabel = `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;

    // Bucket calendar entries by UTC day key (YYYY-MM-DD) for O(1) cell lookup.
    const projectStartsByDay = new Map<string, typeof calendar.projectStarts>();
    for (const p of calendar.projectStarts) {
        const key = p.startDate.slice(0, 10);
        projectStartsByDay.set(key, [...(projectStartsByDay.get(key) ?? []), p]);
    }
    const leadStartsByDay = new Map<string, typeof calendar.leadStarts>();
    for (const l of calendar.leadStarts) {
        const key = l.expectedStartDate.slice(0, 10);
        leadStartsByDay.set(key, [...(leadStartsByDay.get(key) ?? []), l]);
    }

    // Crew per project (chips show up to 3 initials + overflow count).
    const crewByProject = new Map<string, ProjectCrewMember[]>();
    for (const row of [...pipeline.waitingToStart, ...pipeline.scheduled, ...pipeline.inProgress, ...pipeline.substantialCompletion]) {
        crewByProject.set(row.id, row.crew);
    }

    // Overlay per-day totals (income uses the shared effectiveDueDate rule).
    const incomeByDay = new Map<string, number>();
    for (const m of overlays?.income ?? []) {
        const key = m.effectiveDueDate.slice(0, 10);
        incomeByDay.set(key, (incomeByDay.get(key) ?? 0) + m.amount);
    }
    const expensesByDay = new Map<string, number>();
    for (const e of overlays?.expenses ?? []) {
        const key = e.date.slice(0, 10);
        expensesByDay.set(key, (expensesByDay.get(key) ?? 0) + e.amount);
    }
    const hoursByDay = new Map<string, number>();
    for (const h of overlays?.hours ?? []) {
        const key = h.startTime.slice(0, 10);
        hoursByDay.set(key, (hoursByDay.get(key) ?? 0) + h.durationHours);
    }

    const sumContract = (rows: { contractValue: number | null }[]) => rows.reduce((s, r) => s + (r.contractValue ?? 0), 0);
    const estimatingTotal = pipeline.estimating.reduce((s, l) => s + (l.targetRevenue ?? 0), 0);

    const crewRows = [...pipeline.waitingToStart, ...pipeline.scheduled, ...pipeline.inProgress];

    return (
        <div className="max-w-6xl mx-auto py-8 px-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Company Dashboard</h1>
                    <p className="text-sm text-hui-textMuted mt-1">The whole book of work — pipeline, project starts, crew, and cash outlook.</p>
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
                        {isAdmin && overlays && (
                            <div className="flex items-center gap-1 mr-3">
                                <button
                                    onClick={() => setShowIncome(v => !v)}
                                    className={`text-xs font-semibold px-2 py-1 rounded-full border transition ${showIncome ? "bg-green-100 text-green-700 border-green-300" : "bg-white text-hui-textMuted border-hui-border"}`}
                                >
                                    Income
                                </button>
                                <button
                                    onClick={() => setShowExpenses(v => !v)}
                                    className={`text-xs font-semibold px-2 py-1 rounded-full border transition ${showExpenses ? "bg-red-100 text-red-700 border-red-300" : "bg-white text-hui-textMuted border-hui-border"}`}
                                >
                                    Expenses
                                </button>
                                <button
                                    onClick={() => setShowHours(v => !v)}
                                    className={`text-xs font-semibold px-2 py-1 rounded-full border transition ${showHours ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-hui-textMuted border-hui-border"}`}
                                >
                                    Hours
                                </button>
                            </div>
                        )}
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
                        const incomeTotal = showIncome ? incomeByDay.get(dayKey) : undefined;
                        const expenseTotal = showExpenses ? expensesByDay.get(dayKey) : undefined;
                        const hoursTotal = showHours ? hoursByDay.get(dayKey) : undefined;
                        return (
                            <div
                                key={idx}
                                className={`border-r border-b border-hui-border p-1.5 min-h-[96px] ${isCurrentMonth ? (isWeekend(day) ? "bg-slate-50/60" : "bg-white") : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""}`}
                            >
                                <span className={`text-xs font-semibold ${isToday ? "inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white" : isCurrentMonth ? "text-hui-textMain" : "text-slate-400"}`}>
                                    {day.getUTCDate()}
                                </span>
                                <div className="mt-1 flex flex-col gap-0.5">
                                    {projectStarts.map(p => {
                                        const crew = crewByProject.get(p.id) ?? [];
                                        return (
                                            <Link
                                                key={p.id}
                                                href={`/projects/${p.id}`}
                                                title={`${p.name}${p.client ? ` — ${p.client}` : ""}${crew.length ? ` — crew: ${crew.map(c => c.name).join(", ")}` : ""}`}
                                                className="block text-[11px] px-1.5 py-0.5 rounded bg-hui-primary text-white hover:opacity-90 transition"
                                            >
                                                <span className="block truncate">{p.name}</span>
                                                {crew.length > 0 && (
                                                    <span className="block text-[9px] opacity-90">
                                                        {crew.slice(0, 3).map(c => initials(c.name)).join(" ")}{crew.length > 3 ? ` +${crew.length - 3}` : ""}
                                                    </span>
                                                )}
                                            </Link>
                                        );
                                    })}
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
                                    {incomeTotal != null && incomeTotal > 0 && (
                                        <span className="text-[10px] font-medium text-green-700 px-1.5" title="Income due this day (effective due date)">
                                            {formatCurrency(incomeTotal)} due
                                        </span>
                                    )}
                                    {expenseTotal != null && expenseTotal > 0 && (
                                        <span className="text-[10px] font-medium text-red-700 px-1.5" title="Expenses this day">
                                            −{formatCurrency(expenseTotal)}
                                        </span>
                                    )}
                                    {hoursTotal != null && hoursTotal > 0 && (
                                        <span className="text-[10px] font-medium text-blue-700 px-1.5" title="Hours logged this day">
                                            {hoursTotal.toFixed(1)}h
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Schedule & crew */}
            <div className="hui-card mb-6">
                <div className="px-4 py-3 border-b border-hui-border">
                    <h2 className="text-base font-semibold text-hui-textMain">Schedule &amp; crew</h2>
                    <p className="text-xs text-hui-textMuted mt-1">
                        Assign crew to jobs, or generate a job&apos;s schedule from its approved estimate (phases, tasks, and milestone dates).
                    </p>
                </div>
                {crewRows.length === 0 ? (
                    <p className="px-4 py-8 text-sm text-hui-textMuted text-center">No open projects.</p>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-hui-border bg-slate-50">
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</th>
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status</th>
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Crew</th>
                                <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Schedule</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {crewRows.map(p => {
                                const canGenerate =
                                    (p.status === "Waiting to Start") && p.hasQualifyingEstimate && p.taskCount === 0;
                                return (
                                    <tr key={p.id} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3">
                                            <Link href={`/projects/${p.id}`} className="text-sm font-medium text-hui-textMain hover:text-hui-primary">
                                                {p.name}
                                            </Link>
                                            <span className="block text-xs text-hui-textMuted">{p.client ?? "—"}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusColor(p.status)}`}>
                                                {p.status === "Waiting to Start" && p.startDate ? "Scheduled" : p.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            {canEdit && teamMembers ? (
                                                <CrewPicker projectId={p.id} crew={p.crew} teamMembers={teamMembers} />
                                            ) : (
                                                <span className="text-xs text-hui-textMuted">
                                                    {p.crew.length === 0 ? "—" : p.crew.map(c => initials(c.name)).join(" ")}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            {canEdit && canGenerate ? (
                                                <GenerateScheduleButton projectId={p.id} />
                                            ) : (
                                                <span className="text-xs text-hui-textMuted">
                                                    {p.taskCount > 0 ? `${p.taskCount} task${p.taskCount === 1 ? "" : "s"}` : "—"}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Waiting to start — ADMIN/MANAGER editor only (P1) */}
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

            {/* Crew conflicts — ADMIN/MANAGER (read-only) */}
            {canEdit && crewConflicts && (
                <div className="hui-card mb-6">
                    <div className="px-4 py-3 border-b border-hui-border">
                        <h2 className="text-base font-semibold text-hui-textMain">Crew conflicts</h2>
                    </div>
                    {crewConflicts.length === 0 ? (
                        <p className="px-4 py-8 text-sm text-hui-textMuted text-center">No crew conflicts this month.</p>
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {crewConflicts.map(c => (
                                <li key={c.userId} className="px-4 py-3">
                                    <p className="text-sm font-semibold text-hui-textMain">{c.name}</p>
                                    <ul className="mt-1 space-y-0.5">
                                        {c.pairs.map((pair, i) => (
                                            <li key={i} className="text-xs text-hui-textMuted">
                                                <Link href={`/projects/${pair.projectA.id}`} className="text-hui-primary hover:underline">{pair.projectA.name}</Link>
                                                {" × "}
                                                <Link href={`/projects/${pair.projectB.id}`} className="text-hui-primary hover:underline">{pair.projectB.name}</Link>
                                                {` — ${pair.overlapStart.slice(0, 10)} → ${pair.overlapEnd.slice(0, 10)}`}
                                            </li>
                                        ))}
                                    </ul>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Cashflow outlook — ADMIN only (never serialized for other roles) */}
            {cashflow && (
                <div className="hui-card mb-6">
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

            {/* Per-project month strip — ADMIN only */}
            {isAdmin && strip && (
                <div className="hui-card">
                    <div className="px-4 py-3 border-b border-hui-border">
                        <h2 className="text-base font-semibold text-hui-textMain">This month by project</h2>
                        <p className="text-xs text-hui-textMuted mt-1">Income due, received, expenses, burdened labor, and hours for {monthLabel}.</p>
                    </div>
                    {strip.length === 0 ? (
                        <p className="px-4 py-8 text-sm text-hui-textMuted text-center">No project activity this month.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-hui-border bg-slate-50">
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Income due</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Received</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Expenses</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Labor (actual, burdened)</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Hours</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Net</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {strip.map(r => (
                                        <tr key={r.projectId} className="hover:bg-slate-50 transition">
                                            <td className="px-4 py-3">
                                                <Link href={`/projects/${r.projectId}`} className="text-sm font-medium text-hui-textMain hover:text-hui-primary">
                                                    {r.projectName}
                                                </Link>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-right text-green-700">{formatCurrency(r.incomeDue)}</td>
                                            <td className="px-4 py-3 text-sm text-right text-hui-textMain">{formatCurrency(r.received)}</td>
                                            <td className="px-4 py-3 text-sm text-right text-red-700">{formatCurrency(r.expenses)}</td>
                                            <td className="px-4 py-3 text-sm text-right text-hui-textMain">{formatCurrency(r.laborBurdened)}</td>
                                            <td className="px-4 py-3 text-sm text-right text-hui-textMuted">{r.hoursActual.toFixed(1)} / {r.hoursEstimated.toFixed(1)}h</td>
                                            <td className={`px-4 py-3 text-sm text-right font-semibold ${r.net >= 0 ? "text-green-700" : "text-red-700"}`}>
                                                {formatCurrency(r.net)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
