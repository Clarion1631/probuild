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
    /**
     * The IANA zone this period was LOCKED in. Enforcement uses it in
     * preference to whatever the company zone resolves to today: the workweek
     * envelope is derived from a time zone, so re-deriving it after a
     * CompanySettings.timeZone change would silently move the boundaries of a
     * period that was already paid. Null on rows written before the column
     * existed — those fall back to the resolved company zone.
     */
    timeZone?: string | null;
};

/** Advisory-lock key. ONE key for the whole payroll-period mechanism — see acquirePayrollWriteLock. */
export const PAYROLL_ADVISORY_LOCK_KEY = "payroll-period";

/** Minimal shape of a Prisma transaction client — kept structural so tests can inject a fake. */
export type PayrollTxClient = {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    /** Non-generic on purpose: a generic signature makes every test fake fail to structurally match. */
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    payrollPeriod: { findMany(args: unknown): Promise<LockedPeriodRow[]> };
};

/** Thrown by the in-transaction assertion so a server action refuses the same way every other guard does. */
export class PeriodLockedError extends Error {
    readonly period: LockedPeriodRow;
    constructor(period: LockedPeriodRow) {
        super(periodLockedMessage(period));
        this.name = "PeriodLockedError";
        this.period = period;
    }
}

export function isPeriodLockedError(error: unknown): error is PeriodLockedError {
    return error instanceof Error && error.name === "PeriodLockedError";
}

/**
 * SHARED advisory lock, taken by every hours WRITER inside its own write
 * transaction, immediately before it checks the lock.
 *
 * Why an advisory lock at all: the check and the write are two statements, and
 * "is this period locked?" reads a DIFFERENT row from the one being written, so
 * no row lock can serialize them. Two connections could therefore interleave as
 *   writer: check (unlocked) -> locker: insert lock, recompute -> writer: write
 * and the locked period's stored exportHash would describe hours that changed
 * immediately afterwards. Postgres advisory locks are the standard answer for
 * serializing against a predicate rather than a row.
 *
 * Shared, not exclusive, because writers do not conflict with EACH OTHER here —
 * only with a lock being created. Concurrent clock-outs stay concurrent.
 *
 * `pg_advisory_xact_lock*` releases at COMMIT or ROLLBACK, so there is no leak
 * path: it cannot outlive the transaction even if the handler throws.
 */
export async function acquirePayrollWriteLock(tx: PayrollTxClient): Promise<void> {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, PAYROLL_ADVISORY_LOCK_KEY);
}

/**
 * EXCLUSIVE advisory lock, taken by lock CREATION inside its transaction before
 * it inserts or recomputes. It waits for every in-flight writer holding the
 * shared lock, and blocks new ones until the lock row is committed.
 *
 * It also serializes two concurrent lock creations against each other, which is
 * what makes the overlapping-period check (a predicate over rows that may not
 * exist yet) actually sound — SELECT ... FOR UPDATE cannot lock a row nobody
 * has inserted.
 */
export async function acquirePayrollLockCreationLock(tx: PayrollTxClient): Promise<void> {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, PAYROLL_ADVISORY_LOCK_KEY);
}

/**
 * Refuse to re-settle a company-local DAY that falls inside a locked period.
 *
 * WA meal settlement rewrites durationHours, laborCost and burdenCost for a
 * whole day. It runs after a clock-out or an edit, and it is the one payroll
 * write that is not initiated by a user touching that specific row — so it
 * needs its own guard, under the same shared advisory lock, inside the same
 * transaction as the write that triggered it.
 *
 * `dayKey` is interpreted in the caller's zone; a locked period is still
 * evaluated in the zone it was locked in (see lockedPeriodFor).
 */
export async function assertDayUnlockedInTx(
    tx: PayrollTxClient,
    dayKey: string,
    timeZone: string,
    options: { weekStart?: PayrollWeekStart } = {}
): Promise<void> {
    if (!dayKey) return;
    await acquirePayrollWriteLock(tx);
    const periods = await loadLockedPeriodsTx(tx);
    if (periods.length === 0) return;
    const { startOfDateInTimeZone } = await import("./tz-date");
    const period = lockedPeriodFor(periods, startOfDateInTimeZone(dayKey, timeZone), { timeZone, ...options });
    if (period) throw new PeriodLockedError(period);
}

/** Locked periods read THROUGH a transaction client, so the check sees the same snapshot as the write. */
export async function loadLockedPeriodsTx(tx: PayrollTxClient): Promise<LockedPeriodRow[]> {
    return tx.payrollPeriod.findMany({
        where: { lockedAt: { not: null } },
        select: { id: true, periodStart: true, periodEnd: true, lockedAt: true, timeZone: true },
    });
}

/**
 * Take the shared lock, then assert none of `instants` is frozen — INSIDE the
 * caller's write transaction. Throws PeriodLockedError.
 *
 * This is the guard that actually holds. assertPeriodUnlocked() (the
 * NextResponse variant) is still useful as a cheap fail-fast before expensive
 * work, but on its own it is only a check, not a guarantee.
 */
