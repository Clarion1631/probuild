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
 * The rule: a parent with ANY time entries — locked or not — is never deleted.
 * An earlier version of this module deleted the unlocked ones and refused only
 * the locked ones, on the theory that "unlocked" meant safe. It does not:
 * production's paid history predates PayrollPeriod entirely, so every one of
 * those rows reads as unlocked forever and that version destroyed them
 * silently. The only parent this module will ever remove is one with ZERO
 * time entries, full stop.
 *
 * DISCOVERY HAPPENS INSIDE THE TRANSACTION, under the shared payroll advisory
 * lock, ALWAYS — including when the caller's world looks empty. Reading first
 * and locking second left a hole: a row that appeared between an outside read
 * and the write would be counted as absent and deleted without ever being
 * seen. The RESTRICT foreign key is the backstop for anything that still slips
 * through the count-to-delete gap inside this same transaction.
 */

import { acquirePayrollWriteLock, type PayrollTxClient } from "@/lib/payroll-period";
import { prisma } from "@/lib/prisma";

export type TimeEntryParent = { userId: string } | { projectId: string };

function scopeOf(parent: TimeEntryParent) {
    return "userId" in parent ? { userId: parent.userId } : { projectId: parent.projectId };
}

/**
 * Raised when a parent (a user or a project) has one or more time entries,
 * whatever their lock status. There is no partial-delete path past this and no
 * "unlocked, so it's fine" branch — payroll history is never destroyed by
 * deleting the record it hangs off of.
 */
export class TimeEntriesExistError extends Error {
    readonly count: number;
    constructor(count: number) {
        super(
            `Cannot delete: ${count} time ${count === 1 ? "entry" : "entries"} ${count === 1 ? "exists" : "exist"} for this record. Payroll history is never deleted this way.`
        );
        this.name = "TimeEntriesExistError";
        this.count = count;
    }
}

export function isTimeEntriesExistError(error: unknown): error is TimeEntriesExistError {
    return error instanceof Error && error.name === "TimeEntriesExistError";
}

export type ParentDeleteDeps = {
    /** Injected in tests so the guard can be driven directly. */
    runTransaction?: <T>(fn: (tx: PayrollTxClient) => Promise<T>) => Promise<T>;
};

/**
 * Delete several parents, but ONLY if none of them owns a single time entry.
 *
 * ONE transaction for the whole set: every parent is checked before any parent
 * is deleted, so one parent with history refuses the entire batch rather than
 * leaving half of it gone with nothing to undo it with.
 *
 * Throws TimeEntriesExistError if any parent in the set has time entries at
 * all — locked or unlocked. "Unlocked" is not "unpaid" or "disposable": see
 * the header for why a lock-status check alone is unsafe here.
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

        // 1. The shared payroll lock, ALWAYS and FIRST — before anything is
        //    even read, matching the lock order every other hours writer uses.
        await acquirePayrollWriteLock(tx);

        // 2. Count, inside the transaction, immediately before the parent
        //    delete. ANY match refuses the whole batch — there is no "delete
        //    the unlocked ones" branch left. A row created in the gap between
        //    this count and the delete statement below still cannot get
        //    through: the FK is RESTRICT, so the delete itself would fail
        //    rather than silently succeed.
        const existing = scopes.length
            ? await client.timeEntry.count({ where: { OR: scopes as never } })
            : 0;
        if (existing > 0) throw new TimeEntriesExistError(existing);

        await deleteParentRows(tx);
        return { deletedEntries: 0 };
    });
}

/** One parent. Same guarantee — this is the shape the users route needs. */
export async function deleteParentWithTimeEntries(
    parent: TimeEntryParent,
    deleteParentRow: (tx: PayrollTxClient) => Promise<void>,
    deps: ParentDeleteDeps = {}
): Promise<{ deletedEntries: number }> {
    return deleteParentsWithTimeEntries([parent], deleteParentRow, deps);
}
