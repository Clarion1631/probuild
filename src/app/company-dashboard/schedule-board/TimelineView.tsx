"use client";

import { useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import type { CompanyDashboardData, DashboardProjectRow } from "@/lib/schedule-core";
import {
    addDays,
    formatCurrency,
    formatDate,
    getDaysBetween,
    getMonthGrid,
    isSameUTCDay,
    isWeekend,
    parseUTCDate,
    todayUTC,
} from "@/app/projects/[id]/schedule/schedule-utils";
import { MilestoneMarker } from "./MilestoneMarker";
import { ProjectBar, ProjectBarGridStartContext, type ProjectEditCallbacks } from "./ProjectBar";
import { TaskBlockSegment, type ActiveTaskKeyboardEdit, type TaskEditCallbacks } from "./TaskBlockSegment";
import { PROJECT_DRAG_MIME } from "./UnscheduledTray";
import { clipRange, getEffectiveProjectRange, toTimelineRect, type WeekSegment } from "./useBarLayout";

const DAY_WIDTH = 20;
const TIMELINE_DAYS = 42;
const LABEL_WIDTH = 240;
const CANVAS_WIDTH = DAY_WIDTH * TIMELINE_DAYS;
const FALLBACK_COLORS = ["#2563eb", "#7c3aed", "#0f766e", "#c2410c", "#be123c", "#4338ca", "#047857", "#a21caf"];

interface TimelineViewProps extends TaskEditCallbacks, ProjectEditCallbacks {
    data: CompanyDashboardData;
    showIncome: boolean;
    showProjectedCo: boolean;
    showExpenses: boolean;
    showHours: boolean;
    pendingProjectIds: ReadonlySet<string>;
    pendingTaskIds: ReadonlySet<string>;
    activeTaskKeyboardEdit: ActiveTaskKeyboardEdit | null;
    onTrayProjectDrop: (_project: DashboardProjectRow, _targetStart: string) => void;
}

export function TimelineView({
    data,
    showIncome,
    showProjectedCo,
    showExpenses,
    showHours,
    pendingProjectIds,
    pendingTaskIds,
    activeTaskKeyboardEdit,
    onTrayProjectDrop,
    onProjectMoveCommit,
    activeProjectKeyboardId,
    onProjectPointerEditStart,
    onProjectKeyboardStart,
    onProjectKeyboardAdjust,
    onProjectKeyboardCommit,
    onProjectKeyboardCancel,
    onTaskPointerEditStart,
    onTaskKeyboardStart,
    onTaskKeyboardAdjust,
    onTaskKeyboardCommit,
    onTaskKeyboardCancel,
    onTaskDatesCommit,
    onTaskMoveBy,
}: TimelineViewProps) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [dragOverDate, setDragOverDate] = useState<string | null>(null);
    const anchor = parseUTCDate(`${data.month}-01`);
    const days = getMonthGrid(anchor).slice(0, TIMELINE_DAYS);
    const gridStart = days[0];
    const gridEnd = addDays(gridStart, TIMELINE_DAYS);
    const visibleRange = { start: gridStart, end: gridEnd };
    const today = todayUTC();
    const projects: DashboardProjectRow[] = [
        ...data.pipeline.waitingToStart,
        ...data.pipeline.scheduled,
        ...data.pipeline.inProgress,
        ...data.pipeline.substantialCompletion,
    ];
    const adminOverlays = data.isAdmin ? data.overlays : null;
    const visibleIncomeMilestones = adminOverlays && showIncome ? adminOverlays.income : [];
    const visibleChangeOrderMilestones = adminOverlays && showProjectedCo ? adminOverlays.changeOrders : [];
    const incomeTotals = new Map<string, number>();
    const projectedCoTotals = new Map<string, number>();
    const expenseTotals = new Map<string, number>();
    const hoursTotals = new Map<string, number>();
    if (adminOverlays) {
        for (const item of adminOverlays.income) {
            const key = item.effectiveDueDate.slice(0, 10);
            incomeTotals.set(key, (incomeTotals.get(key) ?? 0) + item.amount);
        }
        for (const item of adminOverlays.changeOrders) {
            const key = item.effectiveDueDate.slice(0, 10);
            projectedCoTotals.set(key, (projectedCoTotals.get(key) ?? 0) + item.amount);
        }
        for (const item of adminOverlays.expenses) {
            const key = item.date.slice(0, 10);
            expenseTotals.set(key, (expenseTotals.get(key) ?? 0) + item.amount);
        }
        for (const item of adminOverlays.hours) {
            const key = item.startTime.slice(0, 10);
            hoursTotals.set(key, (hoursTotals.get(key) ?? 0) + item.durationHours);
        }
    }

    function hasProjectDragPayload(event: DragEvent<HTMLDivElement>): boolean {
        return event.dataTransfer.types.includes(PROJECT_DRAG_MIME);
    }

    function handleDayDragOver(dayKey: string, event: DragEvent<HTMLDivElement>) {
        if (!data.canEdit || !hasProjectDragPayload(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOverDate(dayKey);
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
            <div ref={scrollContainerRef} className="overflow-x-auto" aria-label="Project schedule timeline">
                <div style={{ width: LABEL_WIDTH + CANVAS_WIDTH }}>
                    <div className="flex border-b border-hui-border bg-white">
                        <div data-timeline-sticky-label="true" className="sticky left-0 z-50 flex shrink-0 items-end border-r border-hui-border bg-white px-3 pb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500" style={{ width: LABEL_WIDTH }}>
                            Project
                        </div>
                        <div className="shrink-0" style={{ width: CANVAS_WIDTH }}>
                            <div className="grid grid-cols-6 border-b border-hui-border">
                                {Array.from({ length: 6 }, (_, weekIndex) => {
                                    const weekStart = days[weekIndex * 7];
                                    return (
                                        <div key={formatDate(weekStart)} className="border-r border-hui-border px-1 py-1 text-[9px] font-semibold text-slate-500 last:border-r-0" style={{ width: DAY_WIDTH * 7 }}>
                                            Week of {formatDate(weekStart)}
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="grid" style={{ gridTemplateColumns: `repeat(${TIMELINE_DAYS}, ${DAY_WIDTH}px)` }}>
                                {days.map(day => {
                                    const dayKey = formatDate(day);
                                    const isToday = isSameUTCDay(day, today);
                                    return (
                                        <div key={dayKey} className={`border-r border-hui-border py-1 text-center text-[8px] font-semibold ${isWeekend(day) ? "bg-slate-100 text-slate-500" : "text-slate-600"} ${isToday ? "bg-indigo-100 text-indigo-700" : ""}`} title={`UTC ${dayKey}`}>
                                            {day.getUTCDate()}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {adminOverlays && (showIncome || showProjectedCo || showExpenses || showHours) && (
                        <div className="flex border-b border-hui-border bg-slate-50/70" aria-label="Visible overlay totals by day">
                            <div data-timeline-sticky-label="true" className="sticky left-0 z-40 shrink-0 border-r border-hui-border bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-500" style={{ width: LABEL_WIDTH }}>
                                Overlay summary
                            </div>
                            <div className="grid h-14 shrink-0" style={{ width: CANVAS_WIDTH, gridTemplateColumns: `repeat(${TIMELINE_DAYS}, ${DAY_WIDTH}px)` }}>
                                {days.map(day => {
                                    const dayKey = formatDate(day);
                                    const labels = [
                                        showIncome && (incomeTotals.get(dayKey) ?? 0) > 0 ? `${formatCurrency(incomeTotals.get(dayKey) ?? 0)} due` : null,
                                        showProjectedCo && (projectedCoTotals.get(dayKey) ?? 0) > 0 ? `${formatCurrency(projectedCoTotals.get(dayKey) ?? 0)} projected CO` : null,
                                        showExpenses && (expenseTotals.get(dayKey) ?? 0) > 0 ? `${formatCurrency(expenseTotals.get(dayKey) ?? 0)} expenses` : null,
                                        showHours && (hoursTotals.get(dayKey) ?? 0) > 0 ? `${(hoursTotals.get(dayKey) ?? 0).toFixed(1)} hours` : null,
                                    ].filter((label): label is string => Boolean(label));
                                    return (
                                        <div
                                            key={dayKey}
                                            className={`group/overlay relative min-w-0 overflow-visible border-r border-hui-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${isWeekend(day) ? "bg-slate-100/80" : ""}`}
                                            title={labels.join("; ")}
                                            tabIndex={labels.length > 0 ? 0 : undefined}
                                            aria-label={labels.length > 0 ? `UTC ${dayKey}: ${labels.join(", ")}` : undefined}
                                        >
                                            {labels.length > 0 && <span className="sr-only">UTC {dayKey}: {labels.join(", ")}</span>}
                                            {labels.length > 0 && <span aria-hidden="true" className="mx-auto mt-1 block h-2 w-2 rounded-full bg-indigo-400" />}
                                            {labels.length > 0 && (
                                                <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-5 z-[70] hidden w-max max-w-56 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium leading-4 text-white shadow-lg group-focus/overlay:block">
                                                    {labels.join(", ")}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {projects.map((project, projectIndex) => {
                        const range = getEffectiveProjectRange(project);
                        const clipped = range ? clipRange(range, visibleRange) : null;
                        const rect = clipped ? toTimelineRect(clipped, gridStart, DAY_WIDTH) : null;
                        const startOffset = clipped ? getDaysBetween(gridStart, clipped.start) : 0;
                        const segment: WeekSegment | null = range
                            ? clipped
                                ? {
                                    projectId: project.id,
                                    weekIndex: Math.floor(startOffset / 7),
                                    startColumn: startOffset % 7,
                                    spanDays: getDaysBetween(clipped.start, clipped.end),
                                    continuesBefore: clipped.start > range.start,
                                    continuesAfter: clipped.end < range.end,
                                    lane: 0,
                                }
                                : {
                                    projectId: project.id,
                                    weekIndex: 0,
                                    startColumn: 0,
                                    spanDays: 1,
                                    continuesBefore: range.start < gridStart,
                                    continuesAfter: range.end > gridEnd,
                                    lane: 0,
                                }
                            : null;
                        const conflictNames = [...new Set((data.crewConflicts ?? []).flatMap(conflict =>
                            conflict.pairs.some(pair => pair.projectA.id === project.id || pair.projectB.id === project.id)
                                ? [conflict.name]
                                : [],
                        ))];
                        const crewLabel = project.crew.length > 0 ? project.crew.map(member => member.name).join(", ") : "No project crew";
                        const milestoneRows = [
                            ...visibleIncomeMilestones.filter(item => item.projectId === project.id).map(item => ({
                                key: `income-${item.id}`,
                                name: item.name,
                                amount: item.amount,
                                effectiveDueDate: item.effectiveDueDate,
                                kind: "income" as const,
                            })),
                            ...visibleChangeOrderMilestones.filter(item => item.projectId === project.id).map(item => ({
                                key: `co-${item.paymentScheduleId}`,
                                name: item.name,
                                amount: item.amount,
                                effectiveDueDate: item.effectiveDueDate,
                                kind: "change-order" as const,
                            })),
                        ];
                        const outsideTaskMilestones = project.tasks.filter(task => {
                            if (task.type !== "milestone") return false;
                            const day = parseUTCDate(task.startDate.slice(0, 10));
                            return day >= gridStart && day < gridEnd && (!range || day < range.start || day >= range.end);
                        });

                        return (
                            <div key={project.id} className="flex min-h-[64px] border-b border-hui-border last:border-b-0">
                                <div data-timeline-sticky-label="true" className="sticky left-0 z-40 flex shrink-0 items-center justify-between gap-2 border-r border-hui-border bg-white px-3 py-2" style={{ width: LABEL_WIDTH }}>
                                    <div className="min-w-0">
                                        <Link href={`/projects/${project.id}`} className="block truncate text-xs font-semibold text-hui-textMain hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary">
                                            {project.name}
                                        </Link>
                                        <div className="truncate text-[10px] text-hui-textMuted" title={`Crew: ${crewLabel}`}>{crewLabel}</div>
                                    </div>
                                    {conflictNames.length > 0 && (
                                        <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-700" title={`Crew conflicts: ${conflictNames.join(", ")}`} aria-label={`${conflictNames.length} crew conflict${conflictNames.length === 1 ? "" : "s"}`}>
                                            !{conflictNames.length}
                                        </span>
                                    )}
                                </div>
                                <div data-timeline-schedule-grid="true" className="relative h-16 shrink-0" style={{ width: CANVAS_WIDTH }}>
                                    <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${TIMELINE_DAYS}, ${DAY_WIDTH}px)` }} aria-hidden="true">
                                        {days.map(day => {
                                            const dayKey = formatDate(day);
                                            return (
                                                <div
                                                    key={dayKey}
                                                    data-schedule-date={dayKey}
                                                    onDragOver={event => handleDayDragOver(dayKey, event)}
                                                    onDragLeave={() => setDragOverDate(current => current === dayKey ? null : current)}
                                                    onDrop={event => handleDayDrop(dayKey, event)}
                                                    className={`border-r border-hui-border ${isWeekend(day) ? "bg-slate-100/70" : "bg-white"} ${dragOverDate === dayKey ? "bg-indigo-100 ring-1 ring-inset ring-indigo-500" : ""}`}
                                                />
                                            );
                                        })}
                                    </div>
                                    {today >= gridStart && today < gridEnd && (
                                        <span className="pointer-events-none absolute inset-y-0 z-20 w-px bg-indigo-500" style={{ left: toTimelineRect({ start: today, end: addDays(today, 1) }, gridStart, DAY_WIDTH).left + DAY_WIDTH / 2 }} aria-hidden="true" />
                                    )}
                                    {segment && (
                                        <div className={`absolute z-10 py-1 ${rect ? "" : "invisible pointer-events-none"}`} style={{ left: rect?.left ?? 0, top: 8, width: Math.max(rect?.width ?? DAY_WIDTH, DAY_WIDTH) }}>
                                            <ProjectBar
                                                project={project}
                                                segment={segment}
                                                projectColor={project.color || FALLBACK_COLORS[projectIndex % FALLBACK_COLORS.length]}
                                                conflictNames={conflictNames}
                                                incomeMilestones={[]}
                                                changeOrderMilestones={[]}
                                                canEdit={data.canEdit}
                                                canMoveProject={data.canEdit && (project.status === "Waiting to Start" || project.status === "In Progress")}
                                                isPending={pendingProjectIds.has(project.id)}
                                                pendingTaskIds={pendingTaskIds}
                                                activeTaskKeyboardEdit={activeTaskKeyboardEdit}
                                                activeProjectKeyboardId={activeProjectKeyboardId}
                                                timelineDayWidth={DAY_WIDTH}
                                                timelineLeftInset={LABEL_WIDTH}
                                                timelineScrollContainerRef={scrollContainerRef}
                                                onProjectPointerEditStart={onProjectPointerEditStart}
                                                onProjectKeyboardStart={onProjectKeyboardStart}
                                                onProjectKeyboardAdjust={onProjectKeyboardAdjust}
                                                onProjectKeyboardCommit={onProjectKeyboardCommit}
                                                onProjectKeyboardCancel={onProjectKeyboardCancel}
                                                onMoveCommit={onProjectMoveCommit}
                                                onTaskPointerEditStart={onTaskPointerEditStart}
                                                onTaskKeyboardStart={onTaskKeyboardStart}
                                                onTaskKeyboardAdjust={onTaskKeyboardAdjust}
                                                onTaskKeyboardCommit={onTaskKeyboardCommit}
                                                onTaskKeyboardCancel={onTaskKeyboardCancel}
                                                onTaskDatesCommit={onTaskDatesCommit}
                                                onTaskMoveBy={onTaskMoveBy}
                                            />
                                        </div>
                                    )}
                                    {outsideTaskMilestones.map(task => {
                                        const milestoneStart = parseUTCDate(task.startDate.slice(0, 10));
                                        const milestoneRange = { start: milestoneStart, end: addDays(milestoneStart, 1) };
                                        return (
                                            <div key={`task-milestone-${task.id}`} className="absolute z-30 h-[18px]" style={{ left: toTimelineRect(milestoneRange, gridStart, DAY_WIDTH).left, top: 26, width: DAY_WIDTH }}>
                                                <TaskBlockSegment
                                                    task={task}
                                                    projectRange={range ?? milestoneRange}
                                                    visibleRange={milestoneRange}
                                                    projectColor={project.color || FALLBACK_COLORS[projectIndex % FALLBACK_COLORS.length]}
                                                    canEdit={data.canEdit}
                                                    isPending={pendingProjectIds.has(project.id) || pendingTaskIds.has(task.id)}
                                                    activeTaskKeyboardEdit={activeTaskKeyboardEdit}
                                                    timelineDayWidth={DAY_WIDTH}
                                                    timelineLeftInset={LABEL_WIDTH}
                                                    timelineScrollContainerRef={scrollContainerRef}
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
                                    {milestoneRows.map(marker => {
                                        const sameDayMarkers = milestoneRows.filter(item => item.effectiveDueDate.slice(0, 10) === marker.effectiveDueDate.slice(0, 10));
                                        const sameDayIndex = sameDayMarkers.findIndex(item => item.key === marker.key);
                                        return (
                                            <MilestoneMarker
                                                key={marker.key}
                                                name={marker.name}
                                                amount={marker.amount}
                                                effectiveDueDate={marker.effectiveDueDate}
                                                visibleRange={visibleRange}
                                                kind={marker.kind}
                                                offsetPixels={(sameDayIndex - (sameDayMarkers.length - 1) / 2) * 8}
                                                timelineOrigin={gridStart}
                                                dayWidth={DAY_WIDTH}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                    {projects.length === 0 && <div className="px-4 py-8 text-center text-sm text-hui-textMuted">No scheduled projects in this window.</div>}
                </div>
            </div>
        </ProjectBarGridStartContext.Provider>
    );
}
