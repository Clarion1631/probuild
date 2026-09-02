/**
 * Orphaned-object bookkeeping.
 *
 * When an intake row is rejected (oversize, wrong format, empty) the object it
 * pointed at has to go too — the row is deleted, so after that NOTHING in the
 * database references those bytes and they would sit in a private bucket
 * forever. Storage deletes fail for the same boring reasons every other call
 * does, so "best effort, shrug" is not good enough on a path we take
 * deliberately.
 *
 * An AutomationEvent is used rather than a new table: this is rare, it is
 * already the audit surface the Command Center reads, and a table for it would
 * be schema churn for a queue that should normally be empty.
 */
import { logAutomationEvent } from "@/lib/automation-events";
import { prisma } from "@/lib/prisma";
import { removeReceiptObject, uploadReceiptObject } from "./bucket";

export const STORAGE_CLEANUP_KIND = "storage-cleanup-pending";

/**
 * Copy verified bytes to their canonical path and drop the upload path.
 *
 * The upload path stays writable by whoever holds the signed URL (which is
 * `upsert: true`, deliberately, so a resumed /start can replace its own partial
 * upload). Leaving the row pointed at it means the bytes we verified can be
 * replaced afterwards by anyone who kept the URL — the row would still claim
 * the old sha while storage held something else.
 *
 * Returns null when the copy fails, so the caller can refuse rather than
 * publish a row pointing at a path that may not exist.
 */
export async function sealObject(
    uploadPath: string,
    canonicalPath: string,
    bytes: Buffer,
    contentType: string,
): Promise<string | null> {
    // upsert: the canonical path is content-addressed, so a re-seal of the
    // SAME bytes is a no-op by construction and must not fail.
    const copied = await uploadReceiptObject(canonicalPath, bytes, contentType, { upsert: true });
    if (!copied) return null;

    // NOTE: the upload object is deliberately NOT deleted here.
    //
    // Deleting before the row is committed is unrecoverable: if the UPDATE then
    // fails, the row still points at a path whose object we just removed, and
    // the receipt is gone with nothing left to retry from. The caller deletes
    // only after the pointer is committed — see finalizeAndPublish.
    return canonicalPath;
}

/**
 * Queue an object for deletion WITHOUT attempting one first.
 *
 * For the ambiguous case: an upload that errored may still have written bytes,
 * and the row that points at them is about to be deleted. Recording the path
 * before that happens is the only way the orphan stays findable.
 */
export async function recordPendingCleanup(storagePath: string, reason: string): Promise<void> {
    // THROWS on failure, unlike an audit write. This record is not an audit
    // trail — it is the ONLY thing that will remember the object once the row
    // pointing at it is gone. Swallowing the failure loses the orphan silently
    // and forever, so the caller must know and keep the row instead.
    await logAutomationEvent({
        kind: STORAGE_CLEANUP_KIND,
        status: "pending",
        reason,
        source: "receipt-intake",
        detail: { storagePath },
    });
    const recorded = await prisma.automationEvent.findFirst({
        where: { kind: STORAGE_CLEANUP_KIND, status: "pending", detail: { contains: storagePath } },
        select: { id: true },
    });
    // logAutomationEvent is fire-and-forget by contract, so "it did not throw"
    // is not proof it wrote. Read it back.
    if (!recorded) throw new Error(`could not record a cleanup for ${storagePath}`);
}

/**
 * Reject a row and queue its object for deletion IN ONE TRANSACTION.
 *
 * The two writes cannot be separate. Delete-then-record loses the object
 * whenever the record fails (nothing references the bytes any more, and nothing
 * remembers them). Record-then-delete leaves a cleanup event naming a path a
 * live row still points at, and the sweep would delete a receipt in use — the
 * sweep's own "still referenced" guard papers over that, but only until the row
 * is re-pointed. Both in one transaction means the queue entry exists if and
 * only if the row is gone.
 *
 * Returns false when the row's deletion is NOT confirmed. The caller must then
 * keep the object and fail retryably: an object with no queue entry and a row
 * that still exists is a state we can resume from; the reverse is not.
 */
