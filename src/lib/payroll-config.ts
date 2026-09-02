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
//   PAYROLL_SALARIED_EMAILS comma-separated emails  (default: CJ + Richard)
//
// PAYROLL_WEEK_START moves the PAY PERIOD boundary only. Washington overtime
// is a property of the Mon-Sun WORKWEEK and is computed in src/lib/overtime.ts,
// which this file never touches: a Sunday-start pay period still splits OT on
// Monday weeks. Do not "unify" the two.
//
// Pure and browser-safe (only imports tz-date.ts) so the review page, the
// export endpoint, and the tests all read the same values.

import { addDaysToKey, daysBetweenDayKeys } from "./tz-date";

export type PayrollPeriodLength = "weekly" | "biweekly";
export type PayrollWeekStart = "monday" | "sunday";

/** DEFAULT pending Justin — see section 7 risk 2 of the Phase 5 spec. */
export const DEFAULT_PAYROLL_PERIOD: PayrollPeriodLength = "biweekly";
/** DEFAULT pending Justin — see section 7 risk 2 of the Phase 5 spec. */
export const DEFAULT_PAYROLL_WEEK_START: PayrollWeekStart = "monday";
/**
 * DEFAULT pending Justin — see section 7 risk 3 of the Phase 5 spec. CJ ($92k)
 * and Richard ($80k) punch the clock for job costing but are paid a salary in
 * Gusto, so their hours must not reach the SUMMARY csv (Gusto would pay them
 * twice). The DETAIL csv keeps them, because job costing still needs the hours.
 */
export const DEFAULT_SALARIED_EMAILS = [
    "cj@goldentouchremodeling.com",
    "rlord@goldentouchremodeling.com",
];

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

/** Lowercased salaried-employee emails. An env value REPLACES the default list; it does not extend it. */
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
