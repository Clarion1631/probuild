// The one Prisma-backed reader/writer for src/lib/wa-breaks.ts — both clock-out
// paths (PUT /api/time-entries and PATCH /api/time-entries/[id]) must see the
// SAME "rest of the day", so they share this rather than each hand-rolling it.
import { prisma } from "@/lib/prisma";
import { toCompanyDayKey } from "@/lib/company-day";
import { toNum } from "@/lib/prisma-helpers";
import { SETTLEMENT_FAILED_NOTE, settleDayPlan, type DayEntry } from "@/lib/wa-breaks";
import { dayLockKey, isPeriodLockedError } from "@/lib/payroll-period";
import { ZERO_RATE_REVIEW_NOTE } from "@/lib/pay-rate-guard";

function dayWindow(dayKey: string) {
    const dayStartUtc = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    return { gte: new Date(dayStartUtc - 24 * 3_600_000), lt: new Date(dayStartUtc + 2 * 24 * 3_600_000) };
}

/**
 * The worker's OTHER closed entries on the given company-local day. A UTC
 * day either side is a superset of any local day; the toCompanyDayKey filter
 * is what makes it exact (same helper the rule and the clock-in binding use).
 */
export async function loadDayEntries(userId: string, dayKey: string, excludeEntryId: string): Promise<DayEntry[]> {
    const rows = await prisma.timeEntry.findMany({
        where: { userId, id: { not: excludeEntryId }, endTime: { not: null }, startTime: dayWindow(dayKey) },
        select: { startTime: true, endTime: true, mealDeductionHours: true },
    });
    return rows
        .filter((row): row is typeof row & { endTime: Date } => row.endTime != null)
        .filter((row) => toCompanyDayKey(row.startTime) === dayKey)
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
    closing?: { id: string; mealSkipped: unknown } | null
): Promise<number> {
    try {
        return await prisma.$transaction(async (tx) => {
            // Payroll advisory lock FIRST, then the day lock — the order every
            // path uses (see the LOCK ORDER note in src/lib/payroll-period.ts).
            // Taking the day lock first would let a settlement hold it while
            // waiting on payroll, against a locker holding payroll and waiting
            // on this day.
            await assertSettlementDayUnlocked(tx, userId, dayKey);
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayLockKey(userId, dayKey));
            return settleDayInTx(tx, userId, dayKey, closing, { alreadyGuarded: true });
        });
    } catch (error) {
        if (isPeriodLockedError(error)) throw error;
        console.error("[wa-breaks] settleDay failed", { userId, dayKey }, error);
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
    if (!input.zeroRate) return !input.flagsChange;
    return stored.needsReview && (stored.reviewReason ?? "").includes(ZERO_RATE_REVIEW_NOTE);
}

export async function settleDayWithinTx(
    tx: Tx,
    userId: string,
    dayKey: string,
    closing?: { id: string; mealSkipped: unknown } | null
): Promise<number> {
    // Payroll lock first, then the day lock (see LOCK ORDER in payroll-period.ts).
    await assertSettlementDayUnlocked(tx, userId, dayKey);
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayLockKey(userId, dayKey));
    return settleDayInTx(tx, userId, dayKey, closing, { alreadyGuarded: true });
}

/** Payroll guard for a settlement: takes the shared payroll advisory lock and refuses a locked day. */
async function assertSettlementDayUnlocked(tx: Tx, userId: string, dayKey: string): Promise<void> {
    void userId;
    const { assertDayUnlockedInTx } = await import("./payroll-period");
    const { resolveCompanyTimeZone } = await import("./company-timezone");
    await assertDayUnlockedInTx(tx as never, dayKey, await resolveCompanyTimeZone());
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** The re-plan itself; the caller holds the day's advisory lock on `tx`. */
async function settleDayInTx(
    tx: Tx,
    userId: string,
    dayKey: string,
    closing?: { id: string; mealSkipped: unknown } | null,
    options: { alreadyGuarded?: boolean } = {}
): Promise<number> {
    {
        {
            // A re-plan rewrites durationHours / laborCost / burdenCost for the
            // whole day, so it is a payroll write like any other and must not
            // touch a locked period. Callers that already took the payroll lock
            // (in the right order, BEFORE the day lock) pass alreadyGuarded.
            if (!options.alreadyGuarded) {
                const { assertDayUnlockedInTx } = await import("./payroll-period");
                const { resolveCompanyTimeZone } = await import("./company-timezone");
                await assertDayUnlockedInTx(tx as never, dayKey, await resolveCompanyTimeZone());
            }

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
                where: { userId, endTime: { not: null }, startTime: dayWindow(dayKey) },
                select: {
                    id: true, startTime: true, endTime: true, mealOutcome: true, mealSkipStatus: true, reviewReason: true,
                    shiftHours: true, mealDeductionHours: true, durationHours: true, needsReview: true,
                },
            });
            const day = rows
                .filter((row): row is typeof row & { endTime: Date } => row.endTime != null)
                .filter((row) => toCompanyDayKey(row.startTime) === dayKey);
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
        const actualDay = toCompanyDayKey(victim.startTime);

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
            await settleDayInTx(tx, victim.userId, dayKey, null);
        }
    });
}

/** Id of the worker's latest CLOSED entry on a company-local day (null when none) — the row that carries the day's outcome. */
export async function latestClosedEntryIdOnDay(userId: string, dayKey: string): Promise<string | null> {
    const rows = await prisma.timeEntry.findMany({
        where: { userId, endTime: { not: null }, startTime: dayWindow(dayKey) },
        select: { id: true, startTime: true, endTime: true },
    });
    const day = rows.filter((row) => row.endTime != null && toCompanyDayKey(row.startTime) === dayKey);
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
