"use client";

import { Fragment } from "react";
import type { CompanyDashboardData, CrewConflict, DashboardProjectRow } from "@/lib/schedule-core";
import { addDays, formatCurrency, formatDate, getFallbackProjectColor, isSameUTCDay, isWeekend, parseUTCDate, todayUTC } from "@/app/projects/[id]/schedule/schedule-utils";
import { getEffectiveProjectRange } from "./useBarLayout";

// Planning panel for Richard (ops manager): "a small dashboard of
// availability for each day so he can plan them out." Derives entirely from
// already-serialized board data (project.tasks[].assignments + project.crew
// + project/task windows) — no new queries, no money-fetch imports. Rendered
// by ScheduleBoard below the Month/Timeline view, canEdit roles only.

const AVAILABILITY_DAYS = 14;
const FAR_JOB_MILES_THRESHOLD = 25;
const PAID_HOURS_PER_DAY = 8;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CAR_GLYPH = "\u{1F697}"; // far-job indicator — plan for a longer day

interface AvailabilityMember {
    id: string;
    name: string;
    role: string;
    burdenedHourlyRate?: number;
}

interface AvailabilityChip {
    kind: "booked" | "soft";
    projectId: string;
    projectName: string;
    projectColor: string;
    taskName: string | null;
    startDate: string;
    endDate: string;
    distanceMilesFromShop: number | null;
}

interface AvailabilityRow {
    userId: string;
    name: string;
    burdenedHourlyRate?: number;
    chipsByDay: Map<string, AvailabilityChip[]>;
}

/**
 * Per-member, per-day chips for the next AVAILABILITY_DAYS UTC days. Booked =
 * a TaskAssignment whose (end-exclusive) window covers the day. Soft = no
 * task THAT DAY, but the member is on project.crew of a project whose
 * effective window covers the day (reuses getEffectiveProjectRange, same
 * source TimelineView's By-crew coverage blocks use). At most one booked and
 * one soft chip per project per day — a project with two same-day tasks for
 * one member collapses to a single booked chip.
 */
