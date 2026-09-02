// Payroll period configuration.
//
// ⚠ EVERY VALUE IN THIS FILE IS A DEFAULT PENDING JUSTIN'S DECISION.
// docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md section 7 lists three
// open HUMAN DECISION items (pay period definition, who is salaried in Gusto,
// which Gusto tier). None of them block the build — the export endpoint and
// PayrollPeriod both take an ARBITRARY [start, end) range — so they live here
// as env-overridable defaults instead of as hardcoded guesses scattered
// through the UI. Change them with an env var, not a code edit:
//
//   PAYROLL_PERIOD          "weekly" | "biweekly"   (default: biweekly)
//   PAYROLL_WEEK_START      "monday" | "sunday"     (default: monday)
//   PAYROLL_SALARIED_EMAILS comma-separated emails  (default: EMPTY — nobody)
//
// PAYROLL_WEEK_START moves the PAY PERIOD boundary only. Washington overtime
// is a property of the Mon-Sun WORKWEEK and is computed in src/lib/overtime.ts,
// which this file never touches: a Sunday-start pay period still splits OT on
// Monday weeks. Do not "unify" the two.
//
// Pure and browser-safe (only imports tz-date.ts) so the review page, the
// export endpoint, and the tests all read the same values.

import { addDaysToKey, daysBetweenDayKeys, dayKeyInTimeZone, startOfDateInTimeZone } from "./tz-date";
import { workweekStartKey } from "./overtime";

export type PayrollPeriodLength = "weekly" | "biweekly";
export type PayrollWeekStart = "monday" | "sunday";

/** DEFAULT pending Justin — see section 7 risk 2 of the Phase 5 spec. */
export const DEFAULT_PAYROLL_PERIOD: PayrollPeriodLength = "biweekly";
/** DEFAULT pending Justin — see section 7 risk 2 of the Phase 5 spec. */
export const DEFAULT_PAYROLL_WEEK_START: PayrollWeekStart = "monday";
/**
 * NOBODY, unless an operator says so.
 *
 * A salaried person's hours must not reach the SUMMARY csv (Gusto pays them a
 * salary AND would pay the exported hours). This list used to default to two
 * named employees, which meant the code decided, on nobody's authority, that
 * two specific humans were salaried.
 *
 * That guess fails OPEN in the direction that loses money for the worker: if
 * either had actually been hourly, their hours would have been silently dropped
 * from the pay run. An empty default fails CLOSED instead — nobody is exempt,
 * everybody's hours are exported, and a genuinely salaried person is excluded
 * only once PAYROLL_SALARIED_EMAILS names them. The payType column is the
 * durable answer; this env var is the override.
 */
export const DEFAULT_SALARIED_EMAILS: string[] = [];

/**
 * Anchor day the repeating period grid is measured from. 2026-01-05 is a
 * Monday and 2026-01-04 the Sunday before it, so a period boundary always
 * lands on the configured week start. Not env-configurable: the grid's PHASE
 * only matters for the /manager/payroll-export default, and the endpoint
 * accepts any explicit range.
 */
const ANCHOR_BY_WEEK_START: Record<PayrollWeekStart, string> = {
    monday: "2026-01-05",
    sunday: "2026-01-04",
};

function readEnv(name: string): string | undefined {
    const raw = process.env[name];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
}

export function payrollPeriodLength(): PayrollPeriodLength {
    const raw = readEnv("PAYROLL_PERIOD")?.toLowerCase();
    return raw === "weekly" || raw === "biweekly" ? raw : DEFAULT_PAYROLL_PERIOD;
}

export function payrollWeekStart(): PayrollWeekStart {
    const raw = readEnv("PAYROLL_WEEK_START")?.toLowerCase();
    return raw === "monday" || raw === "sunday" ? raw : DEFAULT_PAYROLL_WEEK_START;
}

/**
 * Lowercased salaried-employee emails, from PAYROLL_SALARIED_EMAILS only.
 *
 * Unset means an EMPTY set — nobody is exempt from the summary csv. There is no
 * hardcoded fallback: see DEFAULT_SALARIED_EMAILS for why guessing here fails in
 * the direction that silently underpays somebody.
 */
export function salariedEmails(): string[] {
    const raw = readEnv("PAYROLL_SALARIED_EMAILS");
    const list = raw ? raw.split(",") : DEFAULT_SALARIED_EMAILS;
    return list.map((email) => email.trim().toLowerCase()).filter(Boolean);
}

