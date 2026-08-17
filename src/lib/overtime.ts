// Washington state weekly overtime.
//
// WA has no daily overtime — only hours over 40 in a single workweek are paid
// at 1.5x. The workweek is Monday 00:00 through Sunday 23:59:59.999 in the
// caller-supplied time zone (company default: America/Los_Angeles).
//
// This module is pure and browser-safe — it only imports src/lib/tz-date.ts
// (no prisma, no Next.js), so it can be unit tested without a database and
// reused from any read-time surface (mobile pay-period summary, manager
// dashboard, future payroll export). It does NOT import company-day.ts,
// which hardcodes America/Los_Angeles — every date computation here honors
// the `timeZone` parameter the caller passes in.
//
// Entries are bucketed into the workweek containing their startTime. An entry
// that spans midnight Sun -> Mon is attributed entirely to the week its punch
// STARTED in (the normal payroll convention) — it is not split across weeks.
// Only the 40-hour threshold splits an entry's hours, because that split is
// what the WA rule actually requires: the hours that push a week's total over
// 40 are OT regardless of which entry they fall in.

import { addDaysToKey, dayKeyInTimeZone, startOfDateInTimeZone } from "./tz-date";

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
    /** Monday of this workweek, in the caller's time zone, as a YYYY-MM-DD key. */
    weekStartKey: string;
    /** Instant of Monday 00:00:00.000 in the caller's time zone. */
    weekStart: Date;
    /** Instant of the following Monday 00:00:00.000 in the caller's time zone (exclusive upper bound). */
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

/**
 * Round a dollar amount to the nearest cent, as an integer number of cents.
 * Corrects for binary floating-point REPRESENTATION error (e.g. `1.005 * 100`
 * evaluates to `100.49999999999999`, not `100.5`) before the half-up round —
 * otherwise a genuine half-cent value rounds down instead of up.
 *
 * The correction has to be scaled to the value's own floating-point
 * precision (an ULP-relative epsilon), not a fixed decimal snap: an earlier
 * version used `toFixed(4)`, which overcorrects — it also bumps a REAL
 * (non-representation-error) near-half-cent value like 1.0049999 up to
 * 100.5000 and wrongly rounds it to 101 instead of the correct 100.
 * `Number.EPSILON * 4` nudges only by a few times the smallest possible
 * float gap near the value, enough to cancel representation noise (typically
 * ~1e-14 relative) without touching a difference as large as 1.0049999 vs
 * 1.005 (~1e-7 relative).
 *
 * All money math in this module goes through integer cents and is only
 * converted back to dollars at the very end, so a total built from several
 * rounded parts (e.g. totalPay) is always exactly the sum of those parts —
 * never off by a cent from independently re-rounding the unrounded sum.
 */
export function roundToCents(dollars: number): number {
    return Math.round(dollars * 100 * (1 + Number.EPSILON * 4));
}

export function centsToDollars(cents: number): number {
    return cents / 100;
}

/** The Monday (YYYY-MM-DD, in the given time zone) of the calendar week containing this day key. */
function mondayKeyFor(dayKey: string): string {
    const [year, month, day] = dayKey.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const dow = utcDate.getUTCDay(); // 0 = Sunday .. 6 = Saturday
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    return addDaysToKey(dayKey, -daysSinceMonday);
}

/** The Monday (YYYY-MM-DD, in the given time zone) of the workweek containing this instant. */
export function workweekStartKey(instant: Date, timeZone: string): string {
    return mondayKeyFor(dayKeyInTimeZone(instant, timeZone));
}

/**
 * Bucket time entries into Mon-Sun workweeks (in the given time zone) and
 * compute WA weekly overtime for each week. Entries with non-finite or
 * non-positive durationHours (e.g. still clocked in) are skipped — OT only
 * applies to completed hours.
 */
