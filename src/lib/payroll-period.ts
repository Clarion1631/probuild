// Pay-period locks.
//
// Once payroll has been exported for a period and a human has locked it, the
// hours behind that export must stop moving — otherwise ProBuild and Gusto
// silently disagree about a period that was already paid. Every write path
// that can change WHICH period an entry belongs to, or how many hours it
// carries, goes through assertPeriodUnlocked():
//
//   PUT    /api/time-entries          (clock-out: existing.startTime)
//   PATCH  /api/time-entries/[id]     (edit: BOTH the old and the new startTime —
//                                      an edit that MOVES a punch into a locked
//                                      period is just as much a violation as one
//                                      that edits a punch already inside it)
//   DELETE /api/time-entries/[id]     (existing.startTime)
//
// A blocked write answers 423 Locked with code PERIOD_LOCKED. 423 rather than
// 409/403 because the row is fine and the caller is authorized — the resource
// is simply frozen, which is exactly what 423 means.
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

export type LockedPeriodRow = {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    lockedAt: Date | null;
};

/** Loader for the candidate periods. Injectable so the lock rules can be tested without a database. */
export type LockedPeriodLoader = () => Promise<LockedPeriodRow[]>;

/**
 * The LOCKED period whose half-open [periodStart, periodEnd) range contains
 * `instant`, or null. Pure — this is the whole rule, and every caller shares it.
 */
export function lockedPeriodFor(
    periods: LockedPeriodRow[],
    instant: Date | null | undefined
): LockedPeriodRow | null {
    if (!instant || Number.isNaN(instant.getTime())) return null;
    const at = instant.getTime();
    for (const period of periods) {
        if (!period.lockedAt) continue;
        if (at >= period.periodStart.getTime() && at < period.periodEnd.getTime()) return period;
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
    return `Payroll for ${startKey} to ${lastDayKey} is locked. An admin has to unlock that period before this entry can change.`;
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
async function loadLockedPeriods(): Promise<LockedPeriodRow[]> {
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
