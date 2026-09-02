// ONE lock, one key, for every writer that touches an Expense's attribution or
// its tax classification.
//
// Three writers can reach the same row concurrently:
//   * the QBO sync's upsert,
//   * the bookkeeper's tax PATCH, and
//   * the receipt pipeline's fill for an already-booked Purchase.
//
// Each of them previously guarded itself with a compare-and-set, which stops a
// LOST UPDATE but not a torn one: a writer can still read a row, have another
// writer change several columns, and then apply a decision that was coherent
// only against the values it first saw. The tax invariants span columns —
// `taxDeductibleBase <= amount - taxAmount`, and the authorization that decided
// who may touch the row at all rests on its project — so "each column was
// written under a valid predicate" is not the same as "the row is valid".
//
// Serialising the three on a per-row advisory lock makes the read-decide-write
// sequence atomic with respect to each other. The CAS predicates stay: the lock
// orders writers that take it, the predicate is what still protects against one
// that does not (a migration, a script, a future path someone forgets to wire).
//
// `pg_advisory_xact_lock` releases at COMMIT or ROLLBACK, so there is no unlock
// to forget and a crashed transaction cannot strand the row.

/** Structural subset of a Prisma transaction client this needs. */
export interface AdvisoryLockClient {
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/**
 * The namespaced key. `expense:` keeps these from colliding with the QBO
 * sync's per-PURCHASE lock, which is a different scope: one Purchase can be
 * looked up by id while the Expense it maps to is being edited by a human.
 */
export function expenseLockKey(expenseId: string): string {
    return `expense:${expenseId}`;
}

/**
 * Take the per-expense lock for the rest of the transaction.
 *
 * `hashtextextended` is used rather than `hashtext` because it returns bigint
 * directly — `pg_advisory_xact_lock` takes a bigint, and the 32-bit `hashtext`
 * would have to be widened anyway while colliding far more often. A collision
 * is harmless (two unrelated expenses serialise needlessly), but rarer is
 * better when the alternative costs nothing.
 */
export async function lockExpense(
    client: AdvisoryLockClient,
    expenseId: string,
): Promise<void> {
    await client.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_result",
        expenseLockKey(expenseId),
    );
}


/**
 * SHARE-LOCK A JOB'S PHASE ROWS for the rest of the transaction.
 *
 * "Is this cost code a phase of this job?" is answered from `EstimateItem`
 * rows, which anyone with the estimate open can delete. Two writers depend on
 * that answer being still true when they act on it — the receipt booking, which
 * posts real money against the phase, and the attribution backfill, which
 * writes a code onto historical rows — and neither can express the question as
 * a predicate on the row it is writing.
 *
 * `FOR SHARE OF ei` blocks an UPDATE or DELETE of those rows until this
 * transaction commits, while leaving other readers (including the other writer)
 * free. Ordered by id so two holders can never take them in opposite orders.
 */
export async function lockProjectPhaseRowsForShare(
    client: AdvisoryLockClient,
    projectId: string | null,
): Promise<void> {
    if (!projectId) return;
    await client.$queryRawUnsafe(
        `SELECT ei.id FROM "EstimateItem" ei
           JOIN "Estimate" e ON e.id = ei."estimateId"
          WHERE e."projectId" = $1 AND ei."costCodeId" IS NOT NULL
          ORDER BY ei.id
            FOR SHARE OF ei`,
        projectId,
    );
}
