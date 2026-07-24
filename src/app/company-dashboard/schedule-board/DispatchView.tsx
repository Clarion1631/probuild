"use client";

import { useEffect, useMemo, useState } from "react";
import type { CompanyDashboardData, DashboardProjectRow, DashboardTaskRow } from "@/lib/schedule-core";
import type { VancouverForecastDay } from "@/lib/weather";
import { addDays, formatDate, getFallbackProjectColor, getMonday, todayUTC } from "@/app/projects/[id]/schedule/schedule-utils";
import { isConflictedDay } from "./availability";
import { getCrewlessJobs, isTaskActiveOnDay } from "./dispatch-exceptions";
import { DispatchExceptions } from "./DispatchExceptions";
import { DispatchJobCard } from "./DispatchJobCard";

export type DispatchMode = "today" | "week";
export const DISPATCH_MODE_STORAGE_KEY = "gtr-company-schedule-dispatch-mode";

export interface DispatchTaskCreationDefaults {
    defaultProjectId?: string;
    lockProject?: boolean;
    defaultStartDate: string;
    defaultCrewIds?: string[];
}

interface DispatchViewProps {
    data: CompanyDashboardData;
    weather: VancouverForecastDay[];
    onActivate: (taskId: string) => void;
    onCreateTask: (defaults: DispatchTaskCreationDefaults) => void;
    onReviewDispatch: () => void;
    draftCount: number;
    isReviewingDispatch: boolean;
}

interface WeekChip {
    project: DashboardProjectRow;
    task: DashboardTaskRow;
    solid: boolean;
    lead: boolean;
}

function initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).map(part => part[0]).join("").toUpperCase().slice(0, 2) || "?";
}

function dayLabel(day: Date): string {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(day);
}

function taskLabel(task: DashboardTaskRow): string {
    if (task.type === "milestone") return `\u25C6 ${task.name}`;
    if (task.type === "appointment") return `\u{1F550}${task.scheduledTime ? ` ${task.scheduledTime}` : ""} ${task.name}`;
    return task.name;
}

function weekChipsForMember(projects: DashboardProjectRow[], memberId: string, dayKey: string): WeekChip[] {
    const chips: WeekChip[] = [];
    for (const project of projects) {
        const isProjectCrew = project.crew.some(member => member.id === memberId && member.status === "ACTIVATED" && member.role === "FIELD_CREW");
        for (const task of project.tasks) {
            if (!isTaskActiveOnDay(task, dayKey)) continue;
            const assignment = task.assignments.find(candidate => candidate.userId === memberId && candidate.status === "ACTIVATED");
            if (!assignment && !isProjectCrew) continue;
            chips.push({ project, task, solid: Boolean(assignment), lead: assignment?.assignmentRole === "lead" });
        }
    }
    return chips;
}

