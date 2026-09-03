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
import type { Prisma } from "@prisma/client";
import { logAutomationEvent } from "@/lib/automation-events";
import { prisma } from "@/lib/prisma";
import { removeReceiptObject, uploadReceiptObject } from "./bucket";

export const STORAGE_CLEANUP_KIND = "storage-cleanup-pending";

/**
 * THE SCHEDULE ON A QUEUED CLEANUP, and why one is needed at all.
 *
 * Deleting an object is not the same as making it undeletable-again. While a
 * signed upload URL for the path is still valid, its holder's delayed PUT
 * recreates the object AFTER we removed it — and by then the row that named
 * the path is gone, so nothing references those bytes, nothing remembers them,
 * and no sweep is looking for them. That is an unreferenced object in a
 * private bucket, forever, created by our own cleanup.
 *
 * So a cleanup carries the instant it becomes safe (`cleanupNotBefore()`:
 * the upload lease's own deadline plus a grace), and nothing acts on it before
 * then. The event IS the tombstone — it outlives the row and holds the path
 * and the expiry — which is what lets the row be deleted immediately while the
 * OBJECT waits for the capability to die.
 *
 * Stored in `detail` rather than a column: AutomationEvent has no schedule
 * field, this queue is normally empty, and adding one would be a production
 * migration for a five-minute delay.
 */
export function cleanupDueAt(detail: string | null | undefined): Date | null {
    if (!detail) return null;
    let parsed: { notBefore?: unknown };
    try {
        parsed = JSON.parse(detail) as { notBefore?: unknown };
    } catch {
        return null;
    }
    if (typeof parsed.notBefore !== "string") return null;
    const at = new Date(parsed.notBefore);
    // An unparseable schedule is NOT permission to wait forever — it would
    // wedge the event in the queue every pass with nothing able to clear it.
    return Number.isNaN(at.getTime()) ? null : at;
}

/** Is a queued cleanup allowed to run yet? No schedule means "now". */
export function cleanupDue(detail: string | null | undefined, now: Date = new Date()): boolean {
    const due = cleanupDueAt(detail);
    return !due || due.getTime() <= now.getTime();
}

/**
 * The storage and queue writes the two request-path cleanups make. Injected
 * for the same reason the sweep's are: "nothing was deleted" is only a real
 * assertion if a test can see the delete not happening.
 */
export interface CleanupIo {
    remove: (storagePath: string) => Promise<void>;
    record: (storagePath: string, reason: string, notBefore: Date | null) => Promise<void>;
    resolve: (eventId: string) => Promise<void>;
    now: () => Date;
}

const liveIo: CleanupIo = {
    remove: removeReceiptObject,
    record: recordPendingCleanup,
    resolve: async eventId => {
        await prisma.automationEvent
            .update({ where: { id: eventId }, data: { status: "resolved" } })
            .catch(() => { /* the sweep will find it still pending and re-check */ });
    },
    now: () => new Date(),
};

/** A schedule that has not arrived yet, or null when the delete may run now. */
function pending(notBefore: Date | null | undefined, now: Date): Date | null {
    return notBefore && notBefore.getTime() > now.getTime() ? notBefore : null;
}

/**
 * ONE OBJECT PATH, ONE WRITER — publication or cleanup, never both at once.
 *
 * The two used to be free-running, and each was individually careful in a way
 * that only worked if the other was not there:
 *
 *   - the sweep checks "does a live row point at this path" and then deletes
 *     the object, in two separate operations;
 *   - a publish seals the bytes at the canonical path and only THEN commits the
 *     row pointer at it, in two separate operations — deliberately, because
 *     committing a pointer to bytes that were never written is unrecoverable.
 *
 * Interleave them and the guards cancel out. The sweep looks while the row
 * still points at the UPLOAD path, sees nothing referencing the canonical one,
 * and deletes the object the publish just sealed; the publish then commits, and
 * deletes the upload copy because the pointer moved. The row is RECEIVED, its
 * sha is recorded, every later reader verifies against it — and the bytes are
 * gone. A successful intake, pointing at nothing.
 *
 * A transaction-scoped advisory lock on the path is what makes the pairs
 * atomic with respect to each other. Transaction scoped, not session scoped,
 * because the app talks to Postgres through pgbouncer in transaction pooling
 * mode: a session lock would be taken on a connection that is handed to
 * somebody else the moment the statement ends, and released never.
 *
 * `hashtext` collisions are harmless here — two unrelated paths sharing a hash
 * serialize against each other for a few milliseconds and nothing more.
 */
