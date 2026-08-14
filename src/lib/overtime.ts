// Washington state weekly overtime.
//
// WA has no daily overtime — only hours over 40 in a single workweek are paid
// at 1.5x. The workweek is Monday 00:00 through Sunday 23:59:59.999 in company
// local time (America/Los_Angeles by default; see company-timezone.ts).
//
// This module is pure and browser-safe aside from the Date/Intl APIs already
// used by company-day.ts / company-timezone.ts — no prisma import, so it can
// be unit tested without a database and reused from any read-time surface
// (mobile pay-period summary, manager dashboard, future payroll export).
//
// Entries are bucketed into the workweek containing their startTime. An entry
// that spans midnight Sun -> Mon is attributed entirely to the week its punch
// STARTED in (the normal payroll convention) — it is not split across weeks.
// Only the 40-hour threshold splits an entry's hours, because that split is
// what the WA rule actually requires: the hours that push a week's total over
// 40 are OT regardless of which entry they fall in.

import { toCompanyDayKey } from "./company-day";
import { startOfDateInTimeZone } from "./company-timezone";

export const WA_WEEKLY_OVERTIME_THRESHOLD_HOURS = 40;
export const OVERTIME_MULTIPLIER = 1.5;

export type OvertimeTimeEntry = {
    startTime: Date;
    /** Whole hours already computed for this entry (e.g. TimeEntry.durationHours). */
    durationHours: number;
};

export type EntryOvertimeSplit<TEntry extends OvertimeTimeEntry> = {
    entry: TEntry;
    regularHours: number;
    overtimeHours: number;
};

export type WorkweekOvertime<TEntry extends OvertimeTimeEntry = OvertimeTimeEntry> = {
    /** Monday of this workweek, company-local, as a YYYY-MM-DD key. */
    weekStartKey: string;
    /** Instant of Monday 00:00:00.000 company-local. */
    weekStart: Date;
    /** Instant of the following Monday 00:00:00.000 company-local (exclusive upper bound). */
    weekEnd: Date;
    totalHours: number;
    regularHours: number;
    overtimeHours: number;
    entries: EntryOvertimeSplit<TEntry>[];
};

export type WeekPay = {
    regularPay: number;
    overtimePay: number;
    totalPay: number;
    /** Burden cost over the week's total hours. Burden is a flat per-hour cost, not subject to the OT premium. */
    burdenCost: number;
};

/** Round to avoid floating-point noise while keeping sub-hour (e.g. quarter-hour) precision. */
function roundHours(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

function roundCents(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Pure calendar-date arithmetic on a YYYY-MM-DD key — no time zone involved, so DST never applies. */
function addDaysToKey(dayKey: string, days: number): string {
    const [year, month, day] = dayKey.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    utcDate.setUTCDate(utcDate.getUTCDate() + days);
    return utcDate.toISOString().slice(0, 10);
}

/** The Monday (YYYY-MM-DD) of the calendar week containing this day key. */
function mondayKeyFor(dayKey: string): string {
    const [year, month, day] = dayKey.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const dow = utcDate.getUTCDay(); // 0 = Sunday .. 6 = Saturday
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);
    return utcDate.toISOString().slice(0, 10);
}

/**
 * Bucket time entries into Mon-Sun company-local workweeks and compute WA
 * weekly overtime for each week. Entries with non-finite or non-positive
 * durationHours (e.g. still clocked in) are skipped — OT only applies to
 * completed hours.
 */
export function bucketWorkweeks<TEntry extends OvertimeTimeEntry>(
    entries: TEntry[],
    timeZone: string,
): WorkweekOvertime<TEntry>[] {
    const byWeek = new Map<string, TEntry[]>();
    for (const entry of entries) {
        if (!Number.isFinite(entry.durationHours) || entry.durationHours <= 0) continue;
        const dayKey = toCompanyDayKey(entry.startTime);
        if (!dayKey) continue;
        const weekStartKey = mondayKeyFor(dayKey);
        const bucket = byWeek.get(weekStartKey);
        if (bucket) bucket.push(entry);
        else byWeek.set(weekStartKey, [entry]);
    }

    const weeks: WorkweekOvertime<TEntry>[] = [];
    for (const [weekStartKey, weekEntries] of byWeek) {
        // Order matters only for the entry-level split below — the week-level
        // regular/overtime totals are order-independent.
        const sorted = [...weekEntries].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

        let running = 0;
        const splitEntries: EntryOvertimeSplit<TEntry>[] = sorted.map((entry) => {
            const hours = entry.durationHours;
            const hoursBefore = running;
            running += hours;
            const regularHours = roundHours(
                Math.max(0, Math.min(hours, WA_WEEKLY_OVERTIME_THRESHOLD_HOURS - hoursBefore)),
            );
            const overtimeHours = roundHours(hours - regularHours);
            return { entry, regularHours, overtimeHours };
        });

        const totalHours = roundHours(running);
        const regularHours = Math.min(totalHours, WA_WEEKLY_OVERTIME_THRESHOLD_HOURS);
        const overtimeHours = roundHours(Math.max(0, totalHours - WA_WEEKLY_OVERTIME_THRESHOLD_HOURS));

        weeks.push({
            weekStartKey,
            weekStart: startOfDateInTimeZone(weekStartKey, timeZone),
            weekEnd: startOfDateInTimeZone(addDaysToKey(weekStartKey, 7), timeZone),
            totalHours,
            regularHours,
            overtimeHours,
            entries: splitEntries,
        });
    }

    return weeks.sort((a, b) => a.weekStartKey.localeCompare(b.weekStartKey));
}

/**
 * Price a week's regular/overtime hours: regular*rate + overtime*rate*1.5.
 * Burden is charged flat per hour over the week's total — the OT premium
 * only applies to labor, not burden.
 */
export function priceWorkweek(
    week: Pick<WorkweekOvertime, "regularHours" | "overtimeHours">,
    hourlyRate: number,
    burdenRate = 0,
): WeekPay {
    const regularPay = week.regularHours * hourlyRate;
    const overtimePay = week.overtimeHours * hourlyRate * OVERTIME_MULTIPLIER;
    const burdenCost = (week.regularHours + week.overtimeHours) * burdenRate;
    return {
        regularPay: roundCents(regularPay),
        overtimePay: roundCents(overtimePay),
        totalPay: roundCents(regularPay + overtimePay),
        burdenCost: roundCents(burdenCost),
    };
}
