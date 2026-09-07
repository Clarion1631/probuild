
import { nonVoidedTimeEntryWhere } from "@/lib/time-entry-void";
// The one Prisma-backed reader/writer for src/lib/wa-breaks.ts — both clock-out
// paths (PUT /api/time-entries and PATCH /api/time-entries/[id]) must see the
// SAME "rest of the day", so they share this rather than each hand-rolling it.
import { prisma } from "@/lib/prisma";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { toNum } from "@/lib/prisma-helpers";
import { SETTLEMENT_FAILED_NOTE, settleDayPlan, type DayEntry } from "@/lib/wa-breaks";
import { dayLockKey, isPeriodLockedError } from "@/lib/payroll-period";
import { ZERO_RATE_REVIEW_NOTE } from "@/lib/pay-rate-guard";

function dayWindow(dayKey: string) {
    const dayStartUtc = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    return { gte: new Date(dayStartUtc - 24 * 3_600_000), lt: new Date(dayStartUtc + 2 * 24 * 3_600_000) };
}

/**
 * Every CLOSED TimeEntry id in the day's settlement window — a plain,
 * UNLOCKED read (same predicate settleDayInTx locks below, minus FOR UPDATE).
 *
 * Exported so a caller that is about to trigger settlement can fold this
 * candidate set into the ONE row lock it takes for its whole write, before it
 * locks anything. Locking only a caller-declared row first and letting
 * settlement separately lock this wider window afterwards, later in the same
 * transaction, is what let two adjacent-day settlements deadlock: each holds
 * its own declared row, then each waits on a row inside this window that the
 * other transaction already holds — an AB-BA cycle that no ORDER BY on either
 * lock, taken on its own, can prevent. Folding the candidates into the
 * caller's row lock up front makes it the transaction's first (and normally
 * only) TimeEntry lock; settleDayInTx's own re-lock of the same window later
 * is then a no-op re-acquire of rows this transaction already holds.
 */
export async function settlementCandidateIds(
    tx: { $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown> },
    userId: string,
    dayKey: string
): Promise<string[]> {
    const window = dayWindow(dayKey);
    const rows = (await tx.$queryRawUnsafe(
        `SELECT "id" FROM "TimeEntry" WHERE "userId" = $1 AND "voidedAt" IS NULL AND "endTime" IS NOT NULL AND "startTime" >= $2 AND "startTime" < $3`,
        userId,
        window.gte,
        window.lt
    )) as Array<{ id: string }>;
    return rows.map((row) => row.id);
}

/**
 * The worker's OTHER closed entries on the given company-local day. A UTC day
 * either side is a superset of any local day; the zone filter is what makes it
 * exact.
 *
 * `timeZone` IS REQUIRED, and it must be the zone `dayKey` was derived in.
 *
 * It used to be implicit: every filter in this module called toCompanyDayKey,
 * which is hardcoded to America/Los_Angeles. That is right for this company and
 * wrong as a rule — and it made settleDeferredDaysForPeriod, which builds its
 * window from the CONFIGURED zone, the one caller that mixed the two. For a New
 * York company an entry at 00:30 Monday is a Pacific SUNDAY, so it settled under
 * the wrong key and dragged in that Sunday's other rows, which can sit outside
 * the period the operator asked for (round 7, finding 1).
 */
export async function loadDayEntries(
    userId: string,
    dayKey: string,
    excludeEntryId: string,
    timeZone: string
): Promise<DayEntry[]> {
    const rows = await prisma.timeEntry.findMany({
        where: nonVoidedTimeEntryWhere({ userId, id: { not: excludeEntryId }, endTime: { not: null }, startTime: dayWindow(dayKey) }),
        select: { startTime: true, endTime: true, mealDeductionHours: true },
    });
    return rows
        .filter((row): row is typeof row & { endTime: Date } => row.endTime != null)
        .filter((row) => dayKeyInTimeZone(row.startTime, timeZone) === dayKey)
        .map((row) => ({ startTime: row.startTime, endTime: row.endTime, mealDeductionHours: row.mealDeductionHours }));
}

