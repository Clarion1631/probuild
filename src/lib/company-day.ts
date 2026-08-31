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

const TIME_PARTS = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
});

/** UTC instant of company-local midnight that starts `dayKey` (YYYY-MM-DD). DST-correct. */
function companyMidnightUtc(dayKey: string): Date {
    const [y, m, d] = dayKey.split("-").map(Number);
    const wanted = Date.UTC(y, m - 1, d, 0, 0, 0);
    // Start from a guess and correct by however far the local wall-clock reading of the
    // guess is from 00:00:00 — converges in one step except across a DST switch, where
    // a second pass lands it.
    let guess = Date.UTC(y, m - 1, d, 8, 0, 0); // Pacific midnight is 07:00Z (PDT) or 08:00Z (PST)
    for (let i = 0; i < 3; i++) {
        const parts = TIME_PARTS.formatToParts(new Date(guess));
        const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
        const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
        const diff = localAsUtc - wanted;
        if (diff === 0) break;
        guess -= diff;
    }
    return new Date(guess);
}

/**
 * Half-open UTC window [start, end) of instants whose company-local day is `dayKey`.
 * `toCompanyDayKey(start) === dayKey`, `toCompanyDayKey(new Date(start - 1)) !== dayKey`,
 * likewise at `end`. Use it to put a company-day condition into a database WHERE
 * (e.g. `createdAt: { gte: start, lt: end }`), which toCompanyDayKey alone cannot do.
 */
export function companyDayBounds(dayKey: string): { start: Date; end: Date } {
    const [y, m, d] = dayKey.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
    return { start: companyMidnightUtc(dayKey), end: companyMidnightUtc(nextKey) };
}

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
