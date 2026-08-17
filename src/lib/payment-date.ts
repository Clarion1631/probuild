/**
 * Money-record date semantics, shared by the server-side notifier
 * (payment-notifications.ts) and the client-side RecordPaymentModal. Must stay
 * free of Prisma/server-only imports — it is bundled into client components.
 *
 * ## The one invariant this file owns
 *
 * `paymentDate` carries DUAL SEMANTICS in a single column: a calendar DAY for
 * manually entered payments, and a real INSTANT for Stripe/QuickBooks-sourced
 * ones. The discriminator is a sentinel — a calendar day is stored as exactly
 * midnight UTC — with `parsePaymentDateInput` as the sole writer and
 * `isDateOnly` as the sole reader. They must agree or a picked day renders as
 * the day before to a Pacific viewer.
 *
 * The sentinel is anchored to **UTC, not the server's timezone**, so it holds
 * identically on Vercel (UTC), in local dev (US/Pacific), and in CI. Producing
 * it with a local-midnight `new Date(y, m, d)` made the discriminator
 * environment-dependent: correct on Vercel by luck, silently reclassifying every
 * manual payment as an instant anywhere else.
 *
 * Both mirrored sides store this column as `timestamptz(6)`, so copying an
 * estimate milestone to its invoice twin (and back) is lossless.
 */

/** Receipts stop auto-sending when the payment date is older than this many calendar days. */
export const BACKDATED_RECEIPT_CUTOFF_DAYS = 3;

const BUSINESS_TZ = "America/Los_Angeles";

// Days-since-epoch for a calendar date (UTC-anchored so the subtraction is exact).
function dayNumber(y: number, m: number, d: number): number {
    return Date.UTC(y, m - 1, d) / 86_400_000;
}

// "Today" as the business's calendar day (America/Los_Angeles), regardless of
// where the server or browser runs. formatToParts avoids any locale-dependent
// assembled-string format assumptions.
function todayDayNumber(now: Date): number {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return dayNumber(get("year"), get("month"), get("day"));
}

/**
 * True when the payment's calendar date is more than BACKDATED_RECEIPT_CUTOFF_DAYS
 * before today (America/Los_Angeles). Calendar-day math, not elapsed-hours, so the
 * answer doesn't flip with the time of day.
 *
 * Accepts a Date (a stored PaymentSchedule.paymentDate — parsePaymentDateInput
 * stores the picked day as midnight in the WRITER's timezone: UTC on Vercel, US-local
 * in dev. Both land inside the same UTC calendar day for US-or-west-of-UTC writers,
 * so the intended day is recovered through the UTC date fields regardless of where
 * this code runs) or a "YYYY-MM-DD" string (the date-picker value in
 * RecordPaymentModal). Null/undefined/invalid input → false (treated as "today",
 * never suppresses).
 */
export function isBackdatedPayment(
    paymentDate: Date | string | null | undefined,
    now: Date = new Date(),
): boolean {
    if (!paymentDate) return false;
    let paymentDay: number;
    if (typeof paymentDate === "string") {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(paymentDate.trim());
        if (!m) return false;
        paymentDay = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
    } else {
        if (isNaN(paymentDate.getTime())) return false;
        paymentDay = dayNumber(
            paymentDate.getUTCFullYear(),
            paymentDate.getUTCMonth() + 1,
            paymentDate.getUTCDate(),
        );
    }
    return todayDayNumber(now) - paymentDay > BACKDATED_RECEIPT_CUTOFF_DAYS;
}

const DEFAULT_DAY_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