/**
 * Re-settle a worker's whole company-local day (src/lib/wa-breaks.ts
 * settleDayPlan) and persist every row that changed — paid hours, deduction,
 * outcome, and the labor/burden cost derived from the OWNER's rates.
 *
 * Serialized per worker/day with a transaction-scoped advisory lock, so two
 * closes (or a close and an edit) landing together each see the complete day
 * rather than racing on a partial one. Never throws into a caller's response:
 * a failure here leaves the per-row close-time values in place (still correct
 * for a single-entry day) and logs — the manager queue and the next clock-in
 * re-run it. Returns the number of rows rewritten, or -1 on failure — callers
 * flag the row they just wrote (flagSettlementFailed) so a failed re-plan is
 * visible in the manager queue, never silent.
 */
export async function settleDay(
    userId: string,
    dayKey: string,
    closing: { id: string; mealSkipped: unknown } | null,
    /** The zone `dayKey` was derived in. REQUIRED — see loadDayEntries. */
    timeZone: string,
    /**
     * The OPERATOR this settlement is running under, when there is one.
     *
     * The payroll screen's "settle deferred days" button is a payroll mutation
     * like any other, and it authorized its caller before the loop — so an
     * operator disabled, demoted or stripped of `financialReports` partway
     * through still settled the remaining days (round 21, P1). Passing their id
     * here re-decides that inside THIS day's transaction, under the payroll
     * lock, on their own row.
     *
     * Omitted by the clock-out and edit paths: settlement there is a side
     * effect of a worker's own punch, already authorized by the route that
     * triggered it, and it is not the payroll screen acting on the company's
     * behalf.
     */
    actorId?: string | null
): Promise<number> {
    try {
        return await prisma.$transaction(async (tx) => {
            // Payroll advisory lock FIRST, then the day lock — the order every
            // path uses (see the LOCK ORDER note in src/lib/payroll-period.ts).
            // Taking the day lock first would let a settlement hold it while
            // waiting on payroll, against a locker holding payroll and waiting
            // on this day.
            await assertSettlementDayUnlocked(tx, dayKey, timeZone);
            if (actorId) {
                // TIER 2, between the payroll lock and the day lock. The day's
                // OWNER is taken FOR SHARE in the same ascending-id sequence —
                // settleDayInTx re-reads their rates FOR SHARE anyway, and
                // taking both User rows here in one order is what stops this
                // transaction and a two-row rate import from closing a cycle.
                const { requireFinancialActorInTx } = await import("./user-mutation-guard");
                await requireFinancialActorInTx(tx as never, actorId, {
                    alsoLock: [{ id: userId, mode: "FOR SHARE" }],
                });
            }
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayLockKey(userId, dayKey));
            return settleDayInTx(tx, userId, dayKey, closing, timeZone, { alreadyGuarded: true });
        });
    } catch (error) {
        if (isPeriodLockedError(error)) throw error;
        // A revoked operator is NOT a day to skip. Swallowing it would let the
        // button report "0 settled" success while silently refusing every day,
        // and the caller has to be able to tell the two apart.
        const { isUserMutationActorInvalidError } = await import("./user-mutation-guard");
        if (isUserMutationActorInvalidError(error)) throw error;
        console.error("[wa-breaks] settleDay failed", { userId, dayKey, timeZone }, error);
        return -1;
    }
}

/**
 * Settle a day inside a transaction the CALLER already owns.
 *
 * This is what the clock-out and edit paths use, so the write that triggers a
 * re-plan and the re-plan itself commit together, under one payroll advisory
 * lock. Running settlement in its own transaction afterwards left a window in
 * which a period could be locked in between — and settlement then rewrote paid
 * hours inside it.
 *
 * Errors are NOT swallowed here (unlike settleDay): the caller's transaction
 * must roll back with them.
 */
/**
 * True when the stored row already says what the re-plan would write.
 *
 * The zero-rate branch is the subtle one: the flag is an ADDITIONAL condition on
 * skipping, never a substitute for the hours check. Treating "already flagged"
 * as sufficient froze a flagged day — a later shift that changed the meal
 * allocation was skipped, and the earlier row kept hours the day no longer
 * produces.
 *
 * `flagsChange` is checked FOR BOTH BRANCHES, before either. It used to be
 * consulted only at a real rate, so on a $0-rate day the review state was
 * frozen along with the hours: a re-plan that had newly decided the day
 * OVERLAPS another, or that no attestation was on file, wrote nothing at all
 * because the hours still matched and the zero-rate note was already there —
 * and the manager queue never showed the reason. The retirement direction is
 * just as bad: an overlap that has since been edited away kept its note
 * forever, because dropping a reason is also a flags change and it was also
 * being skipped. Review state is an OUTPUT of the re-plan, not a reason to
 * skip it.
 */
