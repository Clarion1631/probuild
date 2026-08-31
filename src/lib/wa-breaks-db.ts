// The one Prisma-backed reader/writer for src/lib/wa-breaks.ts — both clock-out
// paths (PUT /api/time-entries and PATCH /api/time-entries/[id]) must see the
// SAME "rest of the day", so they share this rather than each hand-rolling it.
import { prisma } from "@/lib/prisma";
import { toCompanyDayKey } from "@/lib/company-day";
import { toNum } from "@/lib/prisma-helpers";
import { SETTLEMENT_FAILED_NOTE, settleDayPlan, type DayEntry } from "@/lib/wa-breaks";
import { checkDeleteAllowed, DeleteRefusedError, type DeleteActor } from "@/lib/time-entry-delete-policy";

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
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `wa-breaks:${userId}:${dayKey}`);
            return settleDayInTx(tx, userId, dayKey, closing);
        });
    } catch (error) {
        console.error("[wa-breaks] settleDay failed", { userId, dayKey }, error);
        return -1;
    }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** The re-plan itself; the caller holds the day's advisory lock on `tx`. */
async function settleDayInTx(
    tx: Tx,
    userId: string,
    dayKey: string,
    closing?: { id: string; mealSkipped: unknown } | null
): Promise<number> {
    {
        {
            const owner = await tx.user.findUnique({ where: { id: userId }, select: { hourlyRate: true, burdenRate: true } });
            if (!owner) return 0;
            const hourlyRate = toNum(owner.hourlyRate);
            const burdenRate = toNum(owner.burdenRate);

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
                const same =
                    Math.abs((row.durationHours ?? -1) - update.paidHours) < 1e-9 &&
                    Math.abs((row.mealDeductionHours ?? 0) - update.mealDeductionHours) < 1e-9 &&
                    row.mealOutcome === update.mealOutcome &&
                    !flagsChange;
                if (same) continue;
                await tx.timeEntry.update({
                    where: { id: update.id },
                    data: {
                        shiftHours: update.shiftHours,
                        mealDeductionHours: update.mealDeductionHours,
                        durationHours: update.paidHours,
                        mealOutcome: update.mealOutcome,
                        laborCost: update.paidHours * hourlyRate,
                        burdenCost: update.paidHours * burdenRate,
                        ...(update.reviewReason !== undefined ? { reviewReason: update.reviewReason } : {}),
                        ...(update.needsReview !== undefined ? { needsReview: update.needsReview } : {}),
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
    ownerGuard?: DeleteActor
): Promise<"deleted" | "gone"> {
    return prisma.$transaction((tx) => deleteEntryAndSettleInTx(tx, entryId, knownDayKey, userId, ownerGuard));
}

const DELETE_VICTIM_SELECT = {
    userId: true, startTime: true, createdAt: true,
    invoiceId: true, invoicedAt: true, qbTimeActivityId: true, qbSyncedAt: true,
} as const;

/**
 * The body of deleteEntryAndSettle, on a caller-supplied transaction (exported so
 * tests can drive it with a fake `tx`).
 *
 * `ownerGuard` = the non-privileged actor deleting their OWN entry
 * (src/lib/time-entry-delete-policy.ts). When set, the policy is re-checked on the
 * row as read INSIDE the transaction, and the delete itself is a conditional
 * `deleteMany` that only removes a row which STILL belongs to that user and STILL has
 * no invoice / QuickBooks link — so an invoice or QBO sync landing between the
 * route's pre-check and this delete cannot be erased (Codex gate, PR #434: the
 * pre-check alone was a TOCTOU). A lost claim throws DeleteRefusedError, which rolls
 * the transaction back; the route answers 409. Privileged callers pass no guard and
 * delete unconditionally, exactly as before.
 */
export async function deleteEntryAndSettleInTx(
    tx: Tx,
    entryId: string,
    knownDayKey: string,
    userId: string,
    ownerGuard?: DeleteActor
): Promise<"deleted" | "gone"> {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `wa-breaks:${userId}:${knownDayKey}`);
    const victim = await tx.timeEntry.findUnique({ where: { id: entryId }, select: DELETE_VICTIM_SELECT });
    if (!victim) return "gone"; // already gone
    if (ownerGuard) {
        const check = checkDeleteAllowed(ownerGuard, victim);
        if (!check.ok) throw new DeleteRefusedError(check.code);
    }
    const actualDay = toCompanyDayKey(victim.startTime);
    if (actualDay !== knownDayKey) {
        // Moved since the caller read it — take that day's lock as well
        // (deterministic order: keys sorted, so two deletes cannot deadlock).
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `wa-breaks:${victim.userId}:${actualDay}`);
    }
    if (ownerGuard) {
        const claimed = await tx.timeEntry.deleteMany({
            where: {
                id: entryId,
                userId: ownerGuard.id,
                invoiceId: null,
                invoicedAt: null,
                qbTimeActivityId: null,
                qbSyncedAt: null,
            },
        });
        if (claimed.count === 0) {
            // Lost the claim: explain with the row as it is now (or it vanished meanwhile).
            const current = await tx.timeEntry.findUnique({ where: { id: entryId }, select: DELETE_VICTIM_SELECT });
            if (!current) return "gone";
            const check = checkDeleteAllowed(ownerGuard, current);
            throw new DeleteRefusedError(check.ok ? "LOCKED_DOWNSTREAM" : check.code);
        }
    } else {
        await tx.timeEntry.delete({ where: { id: entryId } });
    }
    for (const dayKey of new Set([knownDayKey, actualDay])) {
        await settleDayInTx(tx, victim.userId, dayKey, null);
    }
    return "deleted";
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
