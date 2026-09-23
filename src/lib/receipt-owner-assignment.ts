import type { Prisma, PrismaClient } from "@prisma/client";
import { bumpReceiptOwnerEpoch, lockReceiptEvidence } from "./receipt-evidence-lock";

/**
 * OWNER ASSIGNMENT, SERIALIZED AGAINST CARD CLAIMS (cheap-sweep-restart-spec.md
 * §14.2; Codex round 2 blocker 1).
 *
 * `setMissingReceiptOwner` is the only writer of `displayDetails.ownerOverride`
 * — the field that decides which owner's morning card an unattributed charge
 * lands on. Before this, that write went straight to `prisma.reviewIssue`,
 * with no lock at all: a reassignment landing between a card run's scan and
 * its claim was invisible to both epochs the claim checks, so a card could be
 * claimed (and the owner's day used up) missing an item that had just moved
 * onto it.
 *
 * This wraps the same version-CAS'd `updateMany` in one transaction that
 * takes the evidence lock — the global order's outermost lock (§14.0) — and
 * bumps the owner epoch whenever the write actually lands. `claimOwnerDay`
 * (§14.9) reads that epoch under the same lock before it claims, so a
 * reassignment the scan already priced in and one that lands after it can
 * never be confused for each other.
 *
 * Every abort here is a safe drop: nothing is written, the caller turns any
 * thrown error into "the list is busy" (§14.0), and the issue keeps its old
 * owner until the next attempt succeeds.
 */
export async function writeReceiptOwnerLocked(
    db: Pick<PrismaClient, "$transaction">,
    input: { issueId: string; expectedVersion: number; displayDetailsJson: string; now: Date },
): Promise<number> {
    return db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await lockReceiptEvidence(tx);
        const result = await tx.reviewIssue.updateMany({
            where: { id: input.issueId, version: input.expectedVersion, clearedAt: null },
            data: { displayDetails: input.displayDetailsJson, version: { increment: 1 }, updatedAt: input.now },
        });
        if (result.count === 1) await bumpReceiptOwnerEpoch(tx);
        return result.count;
    }, { timeout: 8_000, maxWait: 2_000 });
}