/**
 * Parse a payment-date input into the value to store. The SOLE writer of the
 * calendar-day sentinel — `isDateOnly` is its only reader, and the two must agree.
 *
 * - `"YYYY-MM-DD"` (the date picker's value) → **midnight UTC** on that day, which
 *   is what marks it a calendar day. Anchored to UTC rather than the server's zone
 *   so the classification is identical on Vercel, in dev, and in CI.
 * - A full ISO datetime **carrying an explicit `Z` or ±HH:MM offset** (API/Stripe/
 *   QuickBooks callers) → that exact instant, preserved verbatim.
 *
 * An offset-LESS datetime like `"2026-08-04T14:30:00"` is REJECTED, not guessed.
 * ECMAScript parses that form in the host's local zone, so it would store 14:30Z on
 * Vercel and 21:30Z in Pacific dev — the same environment-dependence this module
 * exists to eliminate, but silent. Callers must say which zone they mean.
 *
 * Returns null for anything unparseable, ambiguous, or out of range, so callers can
 * reject rather than silently store a wrong day.
 */
export function parsePaymentDateInput(input: number | string): Date | null {
    if (typeof input === "number") {
        if (!Number.isFinite(input) || input <= 0) return null;
        const d = new Date(input);
        return isNaN(d.getTime()) ? null : d;
    }
    if (typeof input !== "string" || input.trim() === "") return null;
    // Strict YYYY-MM-DD → midnight UTC (primary path from the date picker).
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (ymd) {
        const y = Number(ymd[1]);
        const mo = Number(ymd[2]);
        const d = Number(ymd[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const dt = new Date(Date.UTC(y, mo - 1, d));
        // Rejects overflow like 2026-02-31, which Date.UTC would roll into March.
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
        return dt;
    }
    // Accept full ISO datetimes for API callers, but ONLY with an explicit zone —
    // a trailing Z, or a ±HH:MM / ±HHMM offset. Without one the instant is
    // host-zone-dependent (see the doc comment), so reject instead of guessing.
    if (!/^\d{4}-\d{2}-\d{2}[Tt].+([Zz]|[+-]\d{2}:?\d{2})$/.test(input.trim())) return null;
    const dt = new Date(input);
    return isNaN(dt.getTime()) ? null : dt;
}

/**
 * True when the value carries no time-of-day (exactly 00:00:00.000 UTC) — i.e. it is a
 * stored calendar day, not an instant. Manual payments (parsePaymentDateInput → midnight
 * UTC) land here; Stripe/QuickBooks writes, which store real instants in the same
 * column, do not.
 */
export function isDateOnly(d: Date): boolean {
    return d.getUTCHours() === 0 && d.getUTCMinutes() === 0
        && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/**
 * Render a money-record date for display. Calendar-day values (no time-of-day) render
 * via UTC fields so the picked day survives in any viewer timezone; real instants render
 * in the viewer's local zone. Display-only — never use for math, filtering, or sorting.
 */
export function formatMoneyDate(
    value: Date | string | null | undefined,
    opts: Intl.DateTimeFormatOptions = DEFAULT_DAY_OPTS,
    locale?: string,
): string {
    if (!value) return "";
    const d = typeof value === "string" ? new Date(value) : value;
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(locale, isDateOnly(d) ? { ...opts, timeZone: "UTC" } : opts);
}

/** Same rule, for a month/year grouping label. */
export function formatMoneyMonth(value: Date, locale = "en-US"): string {
    const opts: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };
    return value.toLocaleString(locale, isDateOnly(value) ? { ...opts, timeZone: "UTC" } : opts);
}

/** Month bucket key "YYYY-MM" under the same rule — must agree with formatMoneyMonth. */
export function formatMoneyMonthKey(value: Date): string {
    const y = isDateOnly(value) ? value.getUTCFullYear() : value.getFullYear();
    const m = isDateOnly(value) ? value.getUTCMonth() : value.getMonth();
    return `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" for CSV export, same rule. */
export function formatMoneyDateISO(value: Date): string {
    const y = isDateOnly(value) ? value.getUTCFullYear() : value.getFullYear();
    const m = isDateOnly(value) ? value.getUTCMonth() : value.getMonth();
    const d = isDateOnly(value) ? value.getUTCDate() : value.getDate();
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