export async function withReceiptObjectLock<T>(
    storagePath: string,
    body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    return prisma.$transaction(
        async tx => {
            // $executeRaw, NOT $queryRaw: pg_advisory_xact_lock returns void.
            // The blocking form, not `try_`: the critical sections here are a
            // storage round trip long, and a publish that gave up because a
            // sweep held the lock would be a spurious 503.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('receipt-object:' || ${storagePath}))`;
            return body(tx);
        },
        // Generous: the section holds one Supabase round trip on an object
        // capped at MAX_STORED_BYTES (8 MB), and the default 5s interactive
        // timeout would abort a slow-but-healthy seal.
        { maxWait: 10_000, timeout: 30_000 },
    );
}

/**
 * A queued deletion for a path a publish is, right now, putting bytes at.
 *
 * Resolved rather than left pending: the event says "nothing references these
 * bytes, remove them", and the publish holding this lock is in the middle of
 * making that false. Leaving it pending would let the next sweep delete the
 * object the moment this lock is released — the sweep's own reference check
 * cannot save it, because a publish that has sealed but not yet committed is
 * exactly the window in which no row references the path.
 *
 * Run BEFORE the seal, not after it. The canonical path is a deterministic
 * function of the row, its upload lease and the bytes' own hash, so a publish
 * that fails and is retried targets the SAME path again — the queued deletion
 * is wrong about that object whether or not this particular attempt gets there.
 *
 * Matched on the JSON-quoted path so a prefix cannot widen it: the detail is
 * `{"storagePath":"<path>",...}`, and the quotes bound both ends.
 */
async function reclaimQueuedCleanups(tx: Prisma.TransactionClient, storagePath: string): Promise<void> {
    await tx.automationEvent.updateMany({
        where: {
            kind: STORAGE_CLEANUP_KIND,
            status: "pending",
            detail: { contains: JSON.stringify(storagePath) },
        },
        data: { status: "resolved", reason: `reclaimed by the publish of ${storagePath}`.slice(0, 500) },
    });
}

/**
 * The publish half of the mutual exclusion: hold the path's lock, cancel any
 * queued deletion of it, and run the seal-and-commit inside.
 *
 * Only the seal and the row pointer belong in here. No Gemini read, no QBO
 * round trip, nothing that can take seconds — this transaction blocks every
 * other writer of the same path for as long as it is open.
 */
export async function withReceiptPublishLock<T>(
    canonicalPath: string,
    body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    return withReceiptObjectLock(canonicalPath, async tx => {
        await reclaimQueuedCleanups(tx, canonicalPath);
        return body(tx);
    });
}

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
export async function recordPendingCleanup(
    storagePath: string,
    reason: string,
    /** When the object may be deleted — see cleanupDueAt. Null means now. */
    notBefore: Date | null = null,
): Promise<void> {
    // THROWS on failure, unlike an audit write. This record is not an audit
    // trail — it is the ONLY thing that will remember the object once the row
    // pointing at it is gone. Swallowing the failure loses the orphan silently
    // and forever, so the caller must know and keep the row instead.
    await logAutomationEvent({
        kind: STORAGE_CLEANUP_KIND,
        status: "pending",
        reason,
        source: "receipt-intake",
        detail: notBefore ? { storagePath, notBefore: notBefore.toISOString() } : { storagePath },
    });
    const recorded = await prisma.automationEvent.findFirst({
        where: { kind: STORAGE_CLEANUP_KIND, status: "pending", detail: { contains: storagePath } },
        select: { id: true },
    });
    // logAutomationEvent is fire-and-forget by contract, so "it did not throw"
    // is not proof it wrote. Read it back.
    if (!recorded) throw new Error(`could not record a cleanup for ${storagePath}`);
}

