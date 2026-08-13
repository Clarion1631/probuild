/**
 * Back-dated payment classification, shared by the server-side notifier
 * (payment-notifications.ts) and the client-side RecordPaymentModal. Must stay
 * free of Prisma/server-only imports — it is bundled into client components.
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
 * True when the value carries no time-of-day (exactly 00:00:00.000 UTC) — i.e. it is a
 * stored calendar day, not an instant. Manual payments (parsePaymentDateInput → local
 * midnight, UTC on Vercel) land here; Stripe/QuickBooks writes, which store real
 * instants in the same column, do not.
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
