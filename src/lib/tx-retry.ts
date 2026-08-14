import { Prisma } from "@prisma/client";

/**
 * Shared money-path concurrency helpers.
 *
 * Every transaction that settles/unsettles a milestone touches an Estimate row,
 * an Invoice row, or both (they are mirrored copies linked by
 * `PaymentSchedule.sourceScheduleId`). To stay deadlock-free those transactions
 * must acquire their row locks in ONE global order. The canonical order is:
 *
 *     Estimate  →  Invoice  →  child schedule rows
 *
 * Callers lock the parent row(s) FOR UPDATE at the TOP of the transaction (via
 * `lockMoneyParents`), BEFORE reading sibling schedules or computing aggregates.
 * That serialization is what prevents the invoice-side lost update: two payments
 * on different milestones of the same invoice can no longer each read a stale
 * sibling set and overwrite each other's balanceDue — the second waits on the
 * Invoice lock until the first commits, then recomputes against fresh state.
 *
 * A residual deadlock (40P01) or serialization failure (40001) can still be
 * raised by Postgres in rare inversions; in every such case the transaction
 * rolled back cleanly, so `withTxRetry` re-runs the whole thing against fresh
 * state. This turns an otherwise-unrecoverable deadlock into a transparent retry.
 */

/**
 * True when a caught error came from a rolled-back transaction that is safe to
 * re-run: Prisma write-conflict / deadlock (P2034), interactive-transaction
 * timeout (P2028), or a raw-query failure carrying a Postgres deadlock (40P01) /
 * serialization (40001) code.
 */
export function isRetryableTxError(e: any): boolean {
    // P2034: Prisma's documented write-conflict / deadlock transaction error.
    // P2028: interactive-transaction timeout — a payment can hit this while waiting
    //   on an Estimate/Invoice row lock a large saveEstimate holds; the tx rolled
    //   back, so re-running is safe.
    if (e?.code === "P2034" || e?.code === "P2028") return true;
    // A deadlock on the `SELECT ... FOR UPDATE` itself surfaces as a P2010 raw-query
    // error carrying the underlying Postgres code (40P01 deadlock / 40001
    // serialization) in meta.code.
    const pg = e?.meta?.code;
    if (pg === "40P01" || pg === "40001") return true;
    return /deadlock detected|could not serialize|40P01|40001/i.test(String(e?.message ?? ""));
}

/**
 * Run `fn` (typically a `prisma.$transaction(...)` call), retrying with jittered
 * backoff when it fails with a retryable, cleanly-rolled-back transaction error.
 * A non-retryable error propagates immediately. The last attempt's error is
 * re-thrown so callers see the original failure.
 */
export async function withTxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            lastErr = e;
            if (!isRetryableTxError(e) || i === attempts - 1) throw e;
            // Backoff with jitter so two contenders don't immediately re-collide in lockstep.
            await new Promise((r) => setTimeout(r, 25 * (i + 1) + Math.floor(Math.random() * 25)));
        }
    }
    throw lastErr;
}

/**
 * Take the canonical money-path row locks at the top of a transaction:
 * Estimate first, then Invoice. Pass whichever ids the flow will touch; a
 * null/undefined id skips that row, and a missing row locks nothing (the
 * caller's own existence checks still handle "not found"). Because every
 * money-path transaction locks in this same order, no two can deadlock on the
 * Estimate/Invoice pair.
 */
export async function lockMoneyParents(
    tx: Prisma.TransactionClient,
    ids: { estimateId?: string | null; invoiceId?: string | null },
): Promise<void> {
    if (ids.estimateId) {
        await tx.$queryRaw`SELECT id FROM "Estimate" WHERE id = ${ids.estimateId} FOR UPDATE`;
    }
    if (ids.invoiceId) {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${ids.invoiceId} FOR UPDATE`;
    }
}

/**
 * Multi-parent variant of `lockMoneyParents`, for flows that legitimately span
 * several Estimates/Invoices at once — a refunded Stripe charge can be recorded
 * on milestone rows belonging to more than one document (see `refund-group.ts`).
 *
 * Keeps the same global Estimate → Invoice direction, and adds a second rule so
 * two such transactions can't deadlock against each other: within a table the
 * ids are locked in ascending order. Single-id callers of `lockMoneyParents`
 * are trivially consistent with that ordering, so the two helpers interleave
 * safely. Locked one row per statement rather than one `= ANY(...) ORDER BY`
 * query so the acquisition order is explicit rather than plan-dependent.
 */
export async function lockMoneyParentsMany(
    tx: Prisma.TransactionClient,
    ids: { estimateIds?: readonly string[]; invoiceIds?: readonly string[] },
): Promise<void> {
    for (const estimateId of [...new Set(ids.estimateIds ?? [])].sort()) {
        await tx.$queryRaw`SELECT id FROM "Estimate" WHERE id = ${estimateId} FOR UPDATE`;
    }
    for (const invoiceId of [...new Set(ids.invoiceIds ?? [])].sort()) {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
    }
}
