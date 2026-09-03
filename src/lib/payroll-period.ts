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
// AND, on the OTHER table the export is built from, every writer that changes a
// User's export-affecting state (status, payType, name, email) goes through
// withPayrollUserWrite below. The canonical list is
// tests/payroll-user-writer-manifest.test.ts. Activation is the one that was
// missing: the roster is "(ACTIVATED and HOURLY) or punched", so a sign-in
// flipping PENDING -> ACTIVATED adds a row to a pay period's file.
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
// THE GLOBAL LOCK ORDER. Every payroll path takes these in exactly this order,
// and nothing takes them in any other:
//
//   1. pg_advisory_xact_lock_shared('payroll-period')   (writers)
//      pg_advisory_xact_lock('payroll-period')          (lock creation)
//   2. pg_advisory_xact_lock('wa-breaks:<user>:<day>')  — ALL affected days,
//      in sorted key order
//   3. SELECT ... FOR UPDATE on ALL affected TimeEntry rows, in sorted id order
//
// A path therefore has to COLLECT every day key and row id it will touch BEFORE
// it locks anything — acquirePayrollLocks() below is the only place that takes
// them, so the order cannot drift per call site.
//
// Why it matters: any two transactions that take the same locks in different
// orders can each hold what the other needs next. Deadlock detection then
// aborts one at random, and the one it aborts might be the payroll lock — the
// thing protecting an already-paid period. Sorting within each tier removes the
// same hazard between two writers touching an overlapping set.
//
// Day locks come BEFORE row locks because meal settlement is day-scoped and can
// rewrite rows the caller never named: it has to be serialised before any row
// is pinned, not after.
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
import { dayKeyInTimeZone, addDaysToKey, startOfDateInTimeZone } from "./tz-date";
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

/**
 * The wa-breaks day advisory-lock key. Formatted HERE so the payroll lock
 * sequencer and src/lib/wa-breaks-db.ts cannot drift into two different key
 * spaces — if they did, tier 2 of the global lock order would silently stop
 * serialising anything.
 */
export function dayLockKey(userId: string, dayKey: string): string {
    return `wa-breaks:${userId}:${dayKey}`;
}

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
export async function acquirePayrollWriteLock(tx: Pick<PayrollTxClient, "$executeRawUnsafe">): Promise<void> {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, PAYROLL_ADVISORY_LOCK_KEY);
}

/**
 * The User columns the Gusto export is BUILT FROM — its roster predicate and
 * the bytes it hashes.
 *
 *   status   the roster is `status = ACTIVATED AND payType = HOURLY` OR
 *            "punched inside the period", so activating somebody ADDS a row;
 *   payType  decides whether they are on the file as an hourly employee at all;
 *   name     printed in both CSVs;
 *   email    printed in both CSVs, and the key the salaried-email fallback and
 *            the Gusto employee mapping are looked up by;
 *   role     decides whether they can be on the roster AT ALL — the roster
 *            predicate is `payrollEligibleUserWhere()` AND the above, so moving
 *            an account into or out of the staff set adds or removes a row.
 *
 * `role` was deliberately absent until round 8, on the reasoning that nothing in
 * the CSVs is derived from it. That was true of the BYTES and false of the
 * ROSTER: it only held while the roster asked no question about role, and once
 * the staff predicate went in (a customer must not be on a payroll file) a role
 * change became export-affecting like any other. It is still not selected into
 * ExportUser and still prints nowhere — membership, not content.
 *
 * Keep this list in step with the roster `where` and the roster select — the
 * manifest test (tests/payroll-user-writer-manifest.test.ts) reads both.
 */
export const EXPORT_AFFECTING_USER_FIELDS = ["status", "payType", "name", "email", "role"] as const;

/** Does this Prisma `data` payload name any of them? Presence, not value — writing the same value still bumps updatedAt and still races. */
export function touchesExportUserState(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const payload = data as Record<string, unknown>;
    return EXPORT_AFFECTING_USER_FIELDS.some((field) => field in payload);
}

