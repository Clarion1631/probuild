/**
 * Deleting parents that own time entries.
 *
 * TimeEntry used to CASCADE from both User and Project, so deleting a person or
 * a job silently destroyed their payroll history — including hours inside a
 * LOCKED period that had already been exported and paid, leaving a Gusto run
 * with nothing to reconcile against. Both foreign keys are RESTRICT now, which
 * turns that silent loss into a refusal; this module is the only sanctioned way
 * past it.
 *
 * The rule: hours in a locked period are never deleted, by anyone, for any
 * reason. Everything else is removed EXPLICITLY, in one transaction with the
 * parents, and only after every row has been checked.
 *
 * DISCOVERY HAPPENS INSIDE THE TRANSACTION, under the shared payroll advisory
 * lock, ALWAYS — including when the caller's world looks empty. Reading first
 * and locking second left two holes: a parent with no entries took no lock at
 * all (the lock target was empty, so the guard returned early), and a row that
 * appeared between the read and the write was deleted without ever being
 * checked against a locked period.
 */

import { toCompanyDayKey } from "@/lib/company-day";
import {
    acquirePayrollWriteLock,
    assertEntriesUnlockedInTx,
    dayLockKey,
    type PayrollTxClient,
} from "@/lib/payroll-period";
import { prisma } from "@/lib/prisma";

export type TimeEntryParent = { userId: string } | { projectId: string };

type DiscoveredEntry = { id: string; userId: string; startTime: Date };

function scopeOf(parent: TimeEntryParent) {
    return "userId" in parent ? { userId: parent.userId } : { projectId: parent.projectId };
}

/**
 * Raised when a time entry is created for one of these parents after the
 * delete has already checked and removed everything it could see.
 *
 * Aborting is the only safe answer: the new row has NOT been validated against
 * the locked periods, and deleting it anyway is exactly the silent destruction
 * this module exists to prevent. The caller retries, and the second pass sees
 * the row properly.
 */
export class ConcurrentTimeEntryError extends Error {
    constructor(count: number) {
        super(
            `${count} time ${count === 1 ? "entry" : "entries"} were created while this delete was running. Nothing was deleted — try again.`
        );
        this.name = "ConcurrentTimeEntryError";
    }
}

export function isConcurrentTimeEntryError(error: unknown): error is ConcurrentTimeEntryError {
    return error instanceof Error && error.name === "ConcurrentTimeEntryError";
}

export type ParentDeleteDeps = {
    /** Injected in tests so both the locked and the raced branch can be driven directly. */
    runTransaction?: <T>(fn: (tx: PayrollTxClient) => Promise<T>) => Promise<T>;
};

/**
 * Remove several parents' time entries and then the parents, atomically.
 *
 * ONE transaction for the whole set: every parent is checked before any parent
 * is deleted, so a single locked period rolls the entire batch back rather than
 * leaving half a list deleted and the caller told it succeeded.
 *
 * Throws PeriodLockedError (mapped to 423 PERIOD_LOCKED where a status code is
 * available) if any entry is frozen, and ConcurrentTimeEntryError if a new
 * entry appears mid-delete.
 */
export async function deleteParentsWithTimeEntries(
    parents: TimeEntryParent[],
    deleteParentRows: (tx: PayrollTxClient) => Promise<void>,
    deps: ParentDeleteDeps = {}
): Promise<{ deletedEntries: number }> {
    const scopes = parents.map(scopeOf);
    const runTransaction =
        deps.runTransaction ?? (<T,>(fn: (tx: PayrollTxClient) => Promise<T>) => prisma.$transaction(fn as never) as Promise<T>);

    return runTransaction(async (tx) => {
        const client = tx as unknown as typeof prisma;

        // 1. The shared payroll lock, ALWAYS and FIRST — before anything is even
        //    read. Deferring it to the guard meant a parent that happened to
        //    have no entries took no lock, so a clock-in could land between the
        //    look and the delete with nothing serializing the two.
        await acquirePayrollWriteLock(tx);

        // 2. Discovery, now that the lock is held. Everything below is checked
        //    against THIS set; nothing outside it is ever deleted.
        const discovered: DiscoveredEntry[] = scopes.length
            ? await client.timeEntry.findMany({
                  where: { OR: scopes as never },
                  select: { id: true, userId: true, startTime: true },
              })
            : [];

        const entryIds = [...new Set(discovered.map((entry) => entry.id))].sort();
        // Qualified keys — the same `wa-breaks:<user>:<day>` form settlement
        // uses. A bare day key hashes to a DIFFERENT advisory lock, which would
        // leave this delete and a concurrent settlement holding two different
        // locks and believing they were serialized.
        const dayKeys = [
            ...new Set(discovered.map((entry) => dayLockKey(entry.userId, toCompanyDayKey(entry.startTime)))),
        ].sort();

        // 3. Day locks, then FOR UPDATE on the discovered rows, then the
        //    locked-period check against their STORED startTimes. Throws
        //    PeriodLockedError, which aborts the whole transaction.
        await assertEntriesUnlockedInTx(tx, entryIds, { dayKeys });

        // 4. Delete by the CHECKED id set. Scoping this by the parent instead
        //    would sweep up any row that appeared since discovery — a row no
        //    locked-period check has ever seen.
        const removed = entryIds.length
            ? await client.timeEntry.deleteMany({ where: { id: { in: entryIds } } })
            : { count: 0 };

        // 5. Anything left under these parents appeared while we were working.
        //    It is unchecked, so it is not ours to delete: abort and let the
        //    caller retry, rather than destroying it or failing later on an
        //    opaque foreign-key error.
        const leftover = scopes.length
            ? await client.timeEntry.count({ where: { OR: scopes as never } })
            : 0;
        if (leftover > 0) throw new ConcurrentTimeEntryError(leftover);

        await deleteParentRows(tx);
        return { deletedEntries: removed.count };
    });
}

/** One parent. Same guarantees — this is the shape the users route needs. */
export async function deleteParentWithTimeEntries(
    parent: TimeEntryParent,
    deleteParentRow: (tx: PayrollTxClient) => Promise<void>,
    deps: ParentDeleteDeps = {}
): Promise<{ deletedEntries: number }> {
    return deleteParentsWithTimeEntries([parent], deleteParentRow, deps);
}