/** The one write `queueObjectCleanup` needs — injectable, so it is testable. */
export interface CleanupQueueTx {
    automationEvent: {
        create(args: {
            // The CONCRETE shape, not Record<string, unknown>: a real
            // Prisma.TransactionClient is passed here (unlike RejectTxClient,
            // which is reached through a cast), and Prisma's own create only
            // accepts an argument type that names its required columns.
            data: { kind: string; status: string; reason: string; source: string; detail: string };
            select: { id: true };
        }): Promise<{ id: string }>;
    };
}

/**
 * ENQUEUE A CLEANUP INSIDE SOMEBODY ELSE'S TRANSACTION.
 *
 * The counterpart to `recordPendingCleanup`'s durability rule, for the callers
 * that have a transaction: the event is written with the caller's `tx`, so it
 * commits with the pointer transition that orphaned the object or not at all.
 * A failure here throws and takes that transition down with it, which is the
 * correct outcome — a pointer that moved without its cleanup recorded is bytes
 * nothing will ever find.
 *
 * No read-back, unlike recordPendingCleanup: this write is a plain `create`
 * inside a transaction the caller commits, so it either raises or is part of
 * that commit. (recordPendingCleanup goes through logAutomationEvent, which is
 * fire-and-forget by contract, and that is what the read-back is there for.)
 */
export async function queueObjectCleanup(
    tx: CleanupQueueTx,
    storagePath: string,
    reason: string,
    notBefore: Date | null = null,
): Promise<string> {
    const event = await tx.automationEvent.create({
        data: {
            kind: STORAGE_CLEANUP_KIND,
            status: "pending",
            reason: reason.slice(0, 500),
            source: "receipt-intake",
            detail: JSON.stringify(
                notBefore ? { storagePath, notBefore: notBefore.toISOString() } : { storagePath },
            ),
        },
        select: { id: true },
    });
    return event.id;
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
        findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null>;
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
    /** The upload lease the caller inspected. A newer one means a newer file. */
    uploadLeaseVersion: number;
    /**
     * The lease GENERATION the caller inspected, and its expiry.
     *
     * The version cannot see a REFRESH: `reuseLiveLease` reissues a working
     * signed URL over the same path at the same version, so a reject decided
     * before that refresh still matched the row and deleted it out from under
     * a client whose URL had just been renewed — and queued the path for
     * deletion on the stale expiry, which the renewed URL then outlives. See
     * leaseFence; this is the same pin, on the delete instead of the publish.
     */
    uploadLeaseNonce: string | null;
    uploadUrlExpiresAt: Date | null;
    /**
     * When the OBJECT may be deleted (`cleanupNotBefore()` of the same row).
     * Deliberately NOT part of the delete's where clause — the fence is about
     * which row we are entitled to remove, this is about when its bytes stop
     * being writable by a URL somebody still holds. Null (the default) deletes
     * as soon as the caller settles the queued cleanup.
     */
    cleanupNotBefore?: Date | null;
}
export interface RejectClient {
    $transaction<T>(fn: (tx: RejectTxClient) => Promise<T>): Promise<T>;
}