/**
 * THE entry point for a User write that can change what the payroll export
 * contains. Takes tier 1 of the global lock order FIRST, then runs the write.
 *
 * WHY THIS EXISTS. The rate writers (pay-rate-write.ts, setUserPayType,
 * applyGustoRateImport) already took the shared payroll lock, but ACTIVATION did
 * not — and activation is the other half of the roster predicate. So this could
 * happen, with everything else in this file working exactly as designed:
 *
 *   lockPayrollPeriod  takes the EXCLUSIVE payroll lock, reads the roster
 *                      (a PENDING hourly hire is not on it), hashes, ...
 *   PATCH /api/users   sets that hire to ACTIVATED and COMMITS
 *   lockPayrollPeriod  ...COMMITS the reviewed hash
 *
 * and the period is frozen around a roster that already had one more person on
 * it than the file says. The export cannot defend itself here: the row it needs
 * to hold is one its own roster query did not return, and `SELECT ... FOR SHARE`
 * can only lock rows a predicate matched. That is the same shape as the
 * overlapping-period check — a predicate over rows that may not qualify yet —
 * and the same answer applies: an advisory lock, which serialises against the
 * PREDICATE rather than against any row.
 *
 * SHARED, not exclusive, and the SAME key lock creation takes: these writers do
 * not conflict with each other (Prisma's own row lock serialises two edits of
 * one person), only with a period being locked.
 *
 * LOCK ORDER: tier 1, so it must be taken BEFORE any User row lock. Every call
 * site passes a `write` closure rather than a pre-locked row for exactly that
 * reason. Re-taking it inside a transaction that already holds it (a route that
 * ran applyRateChangeInTx first) is granted immediately — an advisory lock is
 * re-entrant within one transaction — so the two cannot deadlock each other.
 *
 * A payload that names none of EXPORT_AFFECTING_USER_FIELDS takes NO lock: a
 * project-access edit or a "seen" timestamp cannot move the export, and making
 * every User write queue behind payroll would be a real cost for no guarantee.
 */
export async function withPayrollUserWrite<T>(
    tx: Pick<PayrollTxClient, "$executeRawUnsafe">,
    data: unknown,
    write: () => Promise<T>
): Promise<T> {
    if (touchesExportUserState(data)) await acquirePayrollWriteLock(tx);
    return write();
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
 * evaluated in the zone it was locked in (see lockedPeriodForDay). The check
 * covers the WHOLE settlement day, not just its opening instant — see
 * lockedPeriodForDay for why a single-instant check is unsound here.
 *
 * MUST be called before the wa-breaks day advisory lock is taken — payroll
 * lock first, always (see the LOCK ORDER note in the header).
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
    const period = lockedPeriodForDay(periods, dayKey, timeZone, options);
    if (period) throw new PeriodLockedError(period);
}

/**
 * THE select every locked-period read shares.
 *
 * One object, not a literal repeated per call site: `timeZone` went missing
 * from a hand-rolled copy of this query in the clock-out route, which silently
 * demoted every locked period to a legacy row and re-derived its envelope from
 * today's company zone. A column added here reaches every reader at once.
 */
export const LOCKED_PERIOD_SELECT = {
    id: true,
    periodStart: true,
    periodEnd: true,
    lockedAt: true,
    timeZone: true,
} as const;

/** Locked periods read THROUGH a transaction client, so the check sees the same snapshot as the write. */
export async function loadLockedPeriodsTx(tx: PayrollTxClient): Promise<LockedPeriodRow[]> {
    return tx.payrollPeriod.findMany({
        where: { lockedAt: { not: null } },
        select: LOCKED_PERIOD_SELECT,
    });
}

/**
 * Re-read the given entries FOR UPDATE inside this transaction and assert none
 * of their STORED startTimes is frozen.
 *
 * This is the guard every write path shares. A caller's captured startTime is
 * never trusted: between reading a row and writing it, another writer can MOVE
 * that row into a different period, and a locker can then lock it. FOR UPDATE
 * additionally pins the rows for the rest of the transaction.
 *
 * Lock order is enforced here: the payroll advisory lock is taken BEFORE the
 * row locks (see the header).
 */
export type PayrollLockTarget = {
    /** Company-local day keys whose settlement this write can trigger. */
    dayKeys?: string[];
    /** Existing rows the write touches. Their STORED startTime is what gets validated. */
    entryIds?: string[];
    /** Instants the write is about to introduce (a new startTime, a create date). */
    instants?: Array<Date | null | undefined>;
};

/**
 * Take every lock this write needs, in THE GLOBAL ORDER (see the header), and
 * return the STORED startTimes of the targeted rows.
 *
 * This is the only function that acquires payroll/day/row locks, so no call
 * site can invent its own ordering.
 */
