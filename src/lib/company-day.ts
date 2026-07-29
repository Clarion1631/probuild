// Company-local calendar days. Browser-safe: no prisma, no server-only imports —
// the evidence classifiers that use this render in client components.
//
// The board's day keys are calendar days ("YYYY-MM-DD" compared lexically, see
// isTaskActiveOnDay). Timestamps are instants. Converting an instant with
// `.toISOString().slice(0,10)` silently uses the UTC day, which is WRONG for
// this company for most of the working evening: a 7pm PDT punch on the 27th
// serializes as the 28th, which both inflates freshness by a day and fires
// false "work logged past the scheduled end" contradictions.

// Kept in sync with DEFAULT_COMPANY_TIME_ZONE in company-timezone.ts, which is
// the server-side configurable source (CompanySettings.timeZone -> env ->
// default). That module is NOT importable here: it imports prisma at the top,
// and these classifiers render in client components. If the company ever moves
// off the default, this constant has to move with it.
export const COMPANY_TIME_ZONE = "America/Los_Angeles";

// formatToParts (rather than format) so the result is YYYY-MM-DD regardless of
// how the runtime's locale data orders en-CA date fields.
const DAY_PARTS = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

/** Calendar day an instant falls on in company-local time. DST-correct. */
export function toCompanyDayKey(instant: Date | string): string {
    const date = typeof instant === "string" ? new Date(instant) : instant;
    if (Number.isNaN(date.getTime())) return "";
    const parts = DAY_PARTS.formatToParts(date);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Interpret a date-only string (an `<input type="date">` value) as that calendar
 * day, verbatim.
 *
 * `new Date("2026-07-27")` is UTC midnight, which is 2026-07-26 in company time
 * — so deriving the day from the instant moves every manually-entered timesheet
 * row to the previous day. Manual entry surfaces must use this instead.
 */
export function dayKeyFromDateOnly(value: string): string {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return match ? match[1] : toCompanyDayKey(new Date(value));
}

/** Whole days between two YYYY-MM-DD keys. Date-only, so DST never applies. */
export function daysBetweenDayKeys(from: string, to: string): number {
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return Number.POSITIVE_INFINITY;
    return Math.round((toMs - fromMs) / 86_400_000);
}
