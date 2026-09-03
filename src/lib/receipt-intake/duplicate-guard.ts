import type { Prisma } from "@prisma/client";

/**
 * THE DUPLICATE POINTER IS A ONE-HOP RELATION, AND STAYS ONE (Codex PR #443
 * gate round 39, finding 2).
 *
 * `ReceiptIntake.duplicateOfId` means "this row is a copy of that ORIGINAL".
 * Marking a row duplicate already refuses a target that is itself DUPLICATE or
 * VOID, which stops a chain being built downwards — and nothing stopped one
 * being built UPWARDS, or the original being taken away afterwards:
 *
 *   * A→B exists; B is then marked a duplicate of C. Now A points at a row that
 *     is itself a copy, which is exactly the "duplicate of a duplicate of..."
 *     the target check exists to prevent — built from the other end.
 *   * A→B exists; B is voided. A now points at a cancelled receipt, so the
 *     receipt A duplicates does not exist as far as the pipeline is concerned.
 *   * The intake worker reclassifies B — still mid-routing, so still eligible —
 *     to DUPLICATE, with the same result and nobody watching.
 *
 * All three are the same missing rule: a row that is the ORIGINAL for anything
 * may not stop being one. The rule is enforced by refusing, not by rewriting:
 * retargeting A→C automatically would be a second guess about which receipt is
 * the real original, made without the human who made the first one. Unmarking
 * A is one click, and it is the click that says so.
 *
 * ONE LOCKING STATEMENT, ORDERED BY ID. Every caller locks the rows it is about
 * to judge AND everything pointing at them in a single `FOR UPDATE` ordered by
 * id, so two transactions racing for the same rows take them in the same
 * sequence and one waits instead of deadlocking. Reading inbound references
 * without locking them is the same TOCTOU the pair lock already exists for: a
 * concurrent mark could add A→B between the check and the write.
 */

/**
 * Just enough of a client for the lock AND the write it protects — the
 * transaction, or a test double. `receiptIntake` rides along because the whole
 * point of `withDuplicateChainLock` is that the caller writes inside the same
 * transaction that took the lock (round-40 gate, finding 1).
 */
export type DuplicateGuardClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "receiptIntake">;

interface LockedRow { id: string; duplicateOfId: string | null }

/**
 * Lock `ids` and every row that points at one of them, and report the inbound
 * references found, per id.
 *
 * The returned map holds an entry for each requested id, so a caller reads
 * `inbound.get(id) ?? []` and never has to distinguish "no references" from
 * "row not found" by the shape of the result.
 */
export async function lockWithInboundDuplicates(
    tx: DuplicateGuardClient,
    ids: readonly string[],
): Promise<Map<string, string[]>> {
    const wanted = [...new Set(ids)].sort();
    const inbound = new Map<string, string[]>(wanted.map(id => [id, []]));
    if (wanted.length === 0) return inbound;

    // Two ids at most in every caller today; written for any number so a future
    // one cannot quietly take a second lock in a second statement.
    const rows = wanted.length === 1
        ? await tx.$queryRaw<LockedRow[]>`
            SELECT "id", "duplicateOfId" FROM "ReceiptIntake"
             WHERE "id" = ${wanted[0]} OR "duplicateOfId" = ${wanted[0]}
             ORDER BY "id"
             FOR UPDATE`
        : await tx.$queryRaw<LockedRow[]>`
            SELECT "id", "duplicateOfId" FROM "ReceiptIntake"
             WHERE "id" IN (${wanted[0]}, ${wanted[1]})
                OR "duplicateOfId" IN (${wanted[0]}, ${wanted[1]})
             ORDER BY "id"
             FOR UPDATE`;

    for (const row of rows) {
        if (row.duplicateOfId === null) continue;
        const list = inbound.get(row.duplicateOfId);
        // A row pointing at something outside `wanted` was locked only because
        // it shares the statement; it is not this call's business.
        if (list && row.id !== row.duplicateOfId) list.push(row.id);
    }
    for (const list of inbound.values()) list.sort();
    return inbound;
}

/**
 * The refusal, worded for the person who clicked.
 *
 * Names the referencing ids: "something else points at this" is not actionable,
 * and the fix is to open those rows and unmark them.
 */
export function duplicateChainRefusal(action: "duplicate" | "void", inbound: readonly string[]): Error {
    const subject = inbound.length === 1 ? "receipt" : "receipts";
    const verb = action === "void" ? "voided" : "marked a duplicate";
    return new Error(
        `This receipt can't be ${verb} — ${inbound.length} other ${subject} `
        + `${inbound.length === 1 ? "is" : "are"} filed as duplicates of it (${inbound.join(", ")}). `
        + "Unmark those first, or point them at the right original.",
    );
}

/**
 * ONE TRANSACTION: TAKE THE LOCK, ANSWER THE QUESTION, DO THE WRITE (Codex PR
 * #443 gate round 40, finding 1).
 *
 * Round 39 gave the manual paths a locked check and left the worker with an
 * unlocked one — a read, then a transition in a separate statement — so an
 * admin committing A→B in between produced exactly the chain the guard exists
 * to prevent, from the one caller that runs unattended every five minutes.
 *
 * The lock and the write have to be the same transaction, and the only way to
 * be sure of that for every caller is to make the guard own it: `body` runs
 * INSIDE the transaction that took the lock, and gets the inbound references
 * as an argument rather than fetching them itself. A caller cannot skip the
 * lock, take it late, or hold it for a shorter span than its own write.
 */
export async function withDuplicateChainLock<T>(
    transaction: <R>(fn: (tx: DuplicateGuardClient) => Promise<R>) => Promise<R>,
    ids: readonly string[],
    body: (tx: DuplicateGuardClient, inbound: Map<string, string[]>) => Promise<T>,
): Promise<T> {
    return transaction(async tx => body(tx, await lockWithInboundDuplicates(tx, ids)));
}

/** The worker's own note when it refuses to reclassify an original. */
export function duplicateChainReason(inbound: readonly string[]): string {
    return `duplicate-chain:${inbound.slice(0, 3).join(",")}`;
}
