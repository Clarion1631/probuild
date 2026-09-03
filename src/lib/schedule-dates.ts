/**
 * One place for the schedule end-date convention.
 *
 * STORAGE: `ScheduleTask.endDate` is EXCLUSIVE — the day AFTER the last day of
 * work. A one-day task on 9/3 is stored as start 9/3, end 9/4. Dispatch,
 * crew-conflict, bar layout, AI schedule and estimate import all rely on this
 * half-open interval (start <= day < end). Milestones are the exception and
 * keep end == start.
 *
 * DISPLAY: people read "End" as the last day of work (decision 2026-09-02). So
 * every date shown to a user, and every date typed by a user, goes through
 * these two helpers: `displayEndDate` on the way out, `storedEndDate` on the
 * way in. Never do the +1 / -1 by hand at a call site.
 *
 * All inputs are "YYYY-MM-DD" (a full ISO timestamp is tolerated and cut to
 * its date part). All math is in UTC so it is timezone-free.
 */

export type ScheduleTaskKind = "task" | "milestone" | "appointment" | string | null | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateKey(value: string | Date): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value.slice(0, 10);
}

/**
 * Format a YYYY-MM-DD key for display without local-timezone drift. Parsing
 * a bare date string as local time (or via `new Date(key)`) can roll the
 * displayed day backward/forward across a UTC offset boundary; anchoring to
 * midnight UTC and formatting with `timeZone: "UTC"` keeps the calendar date
 * stable regardless of the viewer's timezone.
 */
export function formatDateKey(key: string, options?: Intl.DateTimeFormatOptions, locale = "en-US"): string {
    return new Date(toDateKey(key) + "T00:00:00Z").toLocaleDateString(locale, { timeZone: "UTC", ...options });
}

function parse(key: string): number {
    const [y, m, d] = toDateKey(key).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
}

function format(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysKey(key: string, days: number): string {
    return format(parse(key) + days * DAY_MS);
}

/** Whole days from a to b (b - a); negative when b is before a. */
export function daysBetweenKeys(a: string, b: string): number {
    return Math.round((parse(b) - parse(a)) / DAY_MS);
}

/**
 * Stored (exclusive) end -> the date to SHOW as "End" (last day of work).
 * Milestones show their own date. A legacy row with end <= start (zero-length,
 * created before the convention was enforced) shows as a one-day task.
 */
export function displayEndDate(startDate: string, endDate: string, type?: ScheduleTaskKind): string {
    const start = toDateKey(startDate);
    if (type === "milestone") return start;
    const inclusive = addDaysKey(endDate, -1);
    return inclusive < start ? start : inclusive;
}

/**
 * User-entered "End" (last day of work) -> the value to STORE (exclusive).
 * Milestones store end == start. An End before the Start is NOT repaired
 * here: it converts to a stored end on or before the start, which the
 * server rejects with a validation message the user can act on.
 */
export function storedEndDate(startDate: string, displayEnd: string, type?: ScheduleTaskKind): string {
    if (type === "milestone") return toDateKey(startDate);
    return addDaysKey(toDateKey(displayEnd), 1);
}

/** Working days a stored task covers. A milestone or legacy zero-length row counts as one. */
export function durationDays(startDate: string, endDate: string, type?: ScheduleTaskKind): number {
    if (type === "milestone") return 1;
    return Math.max(1, daysBetweenKeys(startDate, endDate));
}

/**
 * Overdue = the task's last working day is behind us. Tasks: today >= stored
 * (exclusive) end, with a legacy zero-length row treated as one day.
 * Milestones: today is past their day (they are not overdue on the day itself).
 */
export function isTaskOverdue(startDate: string | Date, endDate: string | Date, today: string | Date, type?: ScheduleTaskKind): boolean {
    const start = toDateKey(startDate);
    const todayKey = toDateKey(today);
    if (type === "milestone") return todayKey > start;
    const end = toDateKey(endDate);
    const effectiveEnd = end <= start ? addDaysKey(start, 1) : end;
    return todayKey >= effectiveEnd;
}

/** True when `day` (YYYY-MM-DD) is a working day of the stored task: start <= day < end, milestones on their day. */
export function isTaskOnDay(startDate: string | Date, endDate: string | Date, day: string | Date, type?: ScheduleTaskKind): boolean {
    const start = toDateKey(startDate);
    const d = toDateKey(day);
    if (type === "milestone") return d === start;
    const end = toDateKey(endDate);
    const effectiveEnd = end <= start ? addDaysKey(start, 1) : end;
    return d >= start && d < effectiveEnd;
}