export function DispatchView({
    data,
    weather,
    onActivate,
    onCreateTask,
    onReviewDispatch,
    draftCount,
    isReviewingDispatch,
}: DispatchViewProps) {
    const [mode, setMode] = useState<DispatchMode>("today");
    const currentMonday = useMemo(() => getMonday(todayUTC()), []);
    const [weekStart, setWeekStart] = useState(currentMonday);
    const [highlightedProjectId, setHighlightedProjectId] = useState<string | null>(null);

    useEffect(() => {
        let restoreFrame: number | null = null;
        try {
            const stored = localStorage.getItem(DISPATCH_MODE_STORAGE_KEY);
            if (stored === "today" || stored === "week") {
                restoreFrame = window.requestAnimationFrame(() => setMode(stored));
            }
        } catch {
            // The default Today mode remains usable when storage is unavailable.
        }
        return () => {
            if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
        };
    }, []);

    function selectMode(nextMode: DispatchMode) {
        setMode(nextMode);
        try {
            localStorage.setItem(DISPATCH_MODE_STORAGE_KEY, nextMode);
        } catch {
            // The selected mode still applies for this session.
        }
    }

    const projects = useMemo(() => [
        ...data.pipeline.waitingToStart,
        ...data.pipeline.scheduled,
        ...data.pipeline.inProgress,
        ...data.pipeline.substantialCompletion,
    ], [data.pipeline]);
    const today = todayUTC();
    const todayKey = formatDate(today);
    const weatherByDate = new Map(weather.map(forecast => [forecast.date, forecast]));
    const fieldCrew = (data.teamMembers ?? []).filter(member => member.role === "FIELD_CREW");
    const activeTodayByProject = new Map(projects.map(project => [
        project.id,
        project.tasks.filter(task => isTaskActiveOnDay(task, todayKey)),
    ]));
    const todayTasks = projects.flatMap(project => activeTodayByProject.get(project.id) ?? []);
    const assignedTodayIds = new Set(todayTasks.flatMap(task => task.assignments
        .filter(assignment => assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW")
        .map(assignment => assignment.userId)));
    const available = fieldCrew.filter(member => !assignedTodayIds.has(member.id));
    const managerSupport = [...new Map(todayTasks.flatMap(task => task.assignments)
        .filter(assignment => assignment.status === "ACTIVATED" && (assignment.userRole === "ADMIN" || assignment.userRole === "MANAGER"))
        .map(assignment => [assignment.userId, assignment] as const)).values()];
    const crewlessProjectIds = new Set(getCrewlessJobs(projects, todayKey).map(item => item.projectId));
    const todayProjects = projects
        .filter(project => (activeTodayByProject.get(project.id)?.length ?? 0) > 0 || crewlessProjectIds.has(project.id))
        .sort((left, right) => left.name.localeCompare(right.name));

    const mondayToFriday = Array.from({ length: 5 }, (_, index) => addDays(weekStart, index));
    const saturday = addDays(weekStart, 5);
    const sunday = addDays(weekStart, 6);
    const showSaturday = projects.some(project => project.tasks.some(task => isTaskActiveOnDay(task, formatDate(saturday))));
    const showSunday = projects.some(project => project.tasks.some(task => isTaskActiveOnDay(task, formatDate(sunday))));
    const visibleWeekDays = [...mondayToFriday, ...(showSaturday ? [saturday] : []), ...(showSunday ? [sunday] : [])];
    const crewConflicts = data.crewConflicts;
    const headerForecast = mode === "today"
        ? weatherByDate.get(todayKey)
        : visibleWeekDays
            .map(day => weatherByDate.get(formatDate(day)))
            .find((forecast): forecast is VancouverForecastDay => Boolean(forecast));

    useEffect(() => {
        if (!highlightedProjectId || mode !== "today") return;
        const frame = window.requestAnimationFrame(() => {
            document.getElementById(`dispatch-project-${highlightedProjectId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        const timeout = window.setTimeout(() => setHighlightedProjectId(null), 1_800);
        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
        };
    }, [highlightedProjectId, mode]);

    function focusProject(projectId: string) {
        selectMode("today");
        setHighlightedProjectId(projectId);
    }

    return (
        <div className="min-w-0">
            <DispatchExceptions
                projects={projects}
                crewConflicts={data.crewConflicts}
                dayKey={todayKey}
                onActivate={onActivate}
                onProjectFocus={focusProject}
            />

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hui-border px-4 py-3">
                <div>
                    <h3 className="text-sm font-semibold text-hui-textMain">Dispatch</h3>
                    <p className="mt-0.5 text-xs text-hui-textMuted">Jobs first today. People first across the week.</p>
                    <p className="mt-1 text-[10px] font-medium text-slate-500">
                        Vancouver forecast{headerForecast ? ` \u00B7 ${headerForecast.glyph} ${headerForecast.precipitationProbability}% rain \u00B7 ${headerForecast.high}\u00B0/${headerForecast.low}\u00B0` : " unavailable"}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {data.canEdit && (
                        <button
                            type="button"
                            onClick={onReviewDispatch}
                            disabled={draftCount === 0 || isReviewingDispatch}
                            className="hui-btn hui-btn-green text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isReviewingDispatch
                                ? "Reviewing..."
                                : draftCount > 0
                                    ? `Review dispatch (${draftCount})`
                                    : "Review dispatch"}
                        </button>
                    )}
                    <div className="inline-flex rounded-md border border-hui-border bg-white p-0.5" role="group" aria-label="Dispatch range">
                        {(["today", "week"] as const).map(nextMode => (
                            <button
                                key={nextMode}
                                type="button"
                                onClick={() => selectMode(nextMode)}
                                aria-pressed={mode === nextMode}
                                className={`rounded px-3 py-1.5 text-xs font-semibold capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${mode === nextMode ? "bg-hui-primary text-white" : "text-hui-textMuted hover:bg-slate-50"}`}
                            >
                                {nextMode}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {mode === "today" ? (
                <div className="space-y-4 p-4">
                    <div className="rounded-lg border border-hui-border bg-slate-50 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Available</span>
                            {available.length === 0 ? <span className="text-xs text-slate-400">No unassigned field crew</span> : available.map(member => (
                                <span key={member.id} className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-white px-2 py-1 text-xs font-semibold text-green-700" title={`${member.name} has no task assignment today`}>
                                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-100 text-[9px] font-bold">{initials(member.name)}</span>
                                    {member.name}
                                </span>
                            ))}
                        </div>
                        {managerSupport.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
                                <span className="text-[10px] font-semibold uppercase tracking-wider">Manager support</span>
                                {managerSupport.map(assignment => <span key={assignment.userId}>{assignment.name}</span>)}
                            </div>
                        )}
                    </div>

                    {todayProjects.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-hui-border px-4 py-10 text-center">
                            <p className="text-sm font-semibold text-hui-textMain">No jobs on dispatch today</p>
                            <p className="mt-1 text-xs text-hui-textMuted">Add a task or move work onto today to build the run.</p>
                        </div>
                    ) : (
                        <div className="grid gap-4 xl:grid-cols-2">
                            {todayProjects.map(project => (
                                <DispatchJobCard
                                    key={project.id}
                                    project={project}
                                    tasks={activeTodayByProject.get(project.id) ?? []}
                                    highlighted={highlightedProjectId === project.id}
                                    canCreate={data.canEdit}
                                    onActivate={onActivate}
                                    onAddTask={() => onCreateTask({
                                        defaultProjectId: project.id,
                                        lockProject: true,
                                        defaultStartDate: todayKey,
                                    })}
                                />
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                <div className="p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-hui-textMain">
                            Week of {dayLabel(weekStart)}
                        </p>
                        <div className="flex items-center gap-2">
                            <button type="button" onClick={() => setWeekStart(current => addDays(current, -7))} className="hui-btn hui-btn-secondary text-xs" aria-label="Previous week">{"\u2190"}</button>
                            <button type="button" onClick={() => setWeekStart(currentMonday)} className="hui-btn hui-btn-secondary text-xs">This week</button>
                            <button type="button" onClick={() => setWeekStart(current => addDays(current, 7))} className="hui-btn hui-btn-secondary text-xs" aria-label="Next week">{"\u2192"}</button>
                        </div>
                    </div>

                    <div className="max-w-full overflow-x-auto rounded-lg border border-hui-border">
                        <div
                            role="table"
                            aria-label="Weekly crew dispatch"
                            style={{ minWidth: 290 + visibleWeekDays.length * 150 }}
                        >
                            <div className="grid bg-slate-50" role="row" style={{ gridTemplateColumns: `180px repeat(${visibleWeekDays.length}, minmax(140px, 1fr)) 110px` }}>
                                <div role="columnheader" className="border-b border-r border-hui-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Crew</div>
                                {visibleWeekDays.map(day => {
                                    const dayKey = formatDate(day);
                                    const forecast = weatherByDate.get(dayKey);
                                    return (
                                        <div key={dayKey} role="columnheader" className="border-b border-r border-hui-border px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                            <div>{dayLabel(day)}</div>
                                            {forecast && <div className="mt-0.5 normal-case tracking-normal text-slate-600">{forecast.glyph} {forecast.precipitationProbability}% {forecast.high}{"\u00B0"}</div>}
                                        </div>
                                    );
                                })}
                                <div role="columnheader" className="border-b border-hui-border px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">Assigned</div>
                            </div>

                            {fieldCrew.length === 0 ? (
                                <p className="px-4 py-8 text-center text-sm text-hui-textMuted">No field crew to dispatch.</p>
                            ) : fieldCrew.map(member => {
                                const weekdayAssignedCount = mondayToFriday.filter(day => weekChipsForMember(projects, member.id, formatDate(day)).some(chip => chip.solid)).length;
                                return (
                                    <div key={member.id} className="grid" role="row" style={{ gridTemplateColumns: `180px repeat(${visibleWeekDays.length}, minmax(140px, 1fr)) 110px` }}>
                                        <div role="rowheader" className="border-b border-r border-hui-border bg-white px-3 py-3 text-xs font-semibold text-hui-textMain">{member.name}</div>
                                        {visibleWeekDays.map(day => {
                                            const dayKey = formatDate(day);
                                            const chips = weekChipsForMember(projects, member.id, dayKey);
                                            const conflicted = isConflictedDay(crewConflicts, member.id, dayKey, true);
                                            return (
                                                <div key={`${member.id}-${dayKey}`} role="cell" className="min-h-16 border-b border-r border-hui-border bg-white p-1.5">
                                                    <div className={`flex min-h-12 flex-col gap-1 rounded ${conflicted ? "ring-2 ring-red-500 ring-inset" : ""}`}>
                                                        {chips.map(chip => {
                                                            const color = chip.project.color || getFallbackProjectColor(chip.project.id);
                                                            return (
                                                                <button
                                                                    key={`${chip.task.id}-${chip.solid ? "solid" : "soft"}`}
                                                                    type="button"
                                                                    onClick={() => onActivate(chip.task.id)}
                                                                    title={`${chip.project.name} \u2014 ${taskLabel(chip.task)}`}
                                                                    className={`block truncate rounded px-1.5 py-1 text-left text-[11px] font-semibold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${chip.solid ? "text-white" : "border-2 bg-white"}`}
                                                                    style={chip.solid ? { backgroundColor: color } : { borderColor: color, color }}
                                                                >
                                                                    {chip.lead ? "\u2605 " : ""}{chip.project.name}
                                                                </button>
                                                            );
                                                        })}
                                                        {chips.length === 0 && data.canEdit && (
                                                            <button
                                                                type="button"
                                                                onClick={() => onCreateTask({ defaultStartDate: dayKey, defaultCrewIds: [member.id] })}
                                                                className="min-h-12 rounded border border-dashed border-transparent text-[10px] text-slate-300 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-500 focus-visible:border-hui-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                                                aria-label={`Create task for ${member.name} on ${dayKey}`}
                                                            >
                                                                + Task
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        <div role="cell" className="border-b border-hui-border bg-white px-2 py-3 text-center text-xs font-semibold text-slate-600">{weekdayAssignedCount} of 5 days assigned</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