/** The two writes the reject transaction needs — injectable so it is testable. */
export interface RejectTxClient {
    automationEvent: { create(args: { data: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }> };
    receiptIntake: {
        deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    };
}

/**
 * The row as it was OBSERVED, which is what the delete is fenced on.
 *
 * Same shape and same reason as publishFence: a reject and a publish race for
 * the same row, and each must lose cleanly rather than act on a row the other
 * has already moved.
 */
export interface RejectFence {
    id: string;
    state: string;
    stateReason: string | null;
    storagePath: string;
}
export interface RejectClient {
    $transaction<T>(fn: (tx: RejectTxClient) => Promise<T>): Promise<T>;
}

export async function rejectRowAndQueueCleanup(
    row: RejectFence,
    reason: string,
    db: RejectClient = prisma as unknown as RejectClient,
): Promise<{ ok: true; eventId: string } | { ok: false }> {
    try {
        const eventId = await db.$transaction(async tx => {
            const event = await tx.automationEvent.create({
                data: {
                    kind: STORAGE_CLEANUP_KIND,
                    status: "pending",
                    reason: reason.slice(0, 500),
                    source: "receipt-intake",
                    detail: JSON.stringify({ storagePath: row.storagePath, rowId: row.id }),
                },
                select: { id: true },
            });
            // THE FULL FENCE, and EXACTLY ONE ROW.
            //
            // A reject races a publish for the same row: a concurrent /finalize
            // (or the sweeper) can move it to RECEIVED, re-park it under a
            // different reason, or seal its object to a new path in the time
            // this call spent inspecting the bytes. Deleting by id alone
            // destroys that row and, worse, queues ITS object for deletion —
            // the published receipt's own bytes. Pinning the observed state,
            // reason and storagePath means the loser deletes nothing.
            //
            // "Already gone" is deliberately NOT treated as success: an absent
            // row is a row somebody else accounted for, and queueing its path
            // for deletion here is how a live object gets swept.
            const { count } = await tx.receiptIntake.deleteMany({
                where: {
                    id: row.id,
                    state: row.state,
                    stateReason: row.stateReason,
                    claimToken: null,
                    storagePath: row.storagePath,
                },
            });
            if (count !== 1) throw new RejectFenceLost(row.id);
            return event.id;
        });
        return { ok: true, eventId };
    } catch (error) {
        // Either way NOTHING is committed: the queue entry rolls back with the
        // delete, so there is no cleanup record naming a path a live row still
        // points at.
        console.error(
            "[receipts/intake] reject transaction failed",
            row.id,
            error instanceof Error ? error.name : "error",
        );
        return { ok: false };
    }
}

/** The delete matched no row: somebody else moved it. Never a partial commit. */
class RejectFenceLost extends Error {
    constructor(rowId: string) {
        super(`reject fence lost for ${rowId}`);
        this.name = "RejectFenceLost";
    }
}

/**
 * Try the queued deletion now. A failure is not an error for the caller — the
 * event stays pending and the worker's sweep retries it.
 */
export async function settleQueuedCleanup(eventId: string, storagePath: string): Promise<boolean> {
    try {
        await removeReceiptObject(storagePath);
    } catch (error) {
        console.error(
            "[receipts/intake] queued delete failed, left pending",
            storagePath,
            error instanceof Error ? error.name : "error",
        );
        return false;
    }
    // Resolve only AFTER a delete that did not throw, same rule as the sweep.
    await prisma.automationEvent
        .update({ where: { id: eventId }, data: { status: "resolved" } })
        .catch(() => { /* the sweep will find it still pending and re-check */ });
    return true;
}

/**
 * Delete the object. If that fails, record the path so the sweep can retry.
 * Never throws: the caller is already rejecting a row and must not be derailed
 * by the cleanup of it.
 */
export async function deleteObjectOrRecord(storagePath: string, reason: string): Promise<boolean> {
    try {
        await removeReceiptObject(storagePath);
        return true;
    } catch (error) {
        console.error("[receipts/intake] object delete failed", storagePath, error instanceof Error ? error.name : "error");
        await recordPendingCleanup(storagePath, reason).catch(recordError => {
            // Both the delete AND the record failed. Say so loudly: this is the
            // one combination that loses an object with nothing left to find it.
            console.error("[receipts/intake] ORPHANED OBJECT, no cleanup recorded", storagePath, recordError);
        });
        return false;
    }
}

/**
 * Retry the deletions that failed earlier. Bounded per pass, like every other
 * housekeeping step in the worker, and it resolves each event it clears so the
 * queue drains instead of growing.
 */
export async function retryPendingCleanups(limit: number, shouldStop: () => boolean): Promise<number> {
    const pending = await prisma.automationEvent.findMany({
        where: { kind: STORAGE_CLEANUP_KIND, status: "pending" },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, detail: true },
    });

    let cleared = 0;
    for (const event of pending) {
        if (shouldStop()) break;
        let storagePath: string | null = null;
        try {
            storagePath = (JSON.parse(event.detail ?? "{}") as { storagePath?: string }).storagePath ?? null;
        } catch {
            storagePath = null;
        }
        if (!storagePath) {
            // Unparseable detail can never be acted on; close it rather than
            // retrying it every five minutes forever.
            await prisma.automationEvent.update({ where: { id: event.id }, data: { status: "abandoned" } });
            continue;
        }

        // NEVER delete a path a LIVE row still points at.
        //
        // The recovery sequence makes this reachable: an ambiguous upload
        // records a cleanup, the row is deleted, the caller retries, and the
        // retry's row can end up pointing at the same path — or a seal can
        // publish a canonical path that an older pending event names. Deleting
        // then destroys a receipt that is in active use. The event is resolved
        // rather than retried forever: the object is accounted for, just not by
        // us.
        const referenced = await prisma.receiptIntake.findFirst({
            where: { storagePath },
            select: { id: true },
        });
        if (referenced) {
            await prisma.automationEvent.update({
                where: { id: event.id },
                data: { status: "resolved", reason: `still referenced by ${referenced.id}` },
            });
            continue;
        }

        try {
            await removeReceiptObject(storagePath);
        } catch {
            // Still failing. Leave it pending for the next pass.
            continue;
        }
        // Resolved ONLY after a delete that did not throw — removeReceiptObject
        // surfaces a missing storage client as an error rather than a success,
        // so a misconfigured deployment cannot quietly mark the queue clean.
        await prisma.automationEvent.update({ where: { id: event.id }, data: { status: "resolved" } });
        cleared++;
    }
    return cleared;
}
