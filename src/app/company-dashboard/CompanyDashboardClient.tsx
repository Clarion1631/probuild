"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CompanyDashboardData, DashboardProjectRow, DashboardTaskRow, PipelineCrewMember } from "@/lib/schedule-core";
import { PROJECT_STATUSES } from "@/lib/project-status";
import { applyChangeOrderToScheduleAction, generateProjectScheduleAction, updateProjectCrewAction, updateProjectStartDateAction, updateTaskCrewAction } from "@/lib/actions";
import { formatCurrency, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { ScheduleBoard } from "./schedule-board/ScheduleBoard";
import {
    mergeProjectPendingIds,
    projectIdSetsEqual,
    projectRefreshMatches,
    type ProjectRefreshExpectation,
} from "./schedule-board/useBarLayout";

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
    crew: PipelineCrewMember[];
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

    // Option list: the picker team list PLUS any currently-assigned member who
    // isn't in it — either because they're no longer ACTIVATED (removable
    // "(inactive)" entry) or because they're a FINANCE user excluded from the
    // picker (removable "(finance)" entry). Checked by default (they ARE
    // assigned); unchecking them before saving removes them (the core
    // validates only newly-ADDED members against ACTIVATED).
    const unlistedAssigned = crew.filter(c => !teamMembers.some(m => m.id === c.id));
    const options = [
        ...teamMembers.map(m => ({ id: m.id, label: m.name || m.email })),
        ...unlistedAssigned.map(c => ({ id: c.id, label: `${c.name} (${c.role === "FINANCE" ? "finance" : "inactive"})` })),
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

function ApplyChangeOrderButton({ changeOrderId, code }: { changeOrderId: string; code: string }) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    return (
        <button
            type="button"
            onClick={() => startTransition(async () => {
                try {
                    await applyChangeOrderToScheduleAction(changeOrderId);
                    toast.success(`${code} applied to the schedule`);
                    router.refresh();
                } catch (err: any) {
                    toast.error(err?.message || "Failed to apply change order");
                }
            })}
            disabled={isPending}
            className="hui-btn hui-btn-green text-xs px-2 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
        >
            {isPending ? `Applying ${code}...` : `Apply CO ${code}`}
        </button>
    );
}

function TaskCrewPicker({ task, teamMembers }: { task: DashboardTaskRow; teamMembers: { id: string; name: string; email: string }[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const assignedIds = task.assignments.map(a => a.userId);
    const assignmentKey = [...assignedIds].sort().join(",");
    const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
    const selected = override?.key === assignmentKey ? override.ids : assignedIds;
    const unlisted = task.assignments.filter(a => !teamMembers.some(m => m.id === a.userId));
    const options = [
        ...teamMembers.map(member => ({ id: member.id, label: member.name || member.email })),
        ...unlisted.map(a => ({ id: a.userId, label: `${a.name} (${a.role === "FINANCE" ? "finance" : "inactive"})` })),
    ];

    function toggle(userId: string) {
        const next = selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId];
        setOverride({ key: assignmentKey, ids: next });
        startTransition(async () => {
            try {
                await updateTaskCrewAction(task.id, next);
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Failed to update task crew");
                setOverride(null);
            }
        });
    }

    return (
        <div className="relative inline-block">
            <button type="button" onClick={() => setOpen(value => !value)} disabled={isPending} className="hui-btn hui-btn-secondary text-xs px-2 py-1" aria-expanded={open}>
                {selected.length === 0 ? "Assign task crew" : task.assignments.filter(a => selected.includes(a.userId)).map(a => initials(a.name)).join(" ") || `${selected.length} assigned`}
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
                    <div className="absolute right-0 z-30 mt-1 w-56 bg-white border border-hui-border rounded-lg shadow-lg p-2 max-h-64 overflow-y-auto">
                        {options.length === 0 && <p className="text-xs text-hui-textMuted px-2 py-1">No active team members.</p>}
                        {options.map(option => (
                            <label key={option.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
                                <input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(option.id)} className="accent-hui-primary" />
                                <span className="text-sm text-hui-textMain">{option.label}</span>
                            </label>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

interface LegacyProjectMutation {
    expectation: ProjectRefreshExpectation | null;
}

interface StartDateRowProps {
    project: DashboardProjectRow;
    isProjectPending: boolean;
    beginProjectMutation: (projectId: string) => boolean;
    awaitProjectRefresh: (projectId: string, expectation: ProjectRefreshExpectation) => void;
    clearProjectMutation: (projectId: string) => void;
}

// Inline date setter for one waiting-to-start project (P1).
function StartDateRow({
    project,
    isProjectPending,
    beginProjectMutation,
    awaitProjectRefresh,
    clearProjectMutation,
}: StartDateRowProps) {
    const router = useRouter();
    const [date, setDate] = useState("");
    const [isPending, startTransition] = useTransition();

    function handleSet() {
        if (!date) {
            toast.error("Pick a start date first");
            return;
        }
        if (!beginProjectMutation(project.id)) return;
        startTransition(async () => {
            try {
                const result = await updateProjectStartDateAction(project.id, date, true);
                awaitProjectRefresh(project.id, {
                    projectStartDate: result.startDate,
                    taskDates: result.shiftedTaskDates,
                });
                toast.success(
                    result.shiftedTasks > 0
                        ? `Start set — ${result.shiftedTasks} job task${result.shiftedTasks === 1 ? "" : "s"} shifted`
                        : "Start date set"
                );
                router.refresh();
            } catch (error) {
                clearProjectMutation(project.id);
                toast.error(error instanceof Error ? error.message : "Failed to set start date");
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
                        disabled={isPending || isProjectPending}
                    />
                    <button
                        onClick={handleSet}
                        disabled={isPending || isProjectPending}
                        className="hui-btn hui-btn-green text-sm whitespace-nowrap"
                    >
                        {isPending ? "Setting..." : isProjectPending ? "Refreshing..." : "Set"}
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function CompanyDashboardClient({ data }: { data: CompanyDashboardData }) {
    const router = useRouter();
    const { month, canEdit, isAdmin, canSeeFinancials, pipeline, cashflow, teamMembers, crewConflicts, strip } = data;

    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
    const pageMountedRef = useRef(true);
    const boardPendingProjectIdsRef = useRef<Set<string>>(new Set());
    const legacyProjectMutationsRef = useRef<Map<string, LegacyProjectMutation>>(new Map());
    const externalShiftNonceRef = useRef(0);
    const [externalShiftedTaskDates, setExternalShiftedTaskDates] = useState<{ nonce: number; taskDates: { id: string; startDate: string; endDate: string }[] } | null>(null);
    const [boardPendingProjectIds, setBoardPendingProjectIds] = useState<Set<string>>(() => new Set());
    const [legacyProjectMutations, setLegacyProjectMutations] = useState<Map<string, LegacyProjectMutation>>(() => new Map());
    const canonicalProjects = useMemo(() => [
        ...pipeline.waitingToStart,
        ...pipeline.scheduled,
        ...pipeline.inProgress,
        ...pipeline.substantialCompletion,
    ], [pipeline]);
    const canonicalProjectById = useMemo(() => new Map(canonicalProjects.map(project => [project.id, project])), [canonicalProjects]);
    const legacyPendingProjectIds = useMemo(() => new Set(legacyProjectMutations.keys()), [legacyProjectMutations]);
    const pagePendingProjectIds = useMemo(
        () => mergeProjectPendingIds(boardPendingProjectIds, legacyPendingProjectIds),
        [boardPendingProjectIds, legacyPendingProjectIds],
    );
    const legacyRefreshCount = useMemo(
        () => [...legacyProjectMutations.values()].filter(mutation => mutation.expectation !== null).length,
        [legacyProjectMutations],
    );

    const isPageProjectPending = useCallback((projectId: string) => (
        boardPendingProjectIdsRef.current.has(projectId)
        || legacyProjectMutationsRef.current.has(projectId)
    ), []);

    const publishBoardPendingProjectIds = useCallback((projectIds: ReadonlySet<string>) => {
        const next = new Set(projectIds);
        if (projectIdSetsEqual(boardPendingProjectIdsRef.current, next)) return;
        boardPendingProjectIdsRef.current = next;
        if (pageMountedRef.current) setBoardPendingProjectIds(next);
    }, []);

    const beginLegacyProjectMutation = useCallback((projectId: string) => {
        if (!pageMountedRef.current || isPageProjectPending(projectId)) return false;
        const next = new Map(legacyProjectMutationsRef.current);
        next.set(projectId, { expectation: null });
        legacyProjectMutationsRef.current = next;
        setLegacyProjectMutations(next);
        return true;
    }, [isPageProjectPending]);

    const awaitLegacyProjectRefresh = useCallback((projectId: string, expectation: ProjectRefreshExpectation) => {
        if (!pageMountedRef.current || !legacyProjectMutationsRef.current.has(projectId)) return;
        const next = new Map(legacyProjectMutationsRef.current);
        next.set(projectId, { expectation });
        legacyProjectMutationsRef.current = next;
        setLegacyProjectMutations(next);
        // Publish the persisted shift to the board: a saved-awaiting task the
        // board is tracking may have just been moved by this legacy shift, and
        // its pinned override must follow the persisted dates to reconcile.
        if (expectation.taskDates.length > 0) {
            externalShiftNonceRef.current += 1;
            setExternalShiftedTaskDates({ nonce: externalShiftNonceRef.current, taskDates: expectation.taskDates });
        }
    }, []);

    const clearLegacyProjectMutation = useCallback((projectId: string) => {
        if (!legacyProjectMutationsRef.current.has(projectId)) return;
        const next = new Map(legacyProjectMutationsRef.current);
        next.delete(projectId);
        legacyProjectMutationsRef.current = next;
        if (pageMountedRef.current) setLegacyProjectMutations(next);
    }, []);

    const reconciledLegacyProjectIds = useMemo(() => [...legacyProjectMutations].flatMap(([projectId, mutation]) => {
        if (!mutation.expectation) return [];
        if (!canonicalProjectById.has(projectId)) return [projectId];
        return projectRefreshMatches(canonicalProjectById.get(projectId), mutation.expectation) ? [projectId] : [];
    }), [canonicalProjectById, legacyProjectMutations]);

    useEffect(() => {
        if (reconciledLegacyProjectIds.length === 0) return;
        const timeoutId = window.setTimeout(() => {
            for (const projectId of reconciledLegacyProjectIds) clearLegacyProjectMutation(projectId);
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [clearLegacyProjectMutation, reconciledLegacyProjectIds]);

    useEffect(() => {
        if (legacyRefreshCount === 0) return;
        const intervalId = window.setInterval(() => router.refresh(), 2_000);
        return () => window.clearInterval(intervalId);
    }, [legacyRefreshCount, router]);

    useEffect(() => {
        pageMountedRef.current = true;
        return () => {
            pageMountedRef.current = false;
            boardPendingProjectIdsRef.current = new Set();
            legacyProjectMutationsRef.current = new Map();
        };
    }, []);
    const anchor = parseUTCDate(`${month}-01`);
    const monthLabel = `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;

    const sumContract = (rows: { contractValue: number | null }[]) => rows.reduce((s, r) => s + (r.contractValue ?? 0), 0);
    const estimatingTotal = pipeline.estimating.reduce((s, l) => s + (l.targetRevenue ?? 0), 0);

    const crewRows = [...pipeline.waitingToStart, ...pipeline.scheduled, ...pipeline.inProgress, ...pipeline.substantialCompletion];

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
                <StatCard label="Estimating" value={String(pipeline.estimating.length)} sub={canSeeFinancials ? `${formatCurrency(estimatingTotal)} pipeline` : undefined} />
                <StatCard label="Waiting to Start" value={String(pipeline.waitingToStart.length)} sub={canSeeFinancials ? `${formatCurrency(sumContract(pipeline.waitingToStart))} contracted` : undefined} />
                <StatCard label="Scheduled" value={String(pipeline.scheduled.length)} sub={canSeeFinancials ? `${formatCurrency(sumContract(pipeline.scheduled))} contracted` : undefined} />
                <StatCard label="In Progress" value={String(pipeline.inProgress.length)} sub={canSeeFinancials ? `${formatCurrency(sumContract(pipeline.inProgress))} contracted` : undefined} />
            </div>

            <ScheduleBoard
                data={data}
                externallyPendingProjectIds={legacyPendingProjectIds}
                isProjectExternallyPending={isPageProjectPending}
                onEffectivePendingProjectIdsChange={publishBoardPendingProjectIds}
                externalShiftedTaskDates={externalShiftedTaskDates}
            />

            {legacyRefreshCount > 0 && (
                <div role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    Refreshing start-date changes...{" "}
                    <button type="button" className="font-semibold underline" onClick={() => router.refresh()}>Retry now</button>
                </div>
            )}

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
                                const expanded = expandedProjects.has(p.id);
                                return (
                                    <Fragment key={p.id}>
                                        <tr className="group hover:bg-slate-50 transition">
                                            <td className="px-4 py-3">
                                                <div className="flex items-start gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => setExpandedProjects(current => {
                                                            const next = new Set(current);
                                                            next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                                                            return next;
                                                        })}
                                                        disabled={p.taskCount === 0}
                                                        aria-expanded={expanded}
                                                        aria-controls={`project-tasks-${p.id}`}
                                                        className="mt-0.5 w-6 h-6 rounded text-hui-textMuted hover:bg-slate-200 disabled:opacity-30"
                                                        title={p.taskCount === 0 ? "No tasks" : expanded ? "Collapse tasks" : "Expand tasks"}
                                                    >
                                                        {expanded ? "−" : "+"}
                                                    </button>
                                                    <div>
                                                        <Link href={`/projects/${p.id}`} className="text-sm font-medium text-hui-textMain hover:text-hui-primary">
                                                            {p.name}
                                                        </Link>
                                                        <span className="block text-xs text-hui-textMuted">{p.client ?? "—"}</span>
                                                    </div>
                                                </div>
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
                                                <div className="flex flex-wrap items-center gap-2">
                                                    {canEdit && canGenerate ? (
                                                        <GenerateScheduleButton projectId={p.id} />
                                                    ) : (
                                                        <span className="text-xs text-hui-textMuted">
                                                            {p.taskCount > 0 ? `${p.taskCount} task${p.taskCount === 1 ? "" : "s"}` : "—"}
                                                        </span>
                                                    )}
                                                    {canEdit && p.status === "In Progress" && p.unappliedChangeOrders.items.map(co => (
                                                        <ApplyChangeOrderButton key={co.id} changeOrderId={co.id} code={co.code} />
                                                    ))}
                                                </div>
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr id={`project-tasks-${p.id}`}>
                                                <td colSpan={4} className="bg-slate-50/70 px-8 py-3">
                                                    <div className="space-y-2">
                                                        {p.tasks.map(task => (
                                                            <div key={task.id} className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border border-hui-border bg-white px-3 py-2">
                                                                <div className="min-w-0">
                                                                    <p className="truncate text-sm font-medium text-hui-textMain">{task.name}</p>
                                                                    <p className="text-xs text-hui-textMuted">
                                                                        {task.type === "milestone" ? "Milestone" : task.status} · {task.startDate.slice(0, 10)} → {task.endDate.slice(0, 10)}
                                                                    </p>
                                                                </div>
                                                                <div className="text-xs text-hui-textMuted">
                                                                    {task.assignments.length === 0
                                                                        ? "No task crew"
                                                                        : task.assignments.map(a => `${a.name}${a.role === "FINANCE" ? " (finance)" : a.status === "ACTIVATED" ? "" : " (inactive)"}`).join(", ")}
                                                                </div>
                                                                {canEdit && teamMembers && <TaskCrewPicker task={task} teamMembers={teamMembers} />}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
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
                                    <StartDateRow
                                        key={p.id}
                                        project={p}
                                        isProjectPending={pagePendingProjectIds.has(p.id)}
                                        beginProjectMutation={beginLegacyProjectMutation}
                                        awaitProjectRefresh={awaitLegacyProjectRefresh}
                                        clearProjectMutation={clearLegacyProjectMutation}
                                    />
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
                                                {(pair.taskA || pair.taskB) && (
                                                    <span className="block pl-3 text-[11px] text-slate-500">
                                                        {[pair.taskA, pair.taskB].filter(Boolean).map(task => `${task!.name} (${task!.startDate.slice(0, 10)} → ${task!.endDate.slice(0, 10)})`).join(" × ")}
                                                    </span>
                                                )}
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
                        <p className="text-xs text-hui-textMuted mt-1">Billed income due, projected unbilled CO income, received, expenses, burdened labor, and hours for {monthLabel}.</p>
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
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Projected CO</th>
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
                                            <td className="px-4 py-3 text-sm text-right text-amber-700">{formatCurrency(r.coProjected)}</td>
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
