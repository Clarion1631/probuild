import type { Prisma } from "@prisma/client";

/**
 * THE BANK LEDGER'S CHANGE COUNTER (Codex PR #443 gate round 37, finding 3).
 *
 * The missing-receipt chaser reads its window of `BankLine` once, judges it over
 * several pages, and then has to decide whether the picture it judged is still
 * the picture the database holds. Counting rows created since the snapshot
 * answered that question at ONE instant and then wrote the completion marker in
 * a separate statement — so a line committed in between was certified as chased
 * when nothing had looked at it, and a line whose DESCRIPTOR changed (which is
 * what decides the owner, and therefore who gets asked) was invisible to a
 * `createdAt` test entirely.
 *
 * This is the fence. Every writer that touches `BankLine` bumps this counter
 * FIRST, inside its own transaction; the chaser re-reads it under a row lock in
 * the same transaction that writes the phase marker. Two consequences, and both
 * are the point:
 *
 *   * A writer that has already bumped holds the row until it commits, so the
 *     chaser's read WAITS for it and then sees a different value — the cycle is
 *     held open rather than certifying a list that is short.
 *   * A writer that arrives while the chaser holds the row waits for the phase
 *     write to commit. Its rows are not in the database yet, so the list the
 *     chaser certified was complete at the instant it committed, which is the
 *     strongest true statement available.
 *
 * A COUNTER, not a timestamp: `updatedAt` cannot distinguish "changed twice"
 * from "changed once", and two writers in the same millisecond are ordinary.
 * It is monotonic and never reset; nothing reads its magnitude, only whether it
 * differs from what the reader saw.
 */
export const BANK_LEDGER_EPOCH_KEY = "bankLedgerEpoch";

/**
 * What a ledger that has never been written reads as.
 *
 * The row is created lazily, so "no row" and "no change since" have to be the
 * same answer — otherwise the very first fence would read its own row creation
 * as movement and hold every cycle open until something else wrote.
 */
export const BANK_LEDGER_EPOCH_ZERO = "0";

/** Anything that can run raw SQL: the client, an interactive transaction, or a test double. */
export type LedgerEpochClient = Pick<Prisma.TransactionClient, "$queryRaw">;

interface EpochRow { value: string }

/**
 * Bump the epoch. MUST be called inside the writer's own transaction and BEFORE
 * its `BankLine` writes.
 *
 * Before, because that is what makes the row lock a serialization point: the
 * bump takes the lock, so a chaser fencing at the same moment blocks until this
 * transaction commits and then sees the new value. A bump AFTER the writes
 * leaves a window where the rows are committed and the counter is not.
 */
export async function bumpBankLedgerEpoch(tx: LedgerEpochClient): Promise<void> {
    await tx.$queryRaw<EpochRow[]>`
        INSERT INTO "AutomationSetting" ("key", "value", "updatedAt")
        VALUES (${BANK_LEDGER_EPOCH_KEY}, '1', NOW())
        ON CONFLICT ("key") DO UPDATE
            SET "value" = (COALESCE(NULLIF("AutomationSetting"."value", ''), '0')::bigint + 1)::text,
                "updatedAt" = NOW()
        RETURNING "value"`;
}

/** Read the epoch without locking anything — the snapshot side of the fence. */
export async function readBankLedgerEpoch(client: LedgerEpochClient): Promise<string> {
    const rows = await client.$queryRaw<EpochRow[]>`
        SELECT "value" FROM "AutomationSetting" WHERE "key" = ${BANK_LEDGER_EPOCH_KEY}`;
    return rows[0]?.value ?? BANK_LEDGER_EPOCH_ZERO;
}

/**
 * Take the epoch row's lock and return its current value — the validation side.
 *
 * An upsert whose conflict branch writes the value back UNCHANGED, because a
 * plain `SELECT ... FOR UPDATE` locks nothing when the row does not exist yet:
 * on a fresh database the fence would be silently vacuous, which is the worst
 * shape a fence can have. This creates the row at zero when it is missing, so
 * "never written" fences exactly like "unchanged".
 */
export async function lockBankLedgerEpoch(tx: LedgerEpochClient): Promise<string> {
    const rows = await tx.$queryRaw<EpochRow[]>`
        INSERT INTO "AutomationSetting" ("key", "value", "updatedAt")
        VALUES (${BANK_LEDGER_EPOCH_KEY}, ${BANK_LEDGER_EPOCH_ZERO}, NOW())
        ON CONFLICT ("key") DO UPDATE SET "value" = "AutomationSetting"."value"
        RETURNING "value"`;
    return rows[0]?.value ?? BANK_LEDGER_EPOCH_ZERO;
}
