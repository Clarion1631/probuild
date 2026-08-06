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
// where the server or browser runs. en-CA formats as YYYY-MM-DD.
function todayDayNumber(now: Date): number {
    const ymd = new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now);
    const [y, m, d] = ymd.split("-").map(Number);
    return dayNumber(y, m, d);
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