export function settlementRowIsCurrent(input: {
    stored: {
        durationHours: number | null;
        mealDeductionHours: number | null;
        mealOutcome: string | null;
        needsReview: boolean;
        reviewReason: string | null;
    };
    update: { paidHours: number; mealDeductionHours: number; mealOutcome: string };
    zeroRate: boolean;
    flagsChange: boolean;
}): boolean {
    const { stored, update } = input;
    const hoursMatch =
        Math.abs((stored.durationHours ?? -1) - update.paidHours) < 1e-9 &&
        Math.abs((stored.mealDeductionHours ?? 0) - update.mealDeductionHours) < 1e-9 &&
        stored.mealOutcome === update.mealOutcome;
    if (!hoursMatch) return false;
    // A review-state change is a WRITE, at any rate. Adding a reason and
    // retiring one are both changes, and both have to land.
    if (input.flagsChange) return false;
    if (!input.zeroRate) return true;
    return stored.needsReview && (stored.reviewReason ?? "").includes(ZERO_RATE_REVIEW_NOTE);
}

export async function settleDayWithinTx(
    tx: Tx,
    userId: string,
    dayKey: string,
    closing: { id: string; mealSkipped: unknown } | null,
    /** The zone `dayKey` was derived in. REQUIRED — see loadDayEntries. */
    timeZone: string
): Promise<number> {
    // Payroll lock first, then the day lock (see LOCK ORDER in payroll-period.ts).
    await assertSettlementDayUnlocked(tx, dayKey, timeZone);
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayLockKey(userId, dayKey));
    return settleDayInTx(tx, userId, dayKey, closing, timeZone, { alreadyGuarded: true });
}

/**
 * Payroll guard for a settlement: takes the shared payroll advisory lock and
 * refuses a locked day.
 *
 * THE ZONE IS THE ONE THE DAY KEY WAS DERIVED IN, and it is now PASSED IN
 * rather than assumed. The guard and the write have to agree about what
 * "2026-08-17" means: read as New York midnight it is three hours before the
 * Los Angeles midnight the rows would sit at, which can fall outside a locked
 * period's envelope — the guard passes and settlement rewrites paid hours
 * inside an already-exported period.
 *
 * They used to agree by both hardcoding America/Los_Angeles (toCompanyDayKey /
 * COMPANY_TIME_ZONE). That is one way to make two things agree, and it is the
 * wrong one: it is correct only for a Pacific company, and it left
 * settleDeferredDaysForPeriod — whose window comes from the CONFIGURED zone —
 * mixing two zones in a single operation. Both sides now take the caller's
 * resolved zone, so they agree in EVERY zone rather than in one.
 *
 * A locked period carries the zone it was locked in and evaluates its own
 * envelope in it (lockedPeriodFor), so nothing else here depends on this value.
 */