export async function assertPeriodUnlockedInTx(
    tx: PayrollTxClient,
    instants: Array<Date | null | undefined>,
    options: { timeZone?: string; weekStart?: PayrollWeekStart } = {}
): Promise<void> {
    const candidates = instants.filter(
        (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime())
    );
    if (candidates.length === 0) return;
    await acquirePayrollWriteLock(tx);
    const periods = await loadLockedPeriodsTx(tx);
    if (periods.length === 0) return;
    for (const instant of candidates) {
        const period = lockedPeriodFor(periods, instant, options);
        if (period) throw new PeriodLockedError(period);
    }
}

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
    // The caller's zone is only a FALLBACK. A locked period carries the zone it
    // was locked in, and that is what its envelope must be computed from.
    const fallbackZone = options.timeZone ?? COMPANY_TIME_ZONE;
    const at = instant.getTime();
    for (const period of periods) {
        if (!period.lockedAt) continue;
        const envelope = payrollLockEnvelope(
            period.periodStart,
            period.periodEnd,
            period.timeZone || fallbackZone,
            options.weekStart
        );
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
        select: { id: true, periodStart: true, periodEnd: true, lockedAt: true, timeZone: true },
    });
}

/**
 * Open a transaction, take the shared advisory lock, assert the instants are
 * not frozen, and run the write — all in ONE transaction, which is the only
 * arrangement where the check actually protects the write.
 *
 * Throws PeriodLockedError, which routes map to 423 and server actions surface
 * as their usual thrown error.
 */
export async function withPayrollWriteTx<T>(
    target: PayrollWriteTarget,
    write: (tx: PayrollTxClient) => Promise<T>,
    options: { timeZone?: string; weekStart?: PayrollWeekStart } = {}
): Promise<T> {
    const { prisma } = await import("./prisma");
    const { resolveCompanyTimeZone } = await import("./company-timezone");
    // The SAME zone the export and the lock action use — never the hardcoded
    // company-day constant, which ignores CompanySettings.
    const timeZone = options.timeZone ?? (await resolveCompanyTimeZone());
    return prisma.$transaction(async (tx) => {
        const client = tx as unknown as PayrollTxClient;
        await acquirePayrollWriteLock(client);
        const instants = await resolveGuardInstants(client, target);
        await assertPeriodUnlockedInTx(client, instants, { ...options, timeZone });
        return write(client);
    });
}

/**
 * What a write must be checked against.
 *
 * `entryIds` are re-read INSIDE the transaction and row-locked; `instants` are
 * values the write is about to introduce (a new startTime, a date being
 * created) which have no stored row yet.
 */
export type PayrollWriteTarget = {
    /** Existing rows the write touches. Their STORED startTime is what gets validated. */
    entryIds?: string[];
    /** Instants the write is about to write (new startTime on an edit, the date on a create). */
    instants?: Array<Date | null | undefined>;
};

/**
 * Re-read every targeted row inside the transaction with SELECT ... FOR UPDATE
 * and return the instants to validate.
 *
 * The caller's captured startTime is NOT trusted: between reading a row and
 * writing it, another writer can MOVE that row to a different day, and a locker
 * can then lock the period it moved into. Validating the stale value would let
 * the write land in a locked period. FOR UPDATE also blocks a concurrent writer
 * from moving the row out from under this transaction after the check.
 */
async function resolveGuardInstants(tx: PayrollTxClient, target: PayrollWriteTarget): Promise<Date[]> {
    const instants: Date[] = (target.instants ?? []).filter(
        (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime())
    );
    const ids = (target.entryIds ?? []).filter((id): id is string => typeof id === "string" && !!id);
    if (ids.length > 0) {
        const rows = (await tx.$queryRawUnsafe(
            `SELECT "startTime" FROM "TimeEntry" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`,
            ids
        )) as Array<{ startTime: Date }>;
        for (const row of rows) {
            if (row.startTime instanceof Date && !Number.isNaN(row.startTime.getTime())) instants.push(row.startTime);
        }
    }
    return instants;
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
    const timeZone = await resolveEnforcementTimeZone();
    for (const instant of candidates) {
        const period = lockedPeriodFor(periods, instant, { timeZone });
        if (period) return periodLockedResponse(period);
    }
    return null;
}

/**
 * The zone enforcement falls back to when a period predates the stored column.
 * Resolved from CompanySettings, exactly like the export and the lock action —
 * the hardcoded COMPANY_TIME_ZONE constant would disagree with both the moment
 * the company zone is changed.
 */
async function resolveEnforcementTimeZone(): Promise<string> {
    try {
        const { resolveCompanyTimeZone } = await import("./company-timezone");
        return await resolveCompanyTimeZone();
    } catch {
        return COMPANY_TIME_ZONE;
    }
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
    const timeZone = await resolveEnforcementTimeZone();
    for (const instant of candidates) {
        const period = lockedPeriodFor(periods, instant, { timeZone });
        if (period) throw new PeriodLockedError(period);
    }
}