/** True when this member is paid a salary in Gusto and must be excluded from the SUMMARY csv. */
export function isSalariedEmail(email: string | null | undefined, salaried = salariedEmails()): boolean {
    if (!email) return false;
    return salaried.includes(email.trim().toLowerCase());
}

export function payrollPeriodDays(length = payrollPeriodLength()): number {
    return length === "weekly" ? 7 : 14;
}

/** Longest range a pay period may cover. Shared by the export endpoint, the lock action and the review page so none of them can accept a range another would refuse. */
export const MAX_PAYROLL_RANGE_DAYS = 62;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real YYYY-MM-DD calendar day — "2026-02-31" and "2026-1-5" are both rejected. */
export function isDayKey(value: unknown): value is string {
    if (typeof value !== "string" || !DAY_KEY_PATTERN.test(value)) return false;
    // Round-trip through UTC: Date normalises 2026-02-31 to 2026-03-03, so a
    // value that does not come back identical was never a real calendar day.
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export type PayrollRangeCheck =
    | { ok: true; startKey: string; endKey: string; days: number }
    | { ok: false; error: string };

/**
 * The ONE validator for a payroll range. `endKey` is EXCLUSIVE (the day after
 * the last day), matching PayrollPeriod and the export endpoint.
 *
 * Shared rather than re-typed at each call site: a lock that covers a range the
 * download refuses, or a page that renders one, is a period nobody can actually
 * reproduce.
 */
export function validatePayrollRange(startKey: unknown, endKey: unknown): PayrollRangeCheck {
    if (!isDayKey(startKey) || !isDayKey(endKey)) {
        return { ok: false, error: "Pick a valid period (YYYY-MM-DD, with the end date exclusive)." };
    }
    const days = daysBetweenDayKeys(startKey, endKey);
    if (!Number.isFinite(days) || days <= 0) {
        return { ok: false, error: "The end of the period must be after its start." };
    }
    if (days > MAX_PAYROLL_RANGE_DAYS) {
        return { ok: false, error: `A pay period cannot be longer than ${MAX_PAYROLL_RANGE_DAYS} days.` };
    }
    return { ok: true, startKey, endKey, days };
}

/**
 * THE INFLUENCE WINDOW — the range a lock has to freeze.
 *
 * Overtime is allocated chronologically across a Mon-Sun workweek: the hours
 * that push a week past 40 are the LATER ones. So influence runs in exactly one
 * direction. An entry BEFORE the period, in the same workweek as periodStart,
 * changes how much of the period's time is overtime — deleting Monday's 10
 * hours turns Friday's overtime back into regular time. An entry AFTER
 * periodEnd cannot do that: it lands later in the walk and only ever affects
 * itself and its successors.
 *
 * The window is therefore [start of the workweek containing periodStart,
 * periodEnd) — backward to the week boundary, and NOT ONE DAY past periodEnd.
 *
 * Reaching forward as well was wrong twice over: it froze days that no locked
 * number depends on, and it made two adjacent periods overlap at the seam, so
 * the second of two consecutive periods could be neither exported nor locked.
 */
export function payrollLockEnvelope(
    periodStart: Date,
    periodEnd: Date,
    timeZone: string
): { start: Date; end: Date } {
    const startKey = workweekStartKey(periodStart, timeZone);
    return {
        start: startOfDateInTimeZone(startKey, timeZone),
        // Never past the period: later hours cannot change earlier ones.
        end: periodEnd,
    };
}

/**
 * The most recent FULLY ELAPSED pay period containing no part of `todayKey`,
 * as half-open day keys `[startKey, endKey)`. Used only as the default
 * selection on /manager/payroll-export — the user can pick any range.
 */
export function lastFullPayPeriod(
    todayKey: string,
    options: { length?: PayrollPeriodLength; weekStart?: PayrollWeekStart } = {}
): { startKey: string; endKey: string } {
    const length = options.length ?? payrollPeriodLength();
    const weekStart = options.weekStart ?? payrollWeekStart();
    const days = payrollPeriodDays(length);
    const anchor = ANCHOR_BY_WEEK_START[weekStart];

    // Floor division (not trunc) so day keys before the anchor still land on a
    // grid boundary instead of rounding toward it.
    const elapsed = daysBetweenDayKeys(anchor, todayKey);
    const index = Math.floor(elapsed / days);
    const currentStart = addDaysToKey(anchor, index * days);
    return { startKey: addDaysToKey(currentStart, -days), endKey: currentStart };
}
