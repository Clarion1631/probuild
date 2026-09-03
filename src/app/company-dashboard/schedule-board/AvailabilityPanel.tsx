"use client";

import { Fragment } from "react";
import type { CompanyDashboardData, DashboardProjectRow } from "@/lib/schedule-core";
import { addDays, formatCurrency, formatDate, isSameUTCDay, isWeekend, todayUTC } from "@/app/projects/[id]/schedule/schedule-utils";
import {
    buildAvailabilityRows,
    isConflictedDay,
    summarizeCell,
    type AvailabilityChip,
    type AvailabilityMember,
} from "./availability";
import { isDispatchable } from "@/lib/dispatch-roster";
import { displayEndDate } from "@/lib/schedule-dates";

// Planning panel for Richard (ops manager). Pure booked-vs-soft and conflict
// derivation lives in availability.ts so Dispatch can consume the same rules.
const AVAILABILITY_DAYS = 14;
const FAR_JOB_MILES_THRESHOLD = 25;
const PAID_HOURS_PER_DAY = 8;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CAR_GLYPH = "\u{1F697}";
const DAY_COL_WIDTH = 72;
const NARROW_WEEKEND_COL_WIDTH = 36;
const ROW_HEIGHT_PX = 40;

function fullDateLabel(day: Date): string {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(day);
}

function chipTooltip(chip: AvailabilityChip): string {
    const far = (chip.distanceMilesFromShop ?? 0) > FAR_JOB_MILES_THRESHOLD;
    const base = chip.kind === "booked"
        ? `${chip.projectName} — ${chip.taskName} (${chip.startDate} → ${displayEndDate(chip.startDate, chip.endDate, "task")})`
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
    // Rows = the dispatchable roster (FIELD_CREW, plus MANAGER/ADMIN who
    // actually work in the field — Richard, CJ) via the shared rule in
    // dispatch-roster.ts, never FINANCE. teamMembers is already scoped to
    // that roster at serialization; this filter just states the rule.
    const members: AvailabilityMember[] = (teamMembers ?? []).filter(isDispatchable);

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

    // Weekend columns with no booked work anywhere in the visible range
    // collapse narrow so the grid doesn't waste width on days nobody's on —
    // but they stay visible in case a weekend job does show up.
    const dayHasBookedChip = new Map<string, boolean>();
    for (const day of days) {
        const dayKey = formatDate(day);
        dayHasBookedChip.set(dayKey, rows.some(row => (row.chipsByDay.get(dayKey) ?? []).some(chip => chip.kind === "booked")));
    }
    const colWidth = (day: Date) => (isWeekend(day) && !dayHasBookedChip.get(formatDate(day)) ? NARROW_WEEKEND_COL_WIDTH : DAY_COL_WIDTH);
    const gridTemplateColumns = `160px ${days.map(day => `${colWidth(day)}px`).join(" ")}`;
    const gridWidth = 160 + days.reduce((sum, day) => sum + colWidth(day), 0);

    return (
        <div className="border-t border-hui-border">
            <div className="px-4 py-3 border-b border-hui-border">
                <h2 className="text-base font-semibold text-hui-textMain">Crew availability — next 14 days</h2>
                <p className="text-xs text-hui-textMuted mt-1">
                    Solid chip = assigned to a task that day &middot; dot = on the job crew, no task yet &middot; blank
                    = free. {CAR_GLYPH} = the job is far enough from the shop to plan for a longer day. Click a name to
                    see that person&apos;s week on the Timeline.
                </p>
            </div>
            {rows.length === 0 ? (
                <p className="px-4 py-8 text-sm text-hui-textMuted text-center">No field crew to plan yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <div style={{ minWidth: gridWidth }}>
                        <div className="grid" style={{ gridTemplateColumns }}>
                            <div className="sticky left-0 z-10 border-b border-r border-hui-border bg-white px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                Crew
                            </div>
                            {days.map(day => {
                                const isToday = isSameUTCDay(day, today);
                                const narrow = colWidth(day) === NARROW_WEEKEND_COL_WIDTH;
                                return (
                                    <div
                                        key={formatDate(day)}
                                        className={`border-b border-r border-hui-border px-1 py-2 text-center text-[10px] font-semibold ${narrow ? "text-slate-400" : isWeekend(day) ? "bg-slate-100 text-slate-500" : "text-slate-600"} ${isToday ? "bg-indigo-100 text-indigo-700" : ""}`}
                                        title={fullDateLabel(day)}
                                        aria-label={fullDateLabel(day)}
                                    >
                                        <div>{WEEKDAY_LABELS[day.getUTCDay()]}</div>
                                        <div>{day.getUTCMonth() + 1}/{day.getUTCDate()}</div>
                                    </div>
                                );
                            })}

                            {rows.map(row => (
                                <Fragment key={row.userId}>
                                    <div
                                        className="sticky left-0 z-10 flex items-center border-b border-r border-hui-border bg-white px-3"
                                        style={{ minHeight: ROW_HEIGHT_PX }}
                                    >
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
                                        const { booked, overflow, softCount } = summarizeCell(chips);
                                        const conflicted = isConflictedDay(crewConflicts, row.userId, dayKey);
                                        const isToday = isSameUTCDay(day, today);
                                        const cellTitle = booked.length > 0
                                            ? undefined
                                            : softCount > 0
                                                ? `On job crew for ${softCount} job${softCount === 1 ? "" : "s"}, no task assigned`
                                                : "Free";
                                        return (
                                            <div
                                                key={`${row.userId}-${dayKey}`}
                                                className={`relative border-b border-r border-hui-border px-1 py-0.5 ${isWeekend(day) ? "bg-slate-100/60" : ""} ${isToday ? "bg-indigo-50/60" : ""}`}
                                                style={{ minHeight: ROW_HEIGHT_PX }}
                                                title={cellTitle}
                                                aria-label={cellTitle}
                                            >
                                                <div
                                                    className={`flex h-full flex-col justify-center gap-px rounded ${conflicted ? "ring-2 ring-red-500" : ""}`}
                                                >
                                                    {booked.length === 0 && softCount > 0 && (
                                                        <span className="absolute left-1 top-0.5 text-[10px] leading-none text-slate-300" aria-hidden="true">
                                                            &middot;
                                                        </span>
                                                    )}
                                                    {booked.map((chip, i) => {
                                                        const far = (chip.distanceMilesFromShop ?? 0) > FAR_JOB_MILES_THRESHOLD;
                                                        return (
                                                            <span
                                                                key={`${chip.projectId}-${chip.kind}-${i}`}
                                                                className="block truncate rounded px-1 py-px text-[10px] font-semibold leading-tight text-white"
                                                                style={{ backgroundColor: chip.projectColor }}
                                                                title={chipTooltip(chip)}
                                                            >
                                                                {far ? `${CAR_GLYPH} ` : ""}{chip.taskName}
                                                            </span>
                                                        );
                                                    })}
                                                    {overflow > 0 && (
                                                        <span
                                                            className="block truncate rounded bg-slate-500 px-1 py-px text-[10px] font-semibold leading-tight text-white"
                                                            title={`+${overflow} more assignment${overflow === 1 ? "" : "s"} that day`}
                                                        >
                                                            +{overflow}
                                                        </span>
                                                    )}
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