export async function acquirePayrollLocks(
    tx: PayrollTxClient,
    target: PayrollLockTarget
): Promise<Date[]> {
    const dayKeys = [...new Set((target.dayKeys ?? []).filter((key): key is string => typeof key === "string" && !!key))].sort();
    const ids = [...new Set((target.entryIds ?? []).filter((id): id is string => typeof id === "string" && !!id))].sort();

    // 1. payroll advisory lock — always first.
    await acquirePayrollWriteLock(tx);

    // 2. day locks, sorted. Same key format as src/lib/wa-breaks-db.ts, because
    //    it is the same lock: a settlement running inside this transaction must
    //    not try to take it again in a different position.
    for (const dayKey of dayKeys) {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayKey);
    }

    // 3. row locks, sorted by id.
    const stored: Date[] = [];
    if (ids.length > 0) {
        const rows = (await tx.$queryRawUnsafe(
            `SELECT "startTime" FROM "TimeEntry" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`,
            ids
        )) as Array<{ startTime: Date }>;
        for (const row of rows) {
            if (row.startTime instanceof Date && !Number.isNaN(row.startTime.getTime())) stored.push(row.startTime);
        }
    }
    return stored;
}

/**
 * Acquire the locks, then assert nothing this write touches is frozen.
 *
 * A caller's captured startTime is never trusted: between reading a row and
 * writing it, another writer can MOVE that row into a different period, and a
 * locker can then lock it. The STORED value, read under FOR UPDATE, is what
 * gets validated.
 */
export async function assertEntriesUnlockedInTx(
    tx: PayrollTxClient,
    entryIds: string[],
    options: {
        timeZone?: string;
        weekStart?: PayrollWeekStart;
        alsoCheck?: Array<Date | null | undefined>;
        /** Day keys whose settlement this write may trigger — locked before the rows. */
        dayKeys?: string[];
    } = {}
): Promise<void> {
    const extra = (options.alsoCheck ?? []).filter(
        (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime())
    );
    const ids = entryIds.filter((id): id is string => typeof id === "string" && !!id);
    const dayKeys = options.dayKeys ?? [];
    if (ids.length === 0 && extra.length === 0 && dayKeys.length === 0) return;

    const stored = await acquirePayrollLocks(tx, { dayKeys, entryIds: ids, instants: extra });

    const periods = await loadLockedPeriodsTx(tx);
    if (periods.length === 0) return;
    const timeZone = options.timeZone ?? (await resolveEnforcementTimeZone());
    for (const instant of [...stored, ...extra]) {
        const period = lockedPeriodFor(periods, instant, { timeZone, weekStart: options.weekStart });
        if (period) throw new PeriodLockedError(period);
    }
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
            period.timeZone || fallbackZone
        );
        if (at >= envelope.start.getTime() && at < envelope.end.getTime()) return period;
    }
    return null;
}

/**
 * The LOCKED period whose envelope overlaps ANY part of the given SETTLEMENT
 * DAY — midnight to midnight in `timeZone`, i.e. [dayStart, dayEnd) — not just
 * the day's opening instant.
 *
 * assertDayUnlockedInTx used to test only startOfDateInTimeZone(dayKey), a
 * single instant, against lockedPeriodFor. That is sound for a punch (which
 * really is one instant) but not for a settlement day, which spans 24 hours.
 * A period locked in a zone WEST of the caller's zone can start its envelope
 * AFTER the caller's midnight but still before the caller's day ends: reading
 * a dayKey's midnight in Los Angeles lands three hours before the same day's
 * midnight in Pacific/Honolulu, so the instant check saw the LA day as free
 * while settlement went on to rewrite entries later that same LA day that DO
 * fall inside the Honolulu-locked envelope. Two half-open intervals overlap
 * when start1 < end2 AND start2 < end1 — that is the whole rule here.
 */
export function lockedPeriodForDay(
    periods: LockedPeriodRow[],
    dayKey: string,
    timeZone: string,
    options: { weekStart?: PayrollWeekStart } = {}
): LockedPeriodRow | null {
    void options;
    if (!dayKey) return null;
    const dayStartMs = startOfDateInTimeZone(dayKey, timeZone).getTime();
    const dayEndMs = startOfDateInTimeZone(addDaysToKey(dayKey, 1), timeZone).getTime();
    for (const period of periods) {
        if (!period.lockedAt) continue;
        // The caller's zone is only a FALLBACK — see lockedPeriodFor.
        const envelope = payrollLockEnvelope(period.periodStart, period.periodEnd, period.timeZone || timeZone);
        if (dayStartMs < envelope.end.getTime() && envelope.start.getTime() < dayEndMs) return period;
    }
    return null;
}