export async function rejectRowAndQueueCleanup(
    row: RejectFence,
    reason: string,
    db: RejectClient = prisma as unknown as RejectClient,
    /**
     * Re-checked against a FRESH read inside the transaction. The caller spent
     * a storage round trip deciding this row was unacceptable; anything that
     * changed in the meantime (a resumed upload lease, a re-park) has to be
     * judged on the row as it is NOW, not as it was when the decision started.
     * Return a reason to abort, or null to proceed.
     */
    verify: (fresh: Record<string, unknown>) => string | null = () => null,
): Promise<{ ok: true; eventId: string } | { ok: false }> {
    try {
        const eventId = await db.$transaction(async tx => {
            const event = await tx.automationEvent.create({
                data: {
                    kind: STORAGE_CLEANUP_KIND,
                    status: "pending",
                    reason: reason.slice(0, 500),
                    source: "receipt-intake",
                    detail: JSON.stringify({
                        storagePath: row.storagePath,
                        rowId: row.id,
                        // The tombstone's whole point: the row is about to be
                        // gone, so this event is the only thing that will
                        // still know both the path AND when its signed upload
                        // URL stops being able to recreate it.
                        ...(row.cleanupNotBefore
                            ? { notBefore: row.cleanupNotBefore.toISOString() }
                            : {}),
                    }),
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
            // RE-READ INSIDE THE TRANSACTION, and let the caller judge it.
            const fresh = await tx.receiptIntake.findUnique({ where: { id: row.id } });
            if (!fresh) throw new RejectFenceLost(row.id);
            const objection = verify(fresh);
            if (objection) throw new RejectFenceLost(`${row.id}: ${objection}`);

            const { count } = await tx.receiptIntake.deleteMany({
                where: {
                    id: row.id,
                    state: row.state,
                    stateReason: row.stateReason,
                    claimToken: null,
                    storagePath: row.storagePath,
                    // The lease the caller INSPECTED. A resumed /start bumps
                    // this and re-points the row at a new path, so a sweep
                    // that decided on the old upload deletes nothing.
                    uploadLeaseVersion: row.uploadLeaseVersion,
                    // ...and the GENERATION, which is the only column a
                    // same-path, same-version REFRESH moves. Without it a
                    // /start that handed the client a fresh URL a millisecond
                    // ago does not stop this delete.
                    uploadLeaseNonce: row.uploadLeaseNonce,
                    uploadUrlExpiresAt: row.uploadUrlExpiresAt,
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
 *
 * `notBefore` is the same schedule the event carries. Passing it here is not
 * belt-and-braces: this is the OPPORTUNISTIC delete a rejecting request makes
 * on its way out, and it runs while the client's signed upload URL is at its
 * most likely to still be live. Deleting now would leave the row deleted, the
 * object gone, and the URL able to put it straight back with nothing left
 * referencing it. Not deleting simply leaves the event pending, which is
 * exactly what the sweep is for.
 */
export async function settleQueuedCleanup(
    eventId: string,
    storagePath: string,
    notBefore: Date | null = null,
    io: CleanupIo = liveIo,
): Promise<boolean> {
    if (pending(notBefore, io.now())) return false;
    try {
        await io.remove(storagePath);
    } catch (error) {
        console.error(
            "[receipts/intake] queued delete failed, left pending",
            storagePath,
            error instanceof Error ? error.name : "error",
        );
        return false;
    }
    // Resolve only AFTER a delete that did not throw, same rule as the sweep.
    await io.resolve(eventId);
    return true;
}

/**
 * Delete the object. If that fails, record the path so the sweep can retry.
 *
 * `notBefore` DEFERS the delete entirely rather than attempting it: a live
 * signed upload URL for this path can recreate the object after we remove it,
 * so the only delete that actually removes the bytes is one taken after the
 * URL dies. The queue entry is written immediately either way — the path is
 * never left unremembered.
 *
 * THROWS when the queue entry cannot be written, and that is the whole point.
 *
 * This used to swallow it and return false, and every caller discarded the
 * false AFTER moving the row's pointer — so one transient database failure
 * left bytes in a private bucket that no row referenced, no event remembered
 * and no sweep would ever look at. Silent and permanent.
 *
 * Callers that move a pointer must therefore enqueue INSIDE that pointer's
 * transaction (`queueObjectCleanup`), so the two commit together or neither
 * does. Callers with no transaction to pair with must let the throw reach
 * their response, so the client retries instead of being told it worked.
 */
export async function deleteObjectOrRecord(
    storagePath: string,
    reason: string,
    notBefore: Date | null = null,
    io: CleanupIo = liveIo,
): Promise<boolean> {
    const scheduled = pending(notBefore, io.now());
    if (scheduled) {
        // No catch. See THROWS, above.
        await io.record(storagePath, reason, scheduled);
        return false;
    }
    try {
        await io.remove(storagePath);
        return true;
    } catch (error) {
        console.error("[receipts/intake] object delete failed", storagePath, error instanceof Error ? error.name : "error");
        // No catch here either — a delete that failed AND a record that failed
        // is the one combination that loses an object with nothing left to find
        // it, and swallowing it turned that into a silent, permanent leak. The
        // caller has to decide, and every caller that moved a pointer has a
        // transaction to roll back.
        await io.record(storagePath, reason, null);
        return false;
    }
}

/**
 * Everything the sweep touches, injected so the schedule is a unit test rather
 * than a property only a two-hour production wait could demonstrate. The
 * default wiring below is the live one.
 */
/** How many queue entries are LOOKED at per delete slot. See retryPendingCleanups. */
export const CLEANUP_SCAN_FACTOR = 5;

export interface CleanupSweepDeps {
    findPending: (take: number) => Promise<{ id: string; detail: string | null }[]>;
    abandon: (eventId: string) => Promise<void>;
    withObjectLock: <T>(storagePath: string, body: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    remove: (storagePath: string) => Promise<void>;
    now: () => Date;
}

const liveSweepDeps: CleanupSweepDeps = {
    findPending: take => prisma.automationEvent.findMany({
        where: { kind: STORAGE_CLEANUP_KIND, status: "pending" },
        orderBy: { createdAt: "asc" },
        take,
        select: { id: true, detail: true },
    }),
    abandon: async eventId => {
        await prisma.automationEvent.update({ where: { id: eventId }, data: { status: "abandoned" } });
    },
    withObjectLock: withReceiptObjectLock,
    remove: removeReceiptObject,
    now: () => new Date(),
};

/**
 * Retry the deletions that failed earlier — and run the ones that were never
 * attempted because their object was still writable by a live signed URL.
 * Bounded per pass, like every other housekeeping step in the worker, and it
 * resolves each event it clears so the queue drains instead of growing.
 */
export async function retryPendingCleanups(
    limit: number,
    shouldStop: () => boolean,
    deps: CleanupSweepDeps = liveSweepDeps,
): Promise<number> {
    // THE SCAN IS WIDER THAN THE DELETE BUDGET, on purpose.
    //
    // `limit` bounds STORAGE ROUND TRIPS, which is the expensive part and the
    // reason this step is bounded at all. It must not also bound the SELECT:
    // the queue now holds entries that are not due yet, and fetching exactly
    // `limit` oldest-first would let a burst of scheduled ones occupy every
    // slot and starve the genuinely-due entries behind them — the same
    // batch-starvation shape the STAGING sweep's own query was fixed for. A
    // wider scan is a bigger `take` on one indexed query and nothing else.
    //
    // It is a widening, not a proof: a due entry sitting behind more than
    // CLEANUP_SCAN_FACTOR x limit scheduled ones still waits. That wait is
    // bounded rather than indefinite, and by construction — every scheduled
    // entry becomes due within the upload lease's own TTL plus the grace, and
    // they mature in the order they were created, which is the order this
    // query returns them in.
    const now = deps.now();
    const queued = await deps.findPending(limit * CLEANUP_SCAN_FACTOR);

    let cleared = 0;
    let attempted = 0;
    for (const event of queued) {
        if (shouldStop() || attempted >= limit) break;
        let storagePath: string | null = null;
        try {
            storagePath = (JSON.parse(event.detail ?? "{}") as { storagePath?: string }).storagePath ?? null;
        } catch {
            storagePath = null;
        }
        if (!storagePath) {
            // Unparseable detail can never be acted on; close it rather than
            // retrying it every five minutes forever.
            await deps.abandon(event.id);
            continue;
        }
        // NOT YET. The object's signed upload URL is still live, so deleting it
        // now would only open a window for a delayed PUT to recreate it with
        // nothing left referencing or remembering the result. Left pending, not
        // resolved, and not counted against the batch's storage budget — the
        // next pass five minutes later looks again.
        if (!cleanupDue(event.detail, now)) continue;
        attempted++;

        // NEVER delete a path a LIVE row still points at — and never answer
        // that question while a publish is mid-flight at the same path.
        //
        // The recovery sequence makes the first reachable: an ambiguous upload
        // records a cleanup, the row is deleted, the caller retries, and the
        // retry's row can end up pointing at the same path — or a seal can
        // publish a canonical path that an older pending event names. Deleting
        // then destroys a receipt that is in active use. The event is resolved
        // rather than retried forever: the object is accounted for, just not by
        // us.
        //
        // The LOCK is what makes the check mean anything. Looking and then
        // deleting, as two free-running operations, answers "was it referenced
        // a moment ago" — and a publish that has sealed its bytes but not yet
        // committed its row pointer is precisely the state that answers "no"
        // while being seconds away from answering "yes". See
        // withReceiptObjectLock. The whole check-and-delete now runs inside one
        // transaction holding the path's lock, so a publish either finished
        // before it (the row is visible, and this skips) or starts after it
        // (the object is already gone, and the seal simply writes it again).
        const verdict = await deps.withObjectLock(storagePath, async tx => {
            const referenced = await tx.receiptIntake.findFirst({
                where: { storagePath },
                select: { id: true },
            });
            if (referenced) {
                await tx.automationEvent.update({
                    where: { id: event.id },
                    data: { status: "resolved", reason: `still referenced by ${referenced.id}` },
                });
                return "referenced" as const;
            }
            // THE NEWEST SCHEDULE FOR THIS PATH WINS, never the one this
            // particular event happens to carry.
            //
            // An event records the expiry its author OBSERVED, and that author
            // can have been overtaken: a /start refresh extends the lease, and
            // a second cleanup for the same path is then queued with a LATER
            // deadline. Acting on the older event would delete the object
            // while the refreshed URL still works — precisely the orphan the
            // schedule exists to prevent, arriving through the queue instead
            // of through the fence. Taken inside the lock, with the row's own
            // current expiry folded in, so "newest" is answered against the
            // same snapshot the delete acts on.
            const siblings = await tx.automationEvent.findMany({
                where: {
                    kind: STORAGE_CLEANUP_KIND,
                    status: "pending",
                    detail: { contains: JSON.stringify(storagePath) },
                },
                select: { id: true, detail: true },
            });
            const newest = siblings
                .map(s => cleanupDueAt(s.detail))
                .reduce<Date | null>(
                    (latest, at) => (at && (!latest || at > latest) ? at : latest),
                    null,
                );
            if (pending(newest, now)) return "not-due" as const;
            // A throw here rolls the whole transaction back, so the event stays
            // pending for the next pass — the same outcome the old separate
            // delete had, without the resolve ever landing on its own.
            await deps.remove(storagePath);
            // Resolved ONLY after a delete that did not throw —
            // removeReceiptObject surfaces a missing storage client as an error
            // rather than a success, so a misconfigured deployment cannot
            // quietly mark the queue clean.
            // EVERY pending event naming this path, not just the one we came
            // in on. They all describe the same object and it is now gone; a
            // sibling left pending would be retried every pass forever, its
            // remove() throwing "not found" each time, because nothing else
            // will ever resolve it. Two events for one path is the normal
            // shape once a lease can be refreshed mid-flight.
            for (const sibling of siblings.length ? siblings : [{ id: event.id }]) {
                await tx.automationEvent.update({
                    where: { id: sibling.id },
                    data: { status: "resolved" },
                });
            }
            return "deleted" as const;
        }).catch(error => {
            console.error(
                "[receipts/intake] queued cleanup left pending",
                storagePath,
                error instanceof Error ? error.name : "error",
            );
            return "failed" as const;
        });
        if (verdict === "deleted") cleared++;
    }
    return cleared;
}