function buildAvailabilityRows(members: AvailabilityMember[], projects: DashboardProjectRow[], days: Date[]): AvailabilityRow[] {
    const dayKeys = days.map(formatDate);
    const memberById = new Map(members.map(m => [m.id, m]));
    const rowsByUser = new Map<string, AvailabilityRow>();
    const rowFor = (member: AvailabilityMember): AvailabilityRow => {
        let row = rowsByUser.get(member.id);
        if (!row) {
            row = { userId: member.id, name: member.name, burdenedHourlyRate: member.burdenedHourlyRate, chipsByDay: new Map() };
            rowsByUser.set(member.id, row);
        }
        return row;
    };

    for (const project of projects) {
        const projectColor = project.color || getFallbackProjectColor(project.id);
        const bookedDaysByUser = new Map<string, Set<string>>();

        for (const task of project.tasks) {
            const start = parseUTCDate(task.startDate.slice(0, 10));
            const end = task.type === "milestone" ? addDays(start, 1) : parseUTCDate(task.endDate.slice(0, 10));
            if (end <= start) continue;
            for (const assignment of task.assignments) {
                if (assignment.status !== "ACTIVATED") continue;
                const member = memberById.get(assignment.userId);
                if (!member) continue;
                for (const dayKey of dayKeys) {
                    const day = parseUTCDate(dayKey);
                    if (day < start || day >= end) continue;
                    const row = rowFor(member);
                    const chips = row.chipsByDay.get(dayKey) ?? [];
                    if (chips.some(chip => chip.kind === "booked" && chip.projectId === project.id)) continue;
                    chips.push({
                        kind: "booked",
                        projectId: project.id,
                        projectName: project.name,
                        projectColor,
                        taskName: task.name,
                        startDate: task.startDate.slice(0, 10),
                        endDate: task.endDate.slice(0, 10),
                        distanceMilesFromShop: project.distanceMilesFromShop,
                    });
                    row.chipsByDay.set(dayKey, chips);
                    const booked = bookedDaysByUser.get(member.id) ?? new Set<string>();
                    booked.add(dayKey);
                    bookedDaysByUser.set(member.id, booked);
                }
            }
        }

        const range = getEffectiveProjectRange(project);
        if (!range) continue;
        for (const crewMember of project.crew) {
            if (crewMember.status !== "ACTIVATED") continue;
            const member = memberById.get(crewMember.id);
            if (!member) continue;
            for (const dayKey of dayKeys) {
                const day = parseUTCDate(dayKey);
                if (day < range.start || day >= range.end) continue;
                if (bookedDaysByUser.get(member.id)?.has(dayKey)) continue;
                const row = rowFor(member);
                const chips = row.chipsByDay.get(dayKey) ?? [];
                chips.push({
                    kind: "soft",
                    projectId: project.id,
                    projectName: project.name,
                    projectColor,
                    taskName: null,
                    startDate: formatDate(range.start),
                    endDate: formatDate(range.end),
                    distanceMilesFromShop: project.distanceMilesFromShop,
                });
                row.chipsByDay.set(dayKey, chips);
            }
        }
    }

    return members
        .map(member => rowsByUser.get(member.id) ?? { userId: member.id, name: member.name, burdenedHourlyRate: member.burdenedHourlyRate, chipsByDay: new Map<string, AvailabilityChip[]>() })
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Double-booked ring: reuses the already-serialized crewConflicts overlap
// windows (task-based or project-window fallback) — no new computation.
function isConflictedDay(conflicts: CrewConflict[] | null, userId: string, dayKey: string): boolean {
    if (!conflicts) return false;
    const entry = conflicts.find(c => c.userId === userId);
    if (!entry) return false;
    const day = parseUTCDate(dayKey);
    return entry.pairs.some(pair => {
        const start = parseUTCDate(pair.overlapStart.slice(0, 10));
        const end = parseUTCDate(pair.overlapEnd.slice(0, 10));
        return day >= start && day < end;
    });
}

function chipTooltip(chip: AvailabilityChip): string {
    const far = (chip.distanceMilesFromShop ?? 0) > FAR_JOB_MILES_THRESHOLD;
    const base = chip.kind === "booked"
        ? `${chip.projectName} — ${chip.taskName} (${chip.startDate} → ${chip.endDate})`
        : `${chip.projectName} — on the crew, no task assignment that day`;
    return far ? `${base} — ${CAR_GLYPH} ~${chip.distanceMilesFromShop}mi — plan extended day` : base;
}

interface AvailabilityPanelProps {
    data: CompanyDashboardData;
    onDrillDown: () => void;
}

export function AvailabilityPanel({ data, onDrillDown }: AvailabilityPanelProps) {
    const { teamMembers, crewConflicts, canSeeFinancials } = data;
    const projects: DashboardProjectRow[] = [
        ...data.pipeline.waitingToStart,
        ...data.pipeline.scheduled,
        ...data.pipeline.inProgress,
        ...data.pipeline.substantialCompletion,
    ];
    // Rows = FIELD_CREW, plus any ADMIN who actually does field work (shows
    // up on a project crew) — Richard, not Marge/Justin.
    // Owner call 2026-07-23: only members DESIGNATED as crew are planned here
    // — no admins/office on the availability grid (teamMembers is already
    // FIELD_CREW-only at serialization; this filter just states the rule).
    const members: AvailabilityMember[] = (teamMembers ?? []).filter(member => member.role === "FIELD_CREW");

    const today = todayUTC();
    const days = Array.from({ length: AVAILABILITY_DAYS }, (_, i) => addDays(today, i));
    const rows = buildAvailabilityRows(members, projects, days);

    const freeCountByDay = new Map<string, number>();
    const plannedCostByDay = new Map<string, number>();
    for (const day of days) {
        const dayKey = formatDate(day);
        let free = 0;
        let planned = 0;
        for (const row of rows) {
            const chips = row.chipsByDay.get(dayKey) ?? [];
            if (chips.length === 0) {
                free++;
                continue;
            }
            if (row.burdenedHourlyRate != null) planned += row.burdenedHourlyRate * PAID_HOURS_PER_DAY;
        }
        freeCountByDay.set(dayKey, free);
        plannedCostByDay.set(dayKey, Math.round(planned * 100) / 100);
    }

    return (
        <div className="border-t border-hui-border">
            <div className="px-4 py-3 border-b border-hui-border">
                <h2 className="text-base font-semibold text-hui-textMain">Crew availability — next 14 days</h2>
                <p className="text-xs text-hui-textMuted mt-1">
                    Solid chip = assigned to a task that day. Outlined chip = on the job crew, no specific task yet.{" "}
                    {CAR_GLYPH} = the job is far enough from the shop to plan for a longer day. Click a name to see that
                    person&apos;s week on the Timeline.
                </p>
            </div>
            {rows.length === 0 ? (
                <p className="px-4 py-8 text-sm text-hui-textMuted text-center">No field crew to plan yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <div style={{ minWidth: 160 + AVAILABILITY_DAYS * 72 }}>
                        <div className="grid" style={{ gridTemplateColumns: `160px repeat(${AVAILABILITY_DAYS}, 72px)` }}>
                            <div className="sticky left-0 z-10 border-b border-r border-hui-border bg-white px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                Crew
                            </div>
                            {days.map(day => {
                                const isToday = isSameUTCDay(day, today);
                                return (
                                    <div
                                        key={formatDate(day)}
                                        className={`border-b border-r border-hui-border px-1 py-2 text-center text-[10px] font-semibold ${isWeekend(day) ? "bg-slate-100 text-slate-500" : "text-slate-600"} ${isToday ? "bg-indigo-100 text-indigo-700" : ""}`}
                                    >
                                        <div>{WEEKDAY_LABELS[day.getUTCDay()]}</div>
                                        <div>{day.getUTCMonth() + 1}/{day.getUTCDate()}</div>
                                    </div>
                                );
                            })}

                            {rows.map(row => (
                                <Fragment key={row.userId}>
                                    <div className="sticky left-0 z-10 flex items-center border-b border-r border-hui-border bg-white px-3 py-1.5">
                                        <button
                                            type="button"
                                            onClick={onDrillDown}
                                            className="truncate text-left text-xs font-semibold text-hui-textMain hover:text-hui-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary [@media(hover:none)]:opacity-100"
                                            title={`View ${row.name}'s week on the Timeline (By crew)`}
                                        >
                                            {row.name}
                                        </button>
                                    </div>
                                    {days.map(day => {
                                        const dayKey = formatDate(day);
                                        const chips = row.chipsByDay.get(dayKey) ?? [];
                                        const conflicted = isConflictedDay(crewConflicts, row.userId, dayKey);
                                        const isToday = isSameUTCDay(day, today);
                                        return (
                                            <div
                                                key={`${row.userId}-${dayKey}`}
                                                className={`border-b border-r border-hui-border px-1 py-1.5 ${isWeekend(day) ? "bg-slate-100/60" : ""} ${isToday ? "bg-indigo-50/60" : ""}`}
                                            >
                                                <div className={`flex flex-col gap-0.5 rounded ${conflicted ? "ring-2 ring-red-500" : ""}`}>
                                                    {chips.length === 0 && <span className="block h-5" aria-hidden="true" />}
                                                    {chips.map((chip, i) => {
                                                        const far = (chip.distanceMilesFromShop ?? 0) > FAR_JOB_MILES_THRESHOLD;
                                                        return (
                                                            <span
                                                                key={`${chip.projectId}-${chip.kind}-${i}`}
                                                                className={`block truncate rounded px-1 py-0.5 text-[11px] font-semibold leading-tight ${chip.kind === "booked" ? "text-white" : "border-2 bg-transparent"}`}
                                                                style={chip.kind === "booked"
                                                                    ? { backgroundColor: chip.projectColor }
                                                                    : { borderColor: chip.projectColor, color: chip.projectColor }}
                                                                title={chipTooltip(chip)}
                                                            >
                                                                {far ? `${CAR_GLYPH} ` : ""}{chip.kind === "booked" ? chip.taskName : chip.projectName}
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </Fragment>
                            ))}

                            <div className="sticky left-0 z-10 border-r border-t-2 border-hui-border bg-slate-50 px-3 py-1.5 text-[10px] font-semibold text-slate-500">
                                Free
                            </div>
                            {days.map(day => {
                                const dayKey = formatDate(day);
                                return (
                                    <div
                                        key={`free-${dayKey}`}
                                        className={`border-t-2 border-hui-border px-1 py-1.5 text-center text-[11px] font-semibold text-slate-600 ${isWeekend(day) ? "bg-slate-100" : "bg-slate-50"}`}
                                    >
                                        {freeCountByDay.get(dayKey) ?? 0}
                                    </div>
                                );
                            })}

                            {canSeeFinancials && (
                                <>
                                    <div className="sticky left-0 z-10 border-r border-hui-border bg-slate-50 px-3 py-1.5 text-[10px] font-semibold text-slate-500">
                                        Planned $/day
                                    </div>
                                    {days.map(day => {
                                        const dayKey = formatDate(day);
                                        return (
                                            <div
                                                key={`planned-${dayKey}`}
                                                className={`px-1 py-1.5 text-center text-[11px] font-semibold text-slate-700 ${isWeekend(day) ? "bg-slate-100" : "bg-slate-50"}`}
                                                title="8 paid hrs × burdened rate"
                                            >
                                                {formatCurrency(plannedCostByDay.get(dayKey) ?? 0)}
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
