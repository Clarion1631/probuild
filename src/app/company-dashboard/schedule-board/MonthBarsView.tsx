"use client";

import { useEffect, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type {
    CalendarOverlays,
    CompanyDashboardData,
    DashboardProjectRow,
    OverlayChangeOrderItem,
    OverlayIncomeItem,
} from "@/lib/schedule-core";
import {
    addDays,
    formatCurrency,
    formatDate,
    getFallbackProjectColor,
    getMonthGrid,
    isSameUTCDay,
    isWeekend,
    parseUTCDate,
    todayUTC,
} from "@/app/projects/[id]/schedule/schedule-utils";
import { FloatingPopover } from "./FloatingPopover";
import { activateExclusiveMenu, deactivateExclusiveMenu } from "./menuCoordinator";
import { ProjectBar, ProjectBarGridStartContext, type ProjectEditCallbacks } from "./ProjectBar";
import { TaskBlockSegment, type ActiveTaskKeyboardEdit, type TaskEditCallbacks } from "./TaskBlockSegment";
import { MilestoneMarker } from "./MilestoneMarker";
import { PROJECT_DRAG_MIME } from "./UnscheduledTray";
import { assignMonthProjectLanes, getEffectiveProjectRange, segmentProjectRange } from "./useBarLayout";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EMPTY_INCOME: OverlayIncomeItem[] = [];
const EMPTY_CHANGE_ORDERS: OverlayChangeOrderItem[] = [];

interface MonthBarsViewProps extends TaskEditCallbacks, ProjectEditCallbacks {
    data: CompanyDashboardData;
    showIncome: boolean;
    showProjectedCo: boolean;
    showExpenses: boolean;
    showHours: boolean;
    pendingProjectIds: ReadonlySet<string>;
    pendingTaskIds: ReadonlySet<string>;
    // Drafted (unsaved) items — still fully interactive, rendered with a
    // dashed/desaturated treatment. isSaving locks every project/task board-
    // wide while a Save is committing.
    draftProjectIds: ReadonlySet<string>;
    draftTaskIds: ReadonlySet<string>;
    isSaving: boolean;
    activeTaskKeyboardEdit: ActiveTaskKeyboardEdit | null;
    onTrayProjectDrop: (_project: DashboardProjectRow, _targetStart: string) => void;
    // team/crew list for the context-menu "Project crew…"/"Task crew…"
    // pickers (item 1) — reuses the exact CrewPicker/TaskCrewPicker the
    // Schedule & crew table uses.
    teamMembers: { id: string; name: string; email: string }[];
    // Suppresses every task hover card while ANY schedule-board drag is
    // active (item 3).
    isAnyDragActive: boolean;
}

// window: badges only reflect conflicts intersecting the visible grid — the
// merged conflict list also carries availability-window pairs that may be
// months away from the viewed grid.
function projectConflictNames(projectId: string, conflicts: CompanyDashboardData["crewConflicts"], window: { start: Date; end: Date }): string[] {
    if (!conflicts) return [];
    return [...new Set(conflicts.flatMap(conflict =>
        conflict.pairs.some(pair =>
            (pair.projectA.id === projectId || pair.projectB.id === projectId)
            && new Date(pair.overlapStart) < window.end
            && new Date(pair.overlapEnd) > window.start,
        )
            ? [conflict.name]
            : [],
    ))];
}

function hasProjectDragPayload(event: DragEvent<HTMLDivElement>): boolean {
    return event.dataTransfer.types.includes(PROJECT_DRAG_MIME);
}

function buildDayTotals(overlays: CalendarOverlays | null) {
    if (!overlays) return null;
    const income = new Map<string, number>();
    const projectedCo = new Map<string, number>();
    const expenses = new Map<string, number>();
    const hours = new Map<string, number>();
    for (const item of overlays.income) {
        const key = item.effectiveDueDate.slice(0, 10);
        income.set(key, (income.get(key) ?? 0) + item.amount);
    }
    for (const item of overlays.changeOrders) {
        const key = item.effectiveDueDate.slice(0, 10);
        projectedCo.set(key, (projectedCo.get(key) ?? 0) + item.amount);
    }
    for (const item of overlays.expenses) {
        const key = item.date.slice(0, 10);
        expenses.set(key, (expenses.get(key) ?? 0) + item.amount);
    }
    for (const item of overlays.hours) {
        const key = item.startTime.slice(0, 10);
        hours.set(key, (hours.get(key) ?? 0) + item.durationHours);
    }
    return { income, projectedCo, expenses, hours };
}

export function MonthBarsView({
    data,
    showIncome,
    showProjectedCo,
    showExpenses,
    showHours,
    pendingProjectIds,
    pendingTaskIds,
    draftProjectIds,
    draftTaskIds,
    isSaving,
    activeTaskKeyboardEdit,
    onTrayProjectDrop,
    teamMembers,
    isAnyDragActive,
    onProjectMoveCommit,
    activeProjectKeyboardId,
    onProjectPointerEditStart,
    onProjectKeyboardStart,
    onProjectKeyboardAdjust,
    onProjectKeyboardCommit,
    onProjectKeyboardCancel,
    onProjectEndResizeStart,
    onTaskPointerEditStart,
    onTaskKeyboardStart,
    onTaskKeyboardAdjust,
    onTaskKeyboardCommit,
    onTaskKeyboardCancel,
    onTaskDatesCommit,
    onTaskMoveBy,
}: MonthBarsViewProps) {
    const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(() => new Set());
    const [dragOverDate, setDragOverDate] = useState<string | null>(null);
    // Empty-day-cell "Schedule here…" context menu (item 1) — one instance
    // for the whole view, point-anchored to the right-click location.
    const [dayContextMenu, setDayContextMenu] = useState<{ date: string; point: { x: number; y: number } } | null>(null);
    useEffect(() => {
        if (!dayContextMenu) return;
        const close = () => setDayContextMenu(null);
        activateExclusiveMenu(close);
        return () => deactivateExclusiveMenu(close);
    }, [dayContextMenu]);
    function handleDayContextMenu(dayKey: string, event: ReactMouseEvent<HTMLDivElement>) {
        if (!data.canEdit) return; // read-only roles get the browser's default menu
        event.preventDefault();
        setDayContextMenu({ date: dayKey, point: { x: event.clientX, y: event.clientY } });
    }
    const anchor = parseUTCDate(`${data.month}-01`);
    const days = getMonthGrid(anchor);
    const gridStart = days[0];
    const gridEnd = addDays(gridStart, 42);
    const today = todayUTC();
    const currentMonth = anchor.getUTCMonth();
    const projects: DashboardProjectRow[] = [
        ...data.pipeline.waitingToStart,
        ...data.pipeline.scheduled,
        ...data.pipeline.inProgress,
        ...data.pipeline.substantialCompletion,
    ];

    const workSegmentsByProject = new Map<string, ReturnType<typeof segmentProjectRange>>();
    for (const project of projects) {
        const range = getEffectiveProjectRange(project);
        workSegmentsByProject.set(project.id, range ? segmentProjectRange(project.id, range, gridStart, gridEnd) : []);
    }

    const projectById = new Map(projects.map(project => [project.id, project]));
    const adminOverlays = data.isAdmin ? data.overlays : null;
    const visibleIncomeMilestones = adminOverlays
        ? showIncome ? adminOverlays.income : EMPTY_INCOME
        : EMPTY_INCOME;
    const visibleChangeOrderMilestones = adminOverlays
        ? showProjectedCo ? adminOverlays.changeOrders : EMPTY_CHANGE_ORDERS
        : EMPTY_CHANGE_ORDERS;
    const milestoneMaps = adminOverlays ? {
        income: new Map(projects.map(project => [project.id, visibleIncomeMilestones.filter(item => item.projectId === project.id)])),
        changeOrders: new Map(projects.map(project => [project.id, visibleChangeOrderMilestones.filter(item => item.projectId === project.id)])),
    } : null;
    const milestoneRowsByProjectDate = adminOverlays ? new Map<string, Array<{
        key: string;
        name: string;
        amount: number;
        effectiveDueDate: string;
        kind: "income" | "change-order";
    }>>() : null;
    if (milestoneRowsByProjectDate) {
        for (const item of visibleIncomeMilestones) {
            if (!item.projectId || !projectById.has(item.projectId)) continue;
            const key = `${item.projectId}|${item.effectiveDueDate.slice(0, 10)}`;
            milestoneRowsByProjectDate.set(key, [...(milestoneRowsByProjectDate.get(key) ?? []), {
                key: `income-${item.id}`,
                name: item.name,
                amount: item.amount,
                effectiveDueDate: item.effectiveDueDate,
                kind: "income",
            }]);
        }
        for (const item of visibleChangeOrderMilestones) {
            if (!item.projectId || !projectById.has(item.projectId)) continue;
            const key = `${item.projectId}|${item.effectiveDueDate.slice(0, 10)}`;
            milestoneRowsByProjectDate.set(key, [...(milestoneRowsByProjectDate.get(key) ?? []), {
                key: `co-${item.paymentScheduleId}`,
                name: item.name,
                amount: item.amount,
                effectiveDueDate: item.effectiveDueDate,
                kind: "change-order",
            }]);
        }
    }
    const milestoneDaysByProject = new Map<string, Date[]>();
    if (milestoneRowsByProjectDate) {
        for (const key of milestoneRowsByProjectDate.keys()) {
            const [projectId, dateKey] = key.split("|");
            milestoneDaysByProject.set(projectId, [...(milestoneDaysByProject.get(projectId) ?? []), parseUTCDate(dateKey)]);
        }
    }
    for (const project of projects) {
        const taskMilestoneDays = project.tasks
            .filter(task => task.type === "milestone")
            .map(task => parseUTCDate(task.startDate.slice(0, 10)));
        milestoneDaysByProject.set(project.id, [...(milestoneDaysByProject.get(project.id) ?? []), ...taskMilestoneDays]);
    }
    const layout = assignMonthProjectLanes(workSegmentsByProject, milestoneDaysByProject, gridStart, gridEnd);
    const dayTotals = buildDayTotals(adminOverlays);

    function handleDayDragOver(dayKey: string, event: DragEvent<HTMLDivElement>) {
        if (!data.canEdit || !hasProjectDragPayload(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOverDate(dayKey);
    }

    function handleDayDragLeave(dayKey: string, event: DragEvent<HTMLDivElement>) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDragOverDate(current => current === dayKey ? null : current);
    }

    function handleDayDrop(dayKey: string, event: DragEvent<HTMLDivElement>) {
        if (!data.canEdit || !hasProjectDragPayload(event)) return;
        event.preventDefault();
        setDragOverDate(null);
        const projectId = event.dataTransfer.getData(PROJECT_DRAG_MIME);
        const project = data.pipeline.waitingToStart.find(candidate => candidate.id === projectId);
        if (project) onTrayProjectDrop(project, dayKey);
    }

    return (
        <ProjectBarGridStartContext.Provider value={gridStart}>
            <div className="overflow-x-auto">
                <div className="min-w-[760px]">
                    <div className="grid grid-cols-7 border-b border-hui-border bg-white">
                    {WEEKDAY_LABELS.map(label => (
                        <div key={label} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
                    ))}
                </div>
                    <div>
                    {Array.from({ length: 6 }, (_, weekIndex) => {
                        const weekDays = days.slice(weekIndex * 7, weekIndex * 7 + 7);
                        const visibleSegments = layout.visibleWork.filter(segment => segment.weekIndex === weekIndex);
                        const visibleMilestoneHosts = layout.visibleMilestoneHosts.filter(host => host.weekIndex === weekIndex);
                        const hiddenProjectIds = layout.hiddenProjectIdsByWeek.get(weekIndex) ?? [];
                        const hiddenProjects = hiddenProjectIds
                            .map(projectId => projectById.get(projectId))
                            .filter((project): project is DashboardProjectRow => Boolean(project));
                        const hiddenCount = hiddenProjects.length;
                        const expanded = expandedWeeks.has(weekIndex);

                        return (
                            <div key={weekIndex} className="relative grid min-h-[414px] grid-cols-7 border-b border-hui-border last:border-b-0">
                                {weekDays.map(day => {
                                    const dayKey = formatDate(day);
                                    const isToday = isSameUTCDay(day, today);
                                    const isCurrentMonth = day.getUTCMonth() === currentMonth;
                                    const incomeTotal = showIncome ? dayTotals?.income.get(dayKey) : undefined;
                                    const projectedCoTotal = showProjectedCo ? dayTotals?.projectedCo.get(dayKey) : undefined;
                                    const expenseTotal = showExpenses ? dayTotals?.expenses.get(dayKey) : undefined;
                                    const hoursTotal = showHours ? dayTotals?.hours.get(dayKey) : undefined;
                                    return (
                                        <div
                                            key={dayKey}
                                            data-schedule-date={dayKey}
                                            onDragOver={event => handleDayDragOver(dayKey, event)}
                                            onDragLeave={event => handleDayDragLeave(dayKey, event)}
                                            onDrop={event => handleDayDrop(dayKey, event)}
                                            onContextMenu={event => handleDayContextMenu(dayKey, event)}
                                            className={`min-w-0 border-r border-hui-border p-1.5 last:border-r-0 ${isCurrentMonth ? (isWeekend(day) ? "bg-slate-50/60" : "bg-white") : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-indigo-300" : ""} ${dragOverDate === dayKey ? "bg-indigo-50 ring-2 ring-inset ring-indigo-500" : ""}`}
                                        >
                                            <span className={`text-xs font-semibold ${isToday ? "inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white" : isCurrentMonth ? "text-hui-textMain" : "text-slate-400"}`}>{day.getUTCDate()}</span>
                                            <div className="space-y-0.5 pt-[332px]">
                                                {incomeTotal != null && incomeTotal > 0 && <div className="truncate px-1 text-[10px] font-medium text-green-700" title="Income due this day (effective due date)">{formatCurrency(incomeTotal)} due</div>}
                                                {projectedCoTotal != null && projectedCoTotal > 0 && <div className="truncate px-1 text-[10px] font-medium text-amber-700" title="Approved, unbilled change-order income projected this day">{formatCurrency(projectedCoTotal)} projected CO</div>}
                                                {expenseTotal != null && expenseTotal > 0 && <div className="truncate px-1 text-[10px] font-medium text-red-700" title="Expenses this day">−{formatCurrency(expenseTotal)}</div>}
                                                {hoursTotal != null && hoursTotal > 0 && <div className="truncate px-1 text-[10px] font-medium text-blue-700" title="Hours logged this day">{hoursTotal.toFixed(1)}h</div>}
                                            </div>
                                        </div>
                                    );
                                })}
                                {/* Readability pass (2026-07-22): row height 64->80px, sized for
                                the new max bar height (18 top strip + 3 lanes * 18px = 72px, item
                                5). pt-[332px]/top-[348px] below scale with this — see item 5. */}
                                <div className="pointer-events-none absolute inset-x-0 top-8 grid h-[320px] grid-cols-7 grid-rows-[repeat(4,80px)] gap-y-0 px-0.5">
                                    {visibleSegments.map(segment => {
                                        const project = projectById.get(segment.projectId);
                                        if (!project) return null;
                                        return (
                                            <div
                                                key={`${segment.projectId}-${segment.weekIndex}`}
                                                className="pointer-events-auto min-w-0 px-0.5 py-px"
                                                style={{ gridColumn: `${segment.startColumn + 1} / span ${segment.spanDays}`, gridRow: segment.lane + 1 }}
                                            >
                                                <ProjectBar
                                                    project={project}
                                                    segment={segment}
                                                    projectColor={project.color || getFallbackProjectColor(project.id)}
                                                    conflictNames={projectConflictNames(project.id, data.crewConflicts, { start: gridStart, end: addDays(gridStart, 42) })}
                                                    incomeMilestones={milestoneMaps?.income.get(project.id) ?? EMPTY_INCOME}
                                                    changeOrderMilestones={milestoneMaps?.changeOrders.get(project.id) ?? EMPTY_CHANGE_ORDERS}
                                                    canEdit={data.canEdit}
                                                    canMoveProject={data.canEdit && (project.status === "Waiting to Start" || project.status === "In Progress")}
                                                    isPending={isSaving || pendingProjectIds.has(project.id)}
                                                    isDraft={draftProjectIds.has(project.id)}
                                                    pendingTaskIds={pendingTaskIds}
                                                    draftTaskIds={draftTaskIds}
                                                    activeTaskKeyboardEdit={activeTaskKeyboardEdit}
                                                    activeProjectKeyboardId={activeProjectKeyboardId}
                                                    teamMembers={teamMembers}
                                                    isAnyDragActive={isAnyDragActive}
                                                    onProjectPointerEditStart={onProjectPointerEditStart}
                                                    onProjectKeyboardStart={onProjectKeyboardStart}
                                                    onProjectKeyboardAdjust={onProjectKeyboardAdjust}
                                                    onProjectKeyboardCommit={onProjectKeyboardCommit}
                                                    onProjectKeyboardCancel={onProjectKeyboardCancel}
                                                    onMoveCommit={onProjectMoveCommit}
                                                    onProjectEndResizeStart={onProjectEndResizeStart}
                                                    onTaskPointerEditStart={onTaskPointerEditStart}
                                                    onTaskKeyboardStart={onTaskKeyboardStart}
                                                    onTaskKeyboardAdjust={onTaskKeyboardAdjust}
                                                    onTaskKeyboardCommit={onTaskKeyboardCommit}
                                                    onTaskKeyboardCancel={onTaskKeyboardCancel}
                                                    onTaskDatesCommit={onTaskDatesCommit}
                                                    onTaskMoveBy={onTaskMoveBy}
                                                />
                                            </div>
                                        );
                                    })}
                                    {visibleMilestoneHosts.map(host => {
                                        const project = projectById.get(host.projectId);
                                        const rows = milestoneRowsByProjectDate?.get(`${host.projectId}|${host.dateKey}`) ?? [];
                                        const visibleRange = { start: parseUTCDate(host.dateKey), end: addDays(parseUTCDate(host.dateKey), 1) };
                                        const taskMilestones = project?.tasks.filter(task => task.type === "milestone" && task.startDate.slice(0, 10) === host.dateKey) ?? [];
                                        return (
                                            <div
                                                key={`milestone-host-${host.projectId}-${host.dateKey}`}
                                                className="pointer-events-auto relative min-w-0"
                                                style={{ gridColumn: `${host.startColumn + 1} / span 1`, gridRow: host.lane + 1 }}
                                            >
                                                <div className="relative h-9" aria-label={`${projectById.get(host.projectId)?.name ?? "Project"} milestones`}>
                                                    {rows.map((row, index) => (
                                                        <MilestoneMarker
                                                            key={row.key}
                                                            name={row.name}
                                                            amount={row.amount}
                                                            effectiveDueDate={row.effectiveDueDate}
                                                            visibleRange={visibleRange}
                                                            kind={row.kind}
                                                            offsetPixels={(index - (rows.length - 1) / 2) * 8}
                                                        />
                                                    ))}
                                                    {project && taskMilestones.length > 0 && (
                                                        <div className="absolute inset-x-0 bottom-0 h-[22px]">
                                                            {taskMilestones.map(task => (
                                                                <TaskBlockSegment
                                                                    key={task.id}
                                                                    task={task}
                                                                    projectRange={getEffectiveProjectRange(project) ?? visibleRange}
                                                                    visibleRange={visibleRange}
                                                                    projectColor={project.color || getFallbackProjectColor(project.id)}
                                                                    canEdit={data.canEdit}
                                                                    isPending={isSaving || pendingProjectIds.has(project.id) || pendingTaskIds.has(task.id)}
                                                                    isDraft={draftProjectIds.has(project.id) || draftTaskIds.has(task.id)}
                                                                    activeTaskKeyboardEdit={activeTaskKeyboardEdit}
                                                                    teamMembers={teamMembers}
                                                                    isAnyDragActive={isAnyDragActive}
                                                                    onTaskPointerEditStart={onTaskPointerEditStart}
                                                                    onTaskKeyboardStart={onTaskKeyboardStart}
                                                                    onTaskKeyboardAdjust={onTaskKeyboardAdjust}
                                                                    onTaskKeyboardCommit={onTaskKeyboardCommit}
                                                                    onTaskKeyboardCancel={onTaskKeyboardCancel}
                                                                    onTaskDatesCommit={onTaskDatesCommit}
                                                                    onTaskMoveBy={onTaskMoveBy}
                                                                />
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {hiddenCount > 0 && (
                                    <div className="absolute right-2 top-[348px] z-40 text-right">
                                        <button
                                            type="button"
                                            onClick={() => setExpandedWeeks(current => {
                                                const next = new Set(current);
                                                if (next.has(weekIndex)) next.delete(weekIndex);
                                                else next.add(weekIndex);
                                                return next;
                                            })}
                                            aria-expanded={expanded}
                                            className="rounded bg-white px-2 py-1 text-[10px] font-semibold text-indigo-700 shadow-sm ring-1 ring-inset ring-indigo-200 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                        >
                                            +{hiddenCount} more
                                        </button>
                                        {expanded && (
                                            <ul className="mt-1 w-56 rounded-md border border-hui-border bg-white p-1 text-left shadow-lg">
                                                {hiddenProjects.map(project => (
                                                    <li key={project.id} className="truncate px-2 py-1 text-xs text-hui-textMain" title={project.name}>{project.name}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    </div>
                </div>
            </div>
            <FloatingPopover open={dayContextMenu != null} anchorPoint={dayContextMenu?.point ?? null} onClose={() => setDayContextMenu(null)} width={220}>
                <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">
                    Schedule here — {dayContextMenu?.date}
                </p>
                {data.pipeline.waitingToStart.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-hui-textMuted">No unscheduled projects</p>
                ) : (
                    <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                        {data.pipeline.waitingToStart.map(project => (
                            <li key={project.id}>
                                <button
                                    type="button"
                                    className="block w-full truncate rounded px-2 py-1 text-left text-xs text-hui-textMain hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                    onClick={() => {
                                        if (dayContextMenu) onTrayProjectDrop(project, dayContextMenu.date);
                                        setDayContextMenu(null);
                                    }}
                                >
                                    {project.name}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </FloatingPopover>
        </ProjectBarGridStartContext.Provider>
    );
}
