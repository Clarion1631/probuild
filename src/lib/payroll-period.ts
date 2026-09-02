// Pay-period locks.
//
// Once payroll has been exported for a period and a human has locked it, the
// hours behind that export must stop moving — otherwise ProBuild and Gusto
// silently disagree about a period that was already paid.
//
// EVERY writer that can change how many payroll hours a period holds is gated.
// The canonical list lives in tests/payroll-period-lock.test.ts (the writer
// tripwire) — keep the two in step. Route handlers use assertPeriodUnlocked()
// and answer 423; server actions use assertPeriodUnlockedOrThrow() because an
// action has no response object to shape:
//
//   PUT    /api/time-entries              (clock-out: existing.startTime)
//   POST   /api/time-entries              (clock-in: the client may supply startTime)
//   PATCH  /api/time-entries/[id]         (edit: BOTH the old and the new startTime —
//                                          an edit that MOVES a punch into a locked
//                                          period is as much a violation as one that
//                                          edits a punch already inside it)
//   DELETE /api/time-entries/[id]         (existing.startTime)
//   lib/time-expense-core createTimeEntryCore        (creating hours AT a date is
//                                          moving hours INTO that period)
//   lib/time-expense-actions update/delete/deleteMany
//   app/projects/[id]/timeclock/actions create/update/delete
//
// Deliberately NOT gated, because they cannot change a period's hours: writers
// that only touch flags, notes, cost coding, change-order tags or billing
// stamps (markTimeEntryReviewed, meal-skip decisions, logistics routing and
// re-coding, the invoice claim in billing-core). settleDay() is not gated
// directly either — it is only reachable through the gated routes above and
// through the export preamble, which refuses to settle any day that falls in a
// locked period.
//
// A blocked write answers 423 Locked with code PERIOD_LOCKED. 423 rather than
// 409/403 because the row is fine and the caller is authorized — the resource
// is simply frozen, which is exactly what 423 means.
//
// TIME OF CHECK vs TIME OF USE: the check is not a transaction. A period can be
// locked between the check and the write, so the hot routes check AGAIN
// immediately before the write call. That narrows the window; it does not close
// it, and the lock action's own transaction (lockPayrollPeriod) is what
// actually detects a period that moved underneath it.
//
// The range is HALF-OPEN, [periodStart, periodEnd): an instant exactly equal
// to periodEnd belongs to the NEXT period. Two adjacent periods can therefore
// never both claim the same punch.
//
// `lockedAt == null` means the row exists (the period has been reviewed) but is
// NOT frozen — unlock keeps the row and its exportHash for the audit trail.

import { NextResponse } from "next/server";
import { COMPANY_TIME_ZONE } from "./company-day";
import { dayKeyInTimeZone, addDaysToKey } from "./tz-date";
import { payrollLockEnvelope, type PayrollWeekStart } from "./payroll-config";

export type LockedPeriodRow = {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    lockedAt: Date | null;
};

/** Loader for the candidate periods. Injectable so the lock rules can be tested without a database. */
export type LockedPeriodLoader = () => Promise<LockedPeriodRow[]>;

/**
 * The LOCKED period that freezes `instant`, or null. Pure — this is the whole
 * rule, and every caller shares it.
 *
 * The comparison is against the period's WORKWEEK ENVELOPE, not its literal
 * [periodStart, periodEnd) range (see payrollLockEnvelope). An entry in the same
 * workweek as a locked period, but outside the period itself, still decides how
 * much of that period's time is overtime — so editing it changes numbers that
 * were already exported and paid. Freezing the period alone was not enough.
 */
export function lockedPeriodFor(
    periods: LockedPeriodRow[],
    instant: Date | null | undefined,
    options: { timeZone?: string; weekStart?: PayrollWeekStart } = {}
): LockedPeriodRow | null {
    if (!instant || Number.isNaN(instant.getTime())) return null;
    const timeZone = options.timeZone ?? COMPANY_TIME_ZONE;
    const at = instant.getTime();
    for (const period of periods) {
        if (!period.lockedAt) continue;
        const envelope = payrollLockEnvelope(period.periodStart, period.periodEnd, timeZone, options.weekStart);
        if (at >= envelope.start.getTime() && at < envelope.end.getTime()) return period;
    }
    return null;
}

/** Inclusive company-local day keys for display — periodEnd is exclusive, so the last DAY is the day before it. */
export function periodDisplayRange(period: Pick<LockedPeriodRow, "periodStart" | "periodEnd">): {
    startKey: string;
    lastDayKey: string;
} {
    const startKey = dayKeyInTimeZone(period.periodStart, COMPANY_TIME_ZONE);
    const endKeyExclusive = dayKeyInTimeZone(period.periodEnd, COMPANY_TIME_ZONE);
    return { startKey, lastDayKey: addDaysToKey(endKeyExclusive, -1) };
}

export function periodLockedMessage(period: Pick<LockedPeriodRow, "periodStart" | "periodEnd">): string {
    const { startKey, lastDayKey } = periodDisplayRange(period);
    return `Payroll for ${startKey} to ${lastDayKey} is locked, including the rest of the workweeks it touches — overtime is worked out per week, so a punch just outside the period still changes what was paid inside it. An admin has to unlock that period before this entry can change.`;
}

export const PERIOD_LOCKED_CODE = "PERIOD_LOCKED";

export function periodLockedResponse(period: LockedPeriodRow): NextResponse {
    return NextResponse.json(
        {
            error: periodLockedMessage(period),
            code: PERIOD_LOCKED_CODE,
            periodStart: period.periodStart.toISOString(),
            periodEnd: period.periodEnd.toISOString(),
        },
        { status: 423 }
    );
}

/** Default loader — every locked period. The table holds one row per reviewed period, so this stays tiny. */
export async function loadLockedPeriods(): Promise<LockedPeriodRow[]> {
    const { prisma } = await import("./prisma");
    return prisma.payrollPeriod.findMany({
        where: { lockedAt: { not: null } },
        select: { id: true, periodStart: true, periodEnd: true, lockedAt: true },
    });
}

/**
 * Returns a 423 response when ANY of `instants` falls inside a locked period,
 * else null. Callers pass every startTime the write could touch — for an edit
 * that means the stored one AND the new one.
 *
 *   const locked = await assertPeriodUnlocked([existing.startTime, newStart]);
 *   if (locked) return locked;
 */
export async function assertPeriodUnlocked(
    instants: Array<Date | null | undefined>,
    loader: LockedPeriodLoader = loadLockedPeriods
): Promise<NextResponse | null> {
    const candidates = instants.filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
    if (candidates.length === 0) return null;
    const periods = await loader();
    if (periods.length === 0) return null;
    for (const instant of candidates) {
        const period = lockedPeriodFor(periods, instant);
        if (period) return periodLockedResponse(period);
    }
    return null;
}

/**
 * Server-action variant. Actions have no response object to shape, and a
 * thrown Error is how every other guard in actions.ts / time-expense-actions.ts
 * refuses — returning a value would be silently ignored by the callers, which
 * is exactly how a guard becomes decorative.
 *
 * Same rule, same loader, same message as assertPeriodUnlocked; only the
 * failure shape differs.
 */
export async function assertPeriodUnlockedOrThrow(
    instants: Array<Date | null | undefined>,
    loader: LockedPeriodLoader = loadLockedPeriods
): Promise<void> {
    const candidates = instants.filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
    if (candidates.length === 0) return;
    const periods = await loader();
    if (periods.length === 0) return;
    for (const instant of candidates) {
        const period = lockedPeriodFor(periods, instant);
        if (period) throw new Error(periodLockedMessage(period));
    }
}
