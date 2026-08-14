// Pure, dependency-free time-zone/date primitives. No prisma import (unlike
// company-timezone.ts, which needs it for resolveCompanyTimeZone()) — this
// module can be imported from anything that must stay unit-testable without a
// database or browser-safe (client components, pure libs like overtime.ts).
//
// company-timezone.ts re-exports the functions here so existing callers of
// dateOnlyInTimeZone / startOfDateInTimeZone / endOfDateInTimeZone /
// dateInputInTimeZone keep working unchanged.

export const DEFAULT_COMPANY_TIME_ZONE = "America/Los_Angeles";

export function validTimeZone(value: string | null | undefined): value is string {
    if (!value?.trim()) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

function wallClockPartsAt(instantMs: number, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(instantMs));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        second: Number(values.second),
    };
}

function offsetAt(instantMs: number, timeZone: string): number {
    const wc = wallClockPartsAt(instantMs, timeZone);
    const representedAsUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
    return representedAsUtc - Math.floor(instantMs / 1000) * 1000;
}

function dateParts(date: string, label: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error(label + " must use YYYY-MM-DD");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        throw new Error(label + " is not a valid calendar date");
    }
    return { year, month, day };
}

/**
 * Search forward in 1-minute steps (small enough to be exact, cheap enough
 * not to matter) for the first instant whose LOCAL calendar date in
 * timeZone equals the target date. Bounded to 6 hours — comfortably past
 * any real-world DST gap (the largest known are ~2h; most are 1h).
 */
function firstInstantOnLocalDate(fromMs: number, year: number, month: number, day: number, timeZone: string): number {
    const STEP_MS = 60_000;
    const MAX_STEPS = 6 * 60;
    let candidate = fromMs;
    for (let step = 0; step <= MAX_STEPS; step += 1) {
        const wc = wallClockPartsAt(candidate, timeZone);
        if (wc.year === year && wc.month === month && wc.day === day) return candidate;
        candidate += STEP_MS;
    }
    // Should be unreachable for any real IANA zone, but return the furthest
    // point searched rather than an instant we never actually checked.
    return candidate;
}

/**
 * Resolve the instant whose LOCAL wall clock (in timeZone) reads the given
 * y/m/d h:m:s.ms. DST-safe via fixed-point iteration on the UTC offset —
 * EXCEPT that iteration assumes the desired wall-clock moment exists at all,
 * which isn't always true: a spring-forward DST transition can skip a whole
 * range of local time. Africa/Casablanca is the sharpest real example —
 * clocks there jump directly from 23:59:59 to 01:00:00, so local midnight
 * never happens on the day a transition lands. Asking this function for
 * 2009-06-01 00:00:00 there, the naive iteration converges to
 * 2009-05-31T23:00:00Z, which reads back as 23:00 on May 31 — the WRONG
 * calendar day, silently.
 *
 * So after the fixed-point iteration, validate the result by formatting it
 * back in timeZone. If it doesn't read back as the exact desired wall clock,
 * the desired moment doesn't exist — search forward for the first instant
 * that at least lands on the correct calendar date, and return that instead
 * of a wrong-day instant.
 */
function resolveWallClockInstant(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number,
    timeZone: string,
): Date {
    const desiredWallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let instant = desiredWallClock;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        instant = desiredWallClock - offsetAt(instant, timeZone);
    }

    // Validate against the NORMALIZED target, not the raw arguments —
    // Date.UTC happily overflows (e.g. day=33 rolls into next month, as
    // addCalendarDaysInTimeZone's `wc.day + days` does routinely), so
    // comparing against un-normalized year/month/day would reject every
    // valid overflowed result and send the search-forward fallback hunting
    // for a calendar date that never occurs.
    const target = new Date(desiredWallClock);
    const targetYear = target.getUTCFullYear();
    const targetMonth = target.getUTCMonth() + 1;
    const targetDay = target.getUTCDate();
    const targetHour = target.getUTCHours();
    const targetMinute = target.getUTCMinutes();
    const targetSecond = target.getUTCSeconds();

    const resolved = wallClockPartsAt(instant, timeZone);
    const matches =
        resolved.year === targetYear &&
        resolved.month === targetMonth &&
        resolved.day === targetDay &&
        resolved.hour === targetHour &&
        resolved.minute === targetMinute &&
        resolved.second === targetSecond;
    if (!matches) {
        instant = firstInstantOnLocalDate(instant, targetYear, targetMonth, targetDay, timeZone);
    }

    return new Date(instant);
}