export function bucketWorkweeks<TEntry extends OvertimeTimeEntry>(
    entries: TEntry[],
    timeZone: string,
): WorkweekOvertime<TEntry>[] {
    const byWeek = new Map<string, TEntry[]>();
    for (const entry of entries) {
        if (!Number.isFinite(entry.durationHours) || entry.durationHours <= 0) continue;
        const dayKey = dayKeyInTimeZone(entry.startTime, timeZone);
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
 * Price a week's regular/overtime hours at a SINGLE (typically the user's
 * current) hourly rate: regular*rate + overtime*rate*1.5. Burden is charged
 * flat per hour over the week's total — the OT premium only applies to
 * labor, not burden.
 *
 * Use this for current-rate estimates (e.g. an at-a-glance dashboard). For
 * payroll-accurate pricing of historical entries, where the rate may have
 * changed since the entry was worked, use priceEntrySplits instead — it
 * prices each entry at its OWN historical rate.
 */
export function priceWorkweek(
    week: Pick<WorkweekOvertime, "regularHours" | "overtimeHours">,
    hourlyRate: number,
    burdenRate = 0,
): WeekPay {
    const regularCents = roundToCents(week.regularHours * hourlyRate);
    const overtimeCents = roundToCents(week.overtimeHours * hourlyRate * OVERTIME_MULTIPLIER);
    const burdenCents = roundToCents((week.regularHours + week.overtimeHours) * burdenRate);
    return {
        regularPay: centsToDollars(regularCents),
        overtimePay: centsToDollars(overtimeCents),
        totalPay: centsToDollars(regularCents + overtimeCents),
        burdenCost: centsToDollars(burdenCents),
    };
}

export type EntryPay<TEntry extends OvertimeTimeEntry> = EntryOvertimeSplit<TEntry> & {
    hourlyRate: number;
    /** "entry" = priced at this entry's own stored historical rate; "fallback" = the caller had no reliable stored rate and used a substitute (e.g. the user's current rate). */
    rateSource: "entry" | "fallback";
    regularPay: number;
    overtimePay: number;
};

/**
 * Price entry-level regular/OT splits, each at its OWN rate via
 * `rateForEntry` — this is what makes pay-period pricing historically
 * accurate: a rate change made today must not rewrite what an entry earned
 * last month. `rateForEntry` decides per entry whether a genuine historical
 * rate is available ("entry") or it had to fall back to something else
 * ("fallback", e.g. the user's current rate for a legacy row with no stored
 * labor cost) — callers surface that provenance rather than hiding it.
 */
export function priceEntrySplits<TEntry extends OvertimeTimeEntry>(
    splits: EntryOvertimeSplit<TEntry>[],
    rateForEntry: (entry: TEntry) => { hourlyRate: number; rateSource: "entry" | "fallback" },
): EntryPay<TEntry>[] {
    return splits.map((split) => {
        const { hourlyRate, rateSource } = rateForEntry(split.entry);
        return {
            ...split,
            hourlyRate,
            rateSource,
            regularPay: centsToDollars(roundToCents(split.regularHours * hourlyRate)),
            overtimePay: centsToDollars(roundToCents(split.overtimeHours * hourlyRate * OVERTIME_MULTIPLIER)),
        };
    });
}

/** Sum a list of already-priced entries into a total that's exactly the sum of its parts (integer-cent arithmetic — no float drift). */
export function sumEntryPay(entries: Array<Pick<EntryPay<OvertimeTimeEntry>, "regularPay" | "overtimePay">>): {
    regularPay: number;
    overtimePay: number;
    totalPay: number;
} {
    const regularCents = entries.reduce((sum, e) => sum + roundToCents(e.regularPay), 0);
    const overtimeCents = entries.reduce((sum, e) => sum + roundToCents(e.overtimePay), 0);
    return {
        regularPay: centsToDollars(regularCents),
        overtimePay: centsToDollars(overtimeCents),
        totalPay: centsToDollars(regularCents + overtimeCents),
    };
}

/** Flat per-hour burden cost (never OT-multiplied) for a set of entry splits, each at its own burden rate via `burdenRateForEntry`. */
export function priceEntryBurden<TEntry extends OvertimeTimeEntry>(
    splits: EntryOvertimeSplit<TEntry>[],
    burdenRateForEntry: (entry: TEntry) => number,
): number {
    const cents = splits.reduce((sum, split) => {
        const hours = split.regularHours + split.overtimeHours;
        return sum + roundToCents(hours * burdenRateForEntry(split.entry));
    }, 0);
    return centsToDollars(cents);
}