async function assertSettlementDayUnlocked(tx: Tx, dayKey: string, timeZone: string): Promise<void> {
    const { assertDayUnlockedInTx } = await import("./payroll-period");
    await assertDayUnlockedInTx(tx as never, dayKey, timeZone);
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** The re-plan itself; the caller holds the day's advisory lock on `tx`. */
async function settleDayInTx(
    tx: Tx,
    userId: string,
    dayKey: string,
    closing: { id: string; mealSkipped: unknown } | null,
    /** The zone `dayKey` was derived in. REQUIRED — see loadDayEntries. */
    timeZone: string,
    options: { alreadyGuarded?: boolean } = {}
): Promise<number> {
    {
        {
            // A re-plan rewrites durationHours / laborCost / burdenCost for the
            // whole day, so it is a payroll write like any other and must not
            // touch a locked period. Callers that already took the payroll lock
            // (in the right order, BEFORE the day lock) pass alreadyGuarded.
            // Same helper as the guarded callers, so there is exactly ONE
            // answer to "which zone is this day key in" on both sides.
            if (!options.alreadyGuarded) {
                await assertSettlementDayUnlocked(tx, dayKey, timeZone);
            }

            // TimeEntry BEFORE User, in sorted id order — the same order every
            // other payroll writer takes (THE GLOBAL LOCK ORDER in
            // payroll-period.ts; closeTimeEntry locks its row FOR UPDATE, then
            // reads the owner FOR UPDATE afterwards). Settlement used to read
            // the owner FOR SHARE first and only lock TimeEntry rows later, one
            // at a time, inside the update loop below — the exact opposite
            // order. A settlement and a concurrent clock-out/edit on an
            // overlapping window could then each hold what the other needs
            // next: the close holding its TimeEntry row and waiting on the
            // owner, this settlement holding the owner (shared) and waiting on
            // a TimeEntry row. Locking the day's candidate rows here, before
            // the owner read, removes that cycle.
            const window = dayWindow(dayKey);
            await tx.$queryRawUnsafe(
                `SELECT "id" FROM "TimeEntry" WHERE "userId" = $1 AND "voidedAt" IS NULL AND "endTime" IS NOT NULL AND "startTime" >= $2 AND "startTime" < $3 ORDER BY "id" FOR UPDATE`,
                userId,
                window.gte,
                window.lt
            );

            // The whole owner, not just the numbers: settlement REPRICES every
            // row it touches, so it is a first-pass pricing decision in its own
            // right and answers to the same $0-rate policy. Writing
            // laborCost = paidHours * 0 here was the one path that could book a
            // free shift without anybody choosing to — the clock-out guard
            // refuses it, and then a later re-plan quietly did it anyway.
            // SHARED row lock, not a plain read. Settlement reprices every row
            // it touches, so it needs ONE answer to "what is this person paid"
            // for the whole transaction: a rate import committing halfway through
            // a multi-entry day would otherwise price the first shift at the old
            // rate and the second at the new one. Every rate WRITER takes the
            // exclusive lock on the same row, so the two serialize.
            const { appendZeroRateReview, readOwnerRatesForShare, zeroRateBlocks } = await import("./pay-rate-guard");
            const owner = await readOwnerRatesForShare(tx as never, userId, toNum);
            if (!owner) return 0;
            const hourlyRate = owner.hourlyRate;
            const burdenRate = owner.burdenRate;
            const zeroRate = zeroRateBlocks({
                role: owner.role,
                email: owner.email,
                payType: owner.payType,
                hourlyRate,
            });

            const rows = await tx.timeEntry.findMany({
                where: nonVoidedTimeEntryWhere({ userId, endTime: { not: null }, startTime: window }),
                select: {
                    id: true, startTime: true, endTime: true, mealOutcome: true, mealSkipStatus: true, reviewReason: true,
                    shiftHours: true, mealDeductionHours: true, durationHours: true, needsReview: true,
                },
            });
            const day = rows
                .filter((row): row is typeof row & { endTime: Date } => row.endTime != null)
                .filter((row) => dayKeyInTimeZone(row.startTime, timeZone) === dayKey);
            const plan = settleDayPlan({
                entries: day.map((row) => ({
                    id: row.id, startTime: row.startTime, endTime: row.endTime,
                    mealOutcome: row.mealOutcome, mealSkipStatus: row.mealSkipStatus, reviewReason: row.reviewReason,
                })),
                closing,
            });

            let written = 0;
            for (const update of plan) {
                const row = day.find((r) => r.id === update.id);
                if (!row) continue;
                const flagsChange =
                    (update.reviewReason !== undefined && update.reviewReason !== (row.reviewReason ?? "")) ||
                    (update.needsReview !== undefined && update.needsReview !== row.needsReview);
                if (settlementRowIsCurrent({ stored: row, update, zeroRate, flagsChange })) continue;
                // At a $0 rate the hours are still re-planned — the WA meal rule
                // does not care what anybody is paid — but the COSTS are left
                // exactly as they were and the row is flagged. Overwriting them
                // with paidHours * 0 would erase a real cost and hand payroll a
                // free shift; leaving them stale is visible, and the flag is
                // what stops the export running past it.
                const pricing = zeroRate
                    ? appendZeroRateReview(update.reviewReason ?? row.reviewReason)
                    : {
                          laborCost: update.paidHours * hourlyRate,
                          burdenCost: update.paidHours * burdenRate,
                      };
                await tx.timeEntry.update({
                    where: { id: update.id },
                    data: {
                        shiftHours: update.shiftHours,
                        mealDeductionHours: update.mealDeductionHours,
                        durationHours: update.paidHours,
                        mealOutcome: update.mealOutcome,
                        ...pricing,
                        ...(update.reviewReason !== undefined && !zeroRate
                            ? { reviewReason: update.reviewReason }
                            : {}),
                        ...(update.needsReview !== undefined && !zeroRate
                            ? { needsReview: update.needsReview }
                            : {}),
                    },
                });
                written += 1;
            }
            return written;
        }
    }
}

/**
 * Delete a time entry and re-plan its day in ONE transaction under the day's
 * advisory lock: the victim is re-read inside the lock (a concurrent PATCH
 * that moved it to another day is therefore seen — that day is re-planned
 * too), then deleted, then every affected day re-planned. Throws on failure
 * (the caller answers 500 and nothing is deleted).
 */
export async function deleteEntryAndSettle(
    entryId: string,
    knownDayKey: string,
    userId: string,
    /** The zone `knownDayKey` was derived in. REQUIRED — see loadDayEntries. */
    timeZone: string,
    options: {
        /**
         * Runs FIRST, inside this transaction, before anything is deleted. The
         * payroll-period guard uses it so its lock check and this delete cannot
         * be split by a concurrent lock creation (src/lib/payroll-period.ts).
         * Throwing aborts the whole transaction, which is the point.
         */
        guard?: (tx: any) => Promise<void>;
    } = {}
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        if (options.guard) await options.guard(tx);
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayLockKey(userId, knownDayKey));
        const victim = await tx.timeEntry.findUnique({ where: { id: entryId }, select: { userId: true, startTime: true } });
        if (!victim) return; // already gone
        const actualDay = dayKeyInTimeZone(victim.startTime, timeZone);

        // THE COMPLETE SET, keyed on OWNER AND DAY.
        //
        // The old condition compared the day alone, so a same-date reassignment
        // from A to B took no extra lock at all — `actualDay === knownDayKey`
        // was true — and then settled B's day while holding only A's day lock.
        // The lock and the settlement were for two different people.
        //
        // A day lock is `wa-breaks:<user>:<day>`, so the owner is part of the
        // key: comparing whole keys is what makes an owner change visible here.
        // Sorted, so two concurrent deletes take them in the same order.
        const dayLocks = [...new Set([
            dayLockKey(userId, knownDayKey),
            dayLockKey(victim.userId, actualDay),
        ])].sort();
        for (const key of dayLocks) {
            // Re-taking the one acquired above is a no-op: pg_advisory_xact_lock
            // is re-entrant within a transaction.
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, key);
        }

        await tx.timeEntry.delete({ where: { id: entryId } });
        // Re-plan the day the hours actually left. The caller's day is settled
        // too when it differs, because the row may have moved off it.
        for (const dayKey of new Set([knownDayKey, actualDay])) {
            await settleDayInTx(tx, victim.userId, dayKey, null, timeZone);
        }
    });
}