function instantForWallClock(
    date: string,
    timeZone: string,
    hour: number,
    minute: number,
    second: number,
    millisecond: number,
    label: string,
): Date {
    if (!validTimeZone(timeZone)) throw new Error("Invalid time zone: " + timeZone);
    const { year, month, day } = dateParts(date, label);
    return resolveWallClockInstant(year, month, day, hour, minute, second, millisecond, timeZone);
}

/** Store date-only business values at local noon to preserve their calendar date. */
export function dateOnlyInTimeZone(date: string, timeZone: string): Date {
    return instantForWallClock(date, timeZone, 12, 0, 0, 0, "date");
}

/** The instant of local midnight (00:00:00.000) for a calendar date in the given time zone. */
export function startOfDateInTimeZone(date: string, timeZone: string): Date {
    return instantForWallClock(date, timeZone, 0, 0, 0, 0, "date");
}

export function endOfDateInTimeZone(date: string, timeZone: string): Date {
    return instantForWallClock(date, timeZone, 23, 59, 59, 999, "throughDate");
}

export function dateInputInTimeZone(value: string | Date | null | undefined, timeZone: string, label: string): Date | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return dateOnlyInTimeZone(value, timeZone);
    }
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not a valid date.`);
    return parsed;
}

const dayKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();
function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = dayKeyFormatterCache.get(timeZone);
    if (!formatter) {
        // formatToParts (rather than format) so the result is YYYY-MM-DD
        // regardless of how the runtime's locale data orders en-CA date fields.
        formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
        dayKeyFormatterCache.set(timeZone, formatter);
    }
    return formatter;
}

/** Calendar day an instant falls on in the given time zone. DST-correct. */
export function dayKeyInTimeZone(instant: Date | string, timeZone: string): string {
    const date = typeof instant === "string" ? new Date(instant) : instant;
    if (Number.isNaN(date.getTime())) return "";
    const parts = dayKeyFormatter(timeZone).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Pure calendar-date arithmetic on a YYYY-MM-DD key — no time zone involved, so DST never applies. Accepts negative `days`. */
export function addDaysToKey(dayKey: string, days: number): string {
    const [year, month, day] = dayKey.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    utcDate.setUTCDate(utcDate.getUTCDate() + days);
    return utcDate.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD keys. Date-only, so DST never applies. */
export function daysBetweenDayKeys(from: string, to: string): number {
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return Number.POSITIVE_INFINITY;
    return Math.round((toMs - fromMs) / 86_400_000);
}

/**
 * Advance an instant by N calendar days in the given time zone, preserving its
 * local wall-clock time of day. DST-correct: a day that includes a spring-
 * forward or fall-back transition is 23 or 25 real hours, not a fixed 24 —
 * `new Date(instant.getTime() + days * 86_400_000)` gets this wrong across a
 * transition (e.g. a "weekEnd = weekStart + 7*86_400_000" week boundary lands
 * an hour off local midnight on either side of a DST change).
 */
export function addCalendarDaysInTimeZone(instant: Date, days: number, timeZone: string): Date {
    if (!validTimeZone(timeZone)) throw new Error("Invalid time zone: " + timeZone);
    const wc = wallClockPartsAt(instant.getTime(), timeZone);
    return resolveWallClockInstant(wc.year, wc.month, wc.day + days, wc.hour, wc.minute, wc.second, instant.getUTCMilliseconds(), timeZone);
}
