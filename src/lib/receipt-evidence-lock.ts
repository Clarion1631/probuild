import type { Prisma } from "@prisma/client";

/**
 * THE RECEIPT-EVIDENCE LOCK (Codex PR #443 gate round 42, finding 1).
 *
 * The missing-receipt sweep decides, per competing component, whether a bank
 * line still owes a receipt — from evidence it READ: ReceiptIntake rows and
 * Expense receipt linkage. Its own advisory lock serializes it against other
 * sweeps, and its row locks cover rows that already exist. Neither stops a
 * receipt landing between the read and the write.
 *
 * SERIALIZABLE WAS TRIED AND DOES NOT DO THIS (round 41; measured on CI run
 * 33751439581). Postgres SSI aborts only to break a rw-antidependency CYCLE;
 * a sweep that reads evidence and writes ReviewIssue rows nobody reads has one
 * rw edge, so the schedule is already equivalent to "sweep, then insert" and no
 * 40001 is due. Worse, snapshot isolation blinds the sweep's own in-transaction
 * re-read, which is the check that does catch a concurrent commit.
 *
 * So the fence is explicit and shared: ONE advisory lock that every writer of
 * receipt evidence takes inside its own transaction, before writing, and that
 * the sweep holds across its reads AND its ReviewIssue writes. A writer that
 * arrives mid-sweep blocks until the sweep commits, and is then seen by the
 * next pass; a sweep that arrives mid-write waits for the writer and reads the
 * committed truth.
 *
 * TRANSACTION-SCOPED (`_xact_`), because pgbouncer's transaction pooling makes
 * session locks unusable here — the same reason every other lock in this
 * codebase is xact-scoped.
 *
 * LOCK ORDER, so nothing here can deadlock: this lock is the OUTERMOST. A
 * transaction that needs it takes it FIRST, before the component lock, the
 * bank-line identity lock, or any `SELECT ... FOR UPDATE`.
 *
 * Writers hold it only for their own short transaction — a claim update, a
 * state transition, one booking. It is not held across a QuickBooks call or a
 * Drive download.
 */
export const RECEIPT_EVIDENCE_LOCK = "receipt-evidence";

/** Anything that can run raw SQL: an interactive transaction, or a test double. */
export interface EvidenceLockClient {
    /**
     * Structural, not `Pick<Prisma.TransactionClient>`: the receipt-intake
     * transaction clients are hand-written interfaces (BookPrismaClient,
     * RejectTxClient) so their fakes stay small, and they satisfy this shape
     * without importing Prisma metadata types.
     */
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * The client a locked BODY gets: the lock plus the models a receipt-evidence
 * writer touches. Narrow on purpose — a writer that needs something else is a
 * writer worth looking at.
 */
export type EvidenceWriteClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw" | "receiptIntake" | "expense" | "reviewIssue">;

/**
 * Take the receipt-evidence lock. Call it as the FIRST statement of the
 * transaction that is about to read or write receipt evidence.
 *
 * `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns void, and
 * reading that column can throw (the lesson from the intake claim path).
 */
export async function lockReceiptEvidence(tx: EvidenceLockClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECEIPT_EVIDENCE_LOCK}))`;
}


/**
 * THE RECEIPT-EVIDENCE EPOCH (Codex PR #443 gate round 43, finding 4).
 *
 * The lock above fences ONE component transaction. The sweep is not one
 * transaction: it walks components across pages, taking and releasing the lock
 * per component, and certifies the whole cycle complete at the end. Between a
 * component committing and that certification, an intake can be voided or
 * unlinked — and the completion fence only checked `bankLedgerEpoch`, which
 * says nothing about evidence. The cycle then stamped itself done over an issue
 * it had closed on evidence that no longer existed.
 *
 * So evidence gets a counter of its own, exactly the shape of the bank-ledger
 * one: monotonic, never reset, nobody reads its magnitude — only whether it
 * differs from what the sweep saw when it started. Bumped by every evidence
 * writer INSIDE the evidence lock, which is what makes the bump ordered with
 * respect to the sweep's own reads rather than racing them.
 */
export const RECEIPT_EVIDENCE_EPOCH_KEY = "receiptEvidenceEpoch";

/**
 * What an evidence store that has never been written reads as.
 *
 * The row is created lazily, so "no row" and "no change since" must be the same
 * answer, or the first cycle on a fresh database would fence against its own
 * row creation and never certify.
 */
export const RECEIPT_EVIDENCE_EPOCH_ZERO = "0";

/**
 * Anything that can run a raw query: a transaction, the client, or a double.
 *
 * Structural for the same reason `EvidenceLockClient` is — the receipt-intake
 * transaction clients are hand-written interfaces, not Prisma types.
 */
export interface EvidenceEpochClient {
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface EpochRow { value: string }

/**
 * Record that receipt evidence changed. Call it inside the transaction that
 * holds the evidence lock, alongside the write.
 *
 * Held under the lock on purpose: a sweep reading the epoch at cycle start
 * cannot interleave with a bump, so "the epoch I saw" and "the evidence I read"
 * describe the same moment.
 */
export async function bumpReceiptEvidenceEpoch(tx: EvidenceEpochClient): Promise<void> {
    await tx.$queryRaw<EpochRow[]>`
        INSERT INTO "AutomationSetting" ("key", "value", "updatedAt")
        VALUES (${RECEIPT_EVIDENCE_EPOCH_KEY}, '1', NOW())
        ON CONFLICT ("key") DO UPDATE
            SET "value" = (COALESCE(NULLIF("AutomationSetting"."value", ''), '0')::bigint + 1)::text,
                "updatedAt" = NOW()
        RETURNING "value"`;
}

/** Read the epoch. The snapshot side of the completion fence. */
export async function readReceiptEvidenceEpoch(client: EvidenceEpochClient): Promise<string> {
    const rows = await client.$queryRaw<EpochRow[]>`
        SELECT "value" FROM "AutomationSetting" WHERE "key" = ${RECEIPT_EVIDENCE_EPOCH_KEY}`;
    return rows[0]?.value ?? RECEIPT_EVIDENCE_EPOCH_ZERO;
}

/**
 * Run one short transaction that holds the evidence lock.
 *
 * The wrapper exists so a bare write — `prisma.receiptIntake.updateMany(...)`,
 * which is its own implicit transaction and therefore cannot hold an xact-scoped
 * lock — becomes a locked one without every call site rebuilding the same
 * three lines. Callers that already own a transaction call
 * `lockReceiptEvidence(tx)` as its first statement instead.
 */
export async function withReceiptEvidenceLock<T>(
    transaction: (fn: (tx: EvidenceWriteClient) => Promise<T>) => Promise<unknown>,
    body: (tx: EvidenceWriteClient) => Promise<T>,
): Promise<T> {
    return await transaction(async tx => {
        await lockReceiptEvidence(tx);
        const result = await body(tx);
        // EVERY write through this wrapper moves the epoch (round-43 gate,
        // finding 4). Doing it here rather than at each call site is the point:
        // the wrapper is already the thing that cannot be skipped, so the
        // counter cannot fall behind the writes it describes.
        await bumpReceiptEvidenceEpoch(tx as unknown as EvidenceEpochClient);
        return result;
    }) as T;
}