/** Id of the worker's latest CLOSED entry on a company-local day (null when none) — the row that carries the day's outcome. */
export async function latestClosedEntryIdOnDay(
    userId: string,
    dayKey: string,
    /** The zone `dayKey` was derived in. REQUIRED — see loadDayEntries. */
    timeZone: string
): Promise<string | null> {
    const rows = await prisma.timeEntry.findMany({
        where: nonVoidedTimeEntryWhere({ userId, endTime: { not: null }, startTime: dayWindow(dayKey) }),
        select: { id: true, startTime: true, endTime: true },
    });
    const day = rows.filter((row) => row.endTime != null && dayKeyInTimeZone(row.startTime, timeZone) === dayKey);
    if (day.length === 0) return null;
    day.sort((a, b) => (b.endTime as Date).getTime() - (a.endTime as Date).getTime() || b.startTime.getTime() - a.startTime.getTime());
    return day[0].id;
}

/** Mark a row whose day could not be re-planned. Best-effort, idempotent, never throws. */
export async function flagSettlementFailed(entryId: string): Promise<void> {
    try {
        const row = await prisma.timeEntry.findUnique({ where: { id: entryId }, select: { reviewReason: true } });
        if (!row) return;
        const parts = (row.reviewReason ?? "").split("; ").map((p) => p.trim()).filter(Boolean);
        if (parts.includes(SETTLEMENT_FAILED_NOTE)) {
            await prisma.timeEntry.update({ where: { id: entryId }, data: { needsReview: true } });
            return;
        }
        await prisma.timeEntry.update({
            where: { id: entryId },
            data: { needsReview: true, reviewReason: [...parts, SETTLEMENT_FAILED_NOTE].join("; ") },
        });
    } catch (error) {
        console.error("[wa-breaks] flagSettlementFailed failed", { entryId }, error);
    }
}
