/**
 * Deleting a parent that owns time entries.
 *
 * TimeEntry used to CASCADE from both User and Project, so deleting a person or
 * a job silently destroyed their payroll history — including hours inside a
 * LOCKED period that had already been exported and paid, leaving a Gusto run
 * with nothing to reconcile against. Both foreign keys are RESTRICT now, which
 * turns that silent loss into a refusal; this module is the only sanctioned way
 * past it.
 *
 * The rule: hours in a locked period are never deleted, by anyone, for any
 * reason. Everything else is removed EXPLICITLY, under the payroll advisory
 * lock, in the same transaction as the parent — so a clock-in that lands
 * mid-delete either blocks on the lock or fails the foreign key, and can never
 * be quietly orphaned.
 */

import { toCompanyDayKey } from "@/lib/company-day";
import { dayLockKey, withPayrollWriteTx, type PayrollTxClient } from "@/lib/payroll-period";
import { prisma } from "@/lib/prisma";

export type TimeEntryParent = { userId: string } | { projectId: string };

/**
 * Remove a parent's time entries and then the parent, atomically.
 *
 * Throws PeriodLockedError (mapped to 423 PERIOD_LOCKED by the callers) if ANY
 * of those entries is frozen — the check is inside the transaction, under the
 * shared lock, because a period can be locked between reading the rows and
 * deleting them.
 */
export async function deleteParentWithTimeEntries(
    parent: TimeEntryParent,
    deleteParentRow: (tx: PayrollTxClient) => Promise<void>,
    /**
     * Injected in tests. The LOCKED branch throws out of withPayrollWriteTx, so
     * exercising it for real needs a database with a locked period in it; these
     * two seams let both branches be driven directly.
     */
    deps: {
        readEntries?: (where: object) => Promise<Array<{ id: string; userId: string; startTime: Date }>>;
        runWrite?: typeof withPayrollWriteTx;
    } = {}
): Promise<{ deletedEntries: number }> {
    const where = "userId" in parent ? { userId: parent.userId } : { projectId: parent.projectId };
    const readEntries =
        deps.readEntries ??
        ((scope: object) =>
            prisma.timeEntry.findMany({ where: scope as never, select: { id: true, userId: true, startTime: true } }));
    const runWrite = deps.runWrite ?? withPayrollWriteTx;

    // Read the ids and days OUTSIDE the transaction only to build the lock
    // target — the values are not trusted. withPayrollWriteTx re-reads every
    // row FOR UPDATE and validates its STORED startTime against the locked
    // periods, so a row moved in between is judged on where it actually is.
    const entries = await readEntries(where);

    const entryIds = entries.map((entry) => entry.id);
    // Qualified keys — the same `wa-breaks:<user>:<day>` form settlement uses.
    // A bare day key hashes to a DIFFERENT advisory lock, which would leave this
    // delete and a concurrent settlement holding two different locks and
    // believing they were serialized.
    const dayKeys = [
        ...new Set(entries.map((entry) => dayLockKey(entry.userId, toCompanyDayKey(entry.startTime)))),
    ].sort();

    return runWrite({ entryIds, dayKeys }, async (tx) => {
        const client = tx as unknown as typeof prisma;
        // Scoped by the PARENT, not by the id list: an entry created after the
        // read above would otherwise survive and block the parent delete with a
        // foreign-key error that names nothing useful.
        const removed = await client.timeEntry.deleteMany({ where });
        await deleteParentRow(tx);
        return { deletedEntries: removed.count };
    });
}