/**
 * Inclusive local day keys for display — periodEnd is exclusive, so the last
 * DAY is the day before it.
 *
 * Formatted in the zone the period was LOCKED in, the same zone enforcement
 * uses (see lockedPeriodFor). Formatting in whatever the company zone is today
 * would make the refusal name a different pair of dates than the one that is
 * actually frozen the moment CompanySettings.timeZone changes — telling the
 * person holding the phone to look at a day that is not the one blocking them.
 * `timeZone` is null on rows written before the column existed; those fall back
 * to the company constant, which is what they were locked under.
 */
export function periodDisplayRange(period: Pick<LockedPeriodRow, "periodStart" | "periodEnd" | "timeZone">): {
    startKey: string;
    lastDayKey: string;
} {
    const zone = period.timeZone || COMPANY_TIME_ZONE;
    const startKey = dayKeyInTimeZone(period.periodStart, zone);
    const endKeyExclusive = dayKeyInTimeZone(period.periodEnd, zone);
    return { startKey, lastDayKey: addDaysToKey(endKeyExclusive, -1) };
}

export function periodLockedMessage(period: Pick<LockedPeriodRow, "periodStart" | "periodEnd" | "timeZone">): string {
    const { startKey, lastDayKey } = periodDisplayRange(period);
    return `Payroll for ${startKey} to ${lastDayKey} is locked, including the rest of the workweeks it touches — overtime is worked out per week, so a punch just outside the period still changes what was paid inside it. An admin has to unlock that period before this entry can change.`;
}

export const PERIOD_LOCKED_CODE = "PERIOD_LOCKED";

/**
 * Refusal code for "the lock you are looking at is not the lock that is there
 * now" — a stale unlock, or one aimed at an already-unlocked period.
 *
 * Lives here rather than in actions.ts because that file is "use server", where
 * only async functions may be exported.
 */
export const STALE_LOCK_CODE = "STALE_LOCK";

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

/**
 * Run a route handler, turning PeriodLockedError into the canonical 423.
 *
 * ONE place. Routes that took a payroll write lock without this let the error
 * escape as an unhandled 500, which tells the crew app to retry a write that
 * will be refused every time — and tells the person holding the phone that
 * ProBuild is broken rather than that payroll is closed.
 */
export async function withPeriodLockedRoute(run: () => Promise<NextResponse>): Promise<NextResponse> {
    try {
        return await run();
    } catch (error) {
        if (isPeriodLockedError(error)) return periodLockedResponse(error.period);
        throw error;
    }
}

/** Default loader — every locked period. The table holds one row per reviewed period, so this stays tiny. */
export async function loadLockedPeriods(): Promise<LockedPeriodRow[]> {
    const { prisma } = await import("./prisma");
    return prisma.payrollPeriod.findMany({
        where: { lockedAt: { not: null } },
        select: LOCKED_PERIOD_SELECT,
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
/**
 * THE entry point for any write that touches a TimeEntry.
 *
 * Named so there is one thing to grep for and one thing to teach: every
 * TimeEntry update, delete or create call site in src/ is either inside one of
 * these, inside the settlement protocol (which takes the same locks), or on the
 * explicit exemption list in tests/payroll-writer-manifest.test.ts. There is no
 * regex allowlist of "approved routes" any more — a new writer is caught by the
 * manifest, not by whether somebody remembered to update a pattern.
 */
export async function withPayrollWrite<T>(
    target: PayrollWriteTarget,
    write: (tx: PayrollTxClient) => Promise<T>,
    options: { timeZone?: string; weekStart?: PayrollWeekStart } = {}
): Promise<T> {
    return withPayrollWriteTx(target, write, options);
}

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
        // Payroll advisory lock, then row locks, then the write (see the
        // LOCK ORDER note in the header).
        await assertEntriesUnlockedInTx(client, target.entryIds ?? [], {
            ...options,
            timeZone,
            alsoCheck: target.instants,
            dayKeys: target.dayKeys,
        });
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
export type PayrollWriteTarget = PayrollLockTarget;


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
