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
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { logAutomationEvent } from "@/lib/automation-events";
import { prisma } from "@/lib/prisma";
import { removeReceiptObject, STORAGE_CALL_MAX_MS, uploadReceiptObject } from "./bucket";
import { leaseFence } from "./stored-object";
import type { RouteDeadline } from "@/lib/quickbooks";

export const STORAGE_CLEANUP_KIND = "storage-cleanup-pending";

/**
 * `pending` — the object exists and is unreferenced; delete it when due.
 * `provisional` — an INTENT for an object a publish is about to write. Same
 * sweep, but invisible to `reclaimQueuedCleanups` so the publish that took it
 * out cannot cancel it by taking the very lock it needs. See queueCanonicalIntent.
 */
export type CleanupStatus = "pending" | "provisional";
export const CLEANUP_SWEEPABLE_STATUSES: CleanupStatus[] = ["pending", "provisional"];

/** The one write `resolveCanonicalIntent` needs — injectable for tests. */
export interface CleanupResolveTx {
    automationEvent: {
        update(args: {
            where: { id: string };
            data: { status: string; reason: string };
        }): Promise<unknown>;
    };
}

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
    record: (storagePath: string, reason: string, notBefore: Date | null) => Promise<unknown>;
    resolve: (eventId: string) => Promise<void>;
    now: () => Date;
}

const liveIo: CleanupIo = {
    // The sweep runs inside the worker's invocation; its own deadline is
    // threaded in by the caller through `retryPendingCleanups`.
    remove: (storagePath: string) => removeReceiptObject(storagePath, undefined),
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
/**
 * A SHORT transaction. No storage call may be awaited inside it.
 *
 * This replaces `withReceiptObjectLock`, which took a transaction-scoped
 * advisory lock on the path and then ran a Supabase round trip inside it. The
 * lock was correct about mutual exclusion and wrong about what it cost: a
 * pooled connection was held for the whole of an external call the round-16
 * deadline caps at fifteen seconds, so a handful of concurrent finalizations
 * exhausted the five-connection pool and later requests could not reach the
 * database at all — including to release what they had claimed.
 *
 * The exclusion it provided is now a LEASE recorded in the cleanup queue (see
 * claimObjectPath), which needs no open transaction to hold.
 *
 * The timeout is short on purpose: a body that cannot finish in five seconds
 * without external I/O is doing something this comment says it must not.
 */
export async function inShortTx<T>(body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(body, { maxWait: 5_000, timeout: 5_000 });
}

/**
 * How long a publish may hold a path before the sweeper presumes it dead.
 *
 * Comfortably longer than STORAGE_CALL_MAX_MS (15s), because the lease has to
 * cover the seal plus the settle transaction that follows it; short enough
 * that a killed invocation's paths are collectable within a couple of sweeps.
 */
export const OBJECT_CLAIM_LEASE_MS = 60_000;

/**
 * WHEN A CLAIMED PATH BECOMES COLLECTABLE — the lease, as a pure decision.
 *
 * The LATER of two deadlines, and both matter:
 *   - this publish's own lease, which is what stops the sweeper collecting the
 *     object between the seal and the pointer commit (the window the advisory
 *     lock used to hold open with a connection);
 *   - the caller's schedule, when a still-live signed upload URL protects the
 *     path for longer than the publish will take.
 *
 * Taking the caller's alone would leave the seal window unguarded whenever the
 * upload lease had already lapsed — which is the sweeper's own publish path,
 * every time.
 */
export function objectClaimDueAt(notBefore: Date | null, now: Date = new Date()): Date {
    const leaseUntil = new Date(now.getTime() + OBJECT_CLAIM_LEASE_MS);
    return notBefore && notBefore > leaseUntil ? notBefore : leaseUntil;
}

/**
 * PHASE A OF THE PUBLISH: claim a canonical path without holding a connection.
 *
 * One short transaction that does two things which must happen together:
 *   - cancels any PENDING deletion of this path. The queue may hold an entry
 *     from an earlier attempt, and it is wrong about the object this publish
 *     is about to write.
 *   - records a PROVISIONAL intent carrying a lease. While that lease is live
 *     the sweeper skips the path (its schedule is in the future), so the
 *     object cannot be collected between the seal and the pointer commit —
 *     the window the advisory lock used to hold open with a connection.
 *
 * Returns the intent id, which phase C resolves in the same transaction as
 * the pointer. An intent left behind by a publish that died simply lapses and
 * the sweeper reclaims it, re-checking live references before it deletes.
 */
export async function claimObjectPath(
    canonicalPath: string,
    /** When the object may be deleted once the lease lapses. */
    notBefore: Date | null = null,
    now: Date = new Date(),
    /**
     * The transaction runner. Injected ONLY by tests: what this function
     * writes is the whole subject, and a verdict that persists nothing is
     * exactly the bug this claim exists to close.
     */
    run: <T>(body: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> = inShortTx,
): Promise<string> {
    const until = objectClaimDueAt(notBefore, now);
    // ONE TRANSACTION: read what holds the path, cancel any stale queued
    // deletion of it, and write this publish's claim. Split across two, a
    // deleter could take the path between the read and the write — which is
    // the very interleaving this claim exists to stop.
    return run(async tx => {
        // THE LOCK FIRST, then the claim -- see acquireObjectClaim. Reading
        // 'is this path free' and writing 'it is mine' have to be one step
        // against every other claimant, and they were not: this insert and
        // the sweeper's update touched DIFFERENT rows, so both could read a
        // free path and both commit.
        const claim = await acquireObjectClaim(tx, canonicalPath, "publishing", until, now);
        if (!claim.ok) throw new ObjectPathBusyError(canonicalPath, claim.heldBy);
        await reclaimQueuedCleanups(tx, canonicalPath);
        // The CLEANUP INTENT, which is a different thing from the claim: it is
        // what the sweeper acts on if this publish dies. The claim above is
        // what stops anyone deleting the path while it is alive.
        return queueObjectCleanup(
            tx,
            canonicalPath,
            "canonical-seal-intent",
            until,
            "provisional",
            { token: claim.token, kind: "publishing", until },
        );
    });
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
    /**
     * REQUIRED. The seal is one of three storage calls a /finalize makes, and
     * with an optional deadline each took a fresh fifteen seconds — 45s inside
     * a handler the platform kills at 30.
     */
    deadline: RouteDeadline | undefined,
): Promise<string | null> {
    // upsert: the canonical path is content-addressed, so a re-seal of the
    // SAME bytes is a no-op by construction and must not fail.
    const copied = await uploadReceiptObject(canonicalPath, bytes, contentType, { upsert: true, deadline });
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
    /**
     * `provisional` records an INTENT taken out before an external write, for
     * an object that does not exist yet — see queueCanonicalIntent. It is
     * deliberately invisible to `reclaimQueuedCleanups`, which would otherwise
     * cancel the intent the moment the publish that took it out grabbed the
     * path's lock. The sweeper picks up both statuses.
     */
    status: CleanupStatus = "pending",
    /** The writer. Injected only by tests — see queueObjectCleanup. */
    client: CleanupQueueTx = prisma,
): Promise<string> {
    // A DIRECT, THROWING `create` — never logAutomationEvent + a search.
    //
    // logAutomationEvent is fire-and-forget by contract: it swallows its insert
    // failure. The read-back that compensated for that searched for ANY event
    // whose detail CONTAINED this path, newest first — so on a retry, where an
    // older provisional event for the same canonical path already exists, a
    // FAILED insert returned that old event's id and its stale deadline as if
    // the write had just succeeded. The publish then sealed its object under a
    // claim it did not hold, against a lease that might already have lapsed.
    //
    // `create` returns the id of the row it actually wrote, or throws. There is
    // nothing to search for and nothing to mistake it for.
    return queueObjectCleanup(client, storagePath, reason, notBefore, status);
}

/**
 * A CLEANUP INTENT FOR AN OBJECT THAT DOES NOT EXIST YET.
 *
 * `sealAndPublish` writes the canonical copy to Supabase BEFORE the database
 * CAS that points a row at it. Everything after that write can fail — the
 * commit, the winner lookup, the transaction itself — and the object is then
 * in the bucket with nothing referencing it, nothing remembering it, and no
 * sweep looking for it, because the stale-STAGING sweep reads ROWS. A re-arm
 * later moves the row somewhere else and the sealed copy is undiscoverable.
 *
 * So the intent is taken out FIRST, in its own committed transaction, and the
 * publish that succeeds cancels it in the SAME transaction as the pointer
 * commit. Anything left provisional is swept on schedule by
 * `retryPendingCleanups`, which rechecks live references inside the path lock
 * before it deletes — so an intent that outlived a publish which actually
 * worked resolves harmlessly instead of destroying a live receipt.
 */

/** Cancel an intent because the object it covers is now referenced by a row. */
export async function resolveCanonicalIntent(
    tx: CleanupResolveTx,
    eventId: string,
): Promise<void> {
    await tx.automationEvent.update({
        where: { id: eventId },
        data: { status: "resolved", reason: "published" },
    });
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
    status: CleanupStatus = "pending",
    /** The per-path claim this entry carries, when it IS one. See claimObjectPath. */
    claim: { token: string; kind: ObjectClaimKind; until: Date } | null = null,
): Promise<string> {
    const event = await tx.automationEvent.create({
        data: {
            kind: STORAGE_CLEANUP_KIND,
            status,
            reason: reason.slice(0, 500),
            source: "receipt-intake",
            detail: JSON.stringify({
                storagePath,
                ...(notBefore ? { notBefore: notBefore.toISOString() } : {}),
                ...(claim
                    ? { claimToken: claim.token, claimKind: claim.kind, claimUntil: claim.until.toISOString() }
                    : {}),
            }),
        },
        select: { id: true },
    });
    return event.id;
}

/**
 * THE PER-PATH MUTEX BOTH CLAIM TRANSACTIONS TAKE AS THEIR FIRST STATEMENT.
 *
 * Reading the claim state and writing a claim have to be one atomic step
 * against every OTHER claimant of the same path. They were not: a sweeper
 * converting an EXPIRED provisional intent into a deleting claim UPDATEs that
 * event row, while a publisher taking the path INSERTs a new one -- different
 * rows, so at READ COMMITTED neither transaction blocks the other, both read
 * 'the path is free', and both commit. The sweeper then deleted the object the
 * publisher had sealed but not yet pointed at, leaving a RECEIVED row with no
 * bytes behind it.
 *
 * Transaction-scoped, so it is released by COMMIT or ROLLBACK and a crashed
 * claimant cannot wedge a path. It is taken FIRST in both transactions, so the
 * two can only ever run one after the other, and the second sees what the
 * first wrote.
 *
 * This is a LOCK, not I/O: it reaches nothing outside Postgres, and the
 * transactions that hold it do no external work (see the tripwire in
 * tests/receipt-intake-lease-fence.test.ts).
 */
export const OBJECT_LOCK_PREFIX = "receipt-object:";

export async function lockObjectPath(tx: Prisma.TransactionClient, storagePath: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OBJECT_LOCK_PREFIX + storagePath}))`;
}

/** What a claim attempt found. */
export type ObjectClaimAttempt =
    | { ok: true; token: string }
    | { ok: false; heldBy: ObjectClaimKind };

/**
 * TAKE THE PATH, or find out who holds it -- under the lock, against a table
 * whose PRIMARY KEY is the path itself.
 *
 * One row per path IS the invariant: a second live claim is impossible even if
 * the lock above were somehow missed, because there is nowhere to put it. The
 * claim used to live in an AutomationEvent's JSON `detail`, where no
 * constraint could express that.
 *
 * The exclusion rule is unchanged: two PUBLISHERS may share a path (it is
 * content-addressed, so they are writing identical bytes and the seal is an
 * upsert -- only the pointer needs serializing, and the publish CAS does that),
 * two deleters may not, and the two kinds may never cross.
 */
export async function acquireObjectClaim(
    tx: Prisma.TransactionClient,
    storagePath: string,
    want: ObjectClaimKind,
    until: Date,
    now: Date,
): Promise<ObjectClaimAttempt> {
    await lockObjectPath(tx, storagePath);
    const held = await tx.receiptObjectClaim.findUnique({ where: { storagePath } });
    if (held && held.expiresAt.getTime() > now.getTime()) {
        const heldBy = held.kind as ObjectClaimKind;
        if (heldBy !== want || want === "deleting") return { ok: false, heldBy };
    }
    // A LAPSED claim is taken over rather than respected: a dead holder must
    // not block a path forever. The token changes with it, which is what makes
    // the holder's own pre-delete re-read able to tell that it lost the path.
    const token = randomUUID();
    await tx.receiptObjectClaim.upsert({
        where: { storagePath },
        create: { storagePath, token, kind: want, expiresAt: until },
        update: { token, kind: want, expiresAt: until },
    });
    return { ok: true, token };
}

/**
 * HOW LONG A CLAIM TAKEN IMMEDIATELY BEFORE A REMOTE DELETE MUST LIVE.
 *
 * Strictly longer than the delete it covers. `removeReceiptObject` is bounded
 * by STORAGE_CALL_MAX_MS, so a claim of that plus a margin cannot expire
 * while its own delete is still in flight -- which is the failure this
 * exists for: the sweep derived every expiry from a `now` captured at the
 * top of the pass, so a late item could spend ten seconds in its two short
 * transactions and then start a fifteen-second delete under a claim with
 * seconds left. Once it lapsed a publisher took the path, sealed the
 * canonical object, and the delete still in flight removed the bytes it had
 * just published: a RECEIVED row pointing at nothing.
 */
export const DELETE_CLAIM_LEASE_MS = STORAGE_CALL_MAX_MS + 15_000;

/**
 * CONFIRM THE CLAIM IS STILL OURS, AND EXTEND IT, in one locked step.
 *
 * Called immediately before the remote delete, with CURRENT time -- never
 * the pass's opening timestamp. A confirmation that does not also extend is
 * a promise about the instant it was taken, and the delete outlives that
 * instant.
 */
export async function renewObjectClaim(
    tx: Prisma.TransactionClient,
    storagePath: string,
    want: ObjectClaimKind,
    token: string,
    until: Date,
    now: Date,
): Promise<boolean> {
    await lockObjectPath(tx, storagePath);
    const held = await tx.receiptObjectClaim.findUnique({ where: { storagePath } });
    if (!held
        || held.token !== token
        || held.kind !== want
        || held.expiresAt.getTime() <= now.getTime()) {
        return false;
    }
    await tx.receiptObjectClaim.update({ where: { storagePath }, data: { expiresAt: until } });
    return true;
}

/** Is `token` still the live claim over `storagePath`, of the kind we took? */
export async function claimIsStillOurs(
    tx: Prisma.TransactionClient,
    storagePath: string,
    want: ObjectClaimKind,
    token: string,
    now: Date,
): Promise<boolean> {
    const held = await tx.receiptObjectClaim.findUnique({ where: { storagePath } });
    return !!held
        && held.token === token
        && held.kind === want
        && held.expiresAt.getTime() > now.getTime();
}

/** Give the path back. Best effort: a lapsed claim is collected by the next claimant. */
export async function releaseObjectClaim(
    tx: Prisma.TransactionClient,
    storagePath: string,
    token: string,
): Promise<void> {
    await tx.receiptObjectClaim.deleteMany({ where: { storagePath, token } });
}
/**
 * The path is held by the other kind of operation right now. Retryable: the
 * holder's lease is short and the caller comes back on its own schedule.
 */
export class ObjectPathBusyError extends Error {
    name = "ObjectPathBusyError";
    constructor(storagePath: string, heldBy: string) {
        super(`${storagePath} is held by a ${heldBy} claim`);
    }
}

/** Which operation holds a path. Exactly one may hold it at a time. */
export type ObjectClaimKind = "publishing" | "deleting";

interface ObjectClaim {
    token: string;
    kind: ObjectClaimKind;
    until: Date;
}

/** The claim an event carries, if it is still live. */
export function liveClaim(detail: string | null | undefined, now: Date): ObjectClaim | null {
    if (!detail) return null;
    let parsed: { claimToken?: unknown; claimKind?: unknown; claimUntil?: unknown };
    try {
        parsed = JSON.parse(detail) as typeof parsed;
    } catch {
        return null;
    }
    if (typeof parsed.claimToken !== "string" || typeof parsed.claimUntil !== "string") return null;
    if (parsed.claimKind !== "publishing" && parsed.claimKind !== "deleting") return null;
    const until = new Date(parsed.claimUntil);
    if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return null;
    return { token: parsed.claimToken, kind: parsed.claimKind, until };
}

/**
 * THE PATH IS HELD BY EXACTLY ONE OPERATION AT A TIME.
 *
 * A publish and a cleanup both act on one object path, and the cleanup's
 * decision to delete is taken BEFORE it deletes. Without a durable claim those
 * two facts can interleave fatally: the sweep reads "unreferenced, due", its
 * transaction commits having persisted nothing, a publisher then claims the
 * path and seals a NEW object at it, and the sweep — still holding a verdict
 * it reached before any of that — deletes the object the publisher is about to
 * point at. Neither party is wrong; nothing recorded that the other had
 * started.
 *
 * So a claim is written, and it is what the other side collides with:
 *   - a publisher refuses while a live `deleting` claim exists;
 *   - a sweep refuses while a live `publishing` claim exists;
 *   - and the sweep RE-READS its own claim immediately before the delete, so a
 *     verdict that went stale between the two transactions cannot act.
 */
export function claimsConflict(
    events: { detail: string | null }[],
    want: ObjectClaimKind,
    now: Date,
): ObjectClaimKind | null {
    for (const event of events) {
        const held = liveClaim(event.detail, now);
        if (held && held.kind !== want) return held.kind;
        // Two publishers may share a path (content-addressed, identical bytes);
        // two deleters may not, and neither may cross.
        if (held && held.kind === "deleting" && want === "deleting") return held.kind;
    }
    return null;
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
                // ONE BUILDER, shared with every other lease-bearing write:
                // state, reason, claim, version, generation and expiry. Hand-
                // rolling it here is how three sweeper writes came to pin only
                // half of it. `storagePath` rides along because a delete is the
                // one operation that must also be sure WHICH object it is
                // accounting for.
                where: { id: row.id, storagePath: row.storagePath, ...leaseFence(row) },
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
    /** A SHORT transaction. No storage call may be awaited inside it. */
    inShortTx: <T>(body: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    remove: (storagePath: string) => Promise<void>;
    now: () => Date;
}

const liveSweepDeps: CleanupSweepDeps = {
    findPending: take => prisma.automationEvent.findMany({
        // BOTH statuses. A provisional intent is an object a publish said it
        // was about to write and then could not account for; leaving it out of
        // the sweep would make the intent a note nobody ever reads.
        where: { kind: STORAGE_CLEANUP_KIND, status: { in: CLEANUP_SWEEPABLE_STATUSES } },
        orderBy: { createdAt: "asc" },
        take,
        select: { id: true, detail: true },
    }),
    abandon: async eventId => {
        await prisma.automationEvent.update({ where: { id: eventId }, data: { status: "abandoned" } });
    },
    inShortTx,
    // A BARE CALL ONLY. The worker builds its own deps with the invocation's
    // deadline (see liveSweepDepsFor): a delete issued with none takes a fresh
    // STORAGE_CALL_MAX_MS regardless of how much of the pass is left, which is
    // how one came to outlive the claim it was running under.
    remove: (storagePath: string) => removeReceiptObject(storagePath, undefined),
    now: () => new Date(),
};

/**
 * The live sweep dependencies, bound to ONE invocation's deadline.
 *
 * The delete is the only external call this sweep makes, and it must be
 * strictly shorter than the claim it runs under -- see DELETE_CLAIM_LEASE_MS.
 * Bounding it by the invocation's remaining budget can only make it shorter,
 * never longer, so the relation holds however late in the pass it starts.
 */
export function liveSweepDepsFor(deadline: RouteDeadline | undefined): CleanupSweepDeps {
    return {
        ...liveSweepDeps,
        remove: (storagePath: string) => removeReceiptObject(storagePath, deadline),
    };
}

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

        // ── CLAIM, DELETE, SETTLE — no storage call inside a transaction ──
        //
        // This used to be one transaction holding the path's advisory lock
        // across the Supabase delete. Correct about exclusion, wrong about
        // cost: a pooled connection was held for a call the round-16 deadline
        // caps at fifteen seconds, so the sweep competed for the pool with
        // every finalization running beside it.
        //
        // PHASE 1 (short tx): decide, and CLAIM.
        //
        // NEVER delete a path a LIVE row still points at. The recovery
        // sequence makes that reachable: an ambiguous upload records a
        // cleanup, the row is deleted, the caller retries, and the retry's row
        // can end up pointing at the same path — or a seal can publish a
        // canonical path an older pending event names. The event is RESOLVED
        // rather than retried forever: the object is accounted for, just not
        // by us.
        //
        // And the newest schedule for the path wins, never the one this
        // particular event carries. An event records the expiry its author
        // OBSERVED, and that author can have been overtaken — a /start refresh
        // extends the lease and queues a second cleanup with a LATER deadline;
        // a publish in flight holds a provisional lease on this very path.
        // Acting on the older event would delete an object something still
        // has a live claim on.
        // The sweep's own lease over the path: long enough to cover the
        // external delete, short enough that a killed pass frees it soon.
        const claimUntil = new Date(now.getTime() + OBJECT_CLAIM_LEASE_MS);
        const claim = await deps.inShortTx(async tx => {
            // THE SAME PER-PATH LOCK THE PUBLISHER TAKES, and first, so the
            // two claim transactions serialize and the second reads what the
            // first wrote. Everything below -- the reference check, the
            // schedule, the claim -- is decided under it.
            const taken = await acquireObjectClaim(tx, storagePath, "deleting", claimUntil, now);
            if (!taken.ok) {
                // A publish holds this path. Its object may not exist yet and
                // the pointer that will reference it has not committed, so
                // 'nothing references this' is true and irrelevant.
                return { verdict: "not-due" as const, siblingIds: [] as string[], token: "" };
            }
            const referenced = await tx.receiptIntake.findFirst({
                where: { storagePath },
                select: { id: true },
            });
            if (referenced) {
                await tx.automationEvent.update({
                    where: { id: event.id },
                    data: { status: "resolved", reason: `still referenced by ${referenced.id}` },
                });
                // Hand the path straight back: nothing is going to be deleted,
                // and holding it would stall a publisher for the lease's length.
                await releaseObjectClaim(tx, storagePath, taken.token);
                return { verdict: "referenced" as const, siblingIds: [] as string[], token: "" };
            }
            const siblings = await tx.automationEvent.findMany({
                where: {
                    kind: STORAGE_CLEANUP_KIND,
                    // Provisional intents included: they name the same object,
                    // so they carry a schedule this delete must respect — a
                    // publish's live claim among them — and they must be
                    // resolved with it rather than left retrying forever
                    // against bytes that are already gone.
                    status: { in: CLEANUP_SWEEPABLE_STATUSES },
                    detail: { contains: JSON.stringify(storagePath) },
                },
                select: { id: true, detail: true },
            });
            // A PUBLISH HOLDS THIS PATH. Its object may not exist yet, and the
            // pointer that will reference it has not committed — so "nothing
            // references this" is true and irrelevant. Leave it entirely.
            // Exclusion is the claim table's job now (acquireObjectClaim, at the
            // top of this transaction). What the siblings still decide is the
            // SCHEDULE: the latest notBefore among every event naming this path.
            const newest = siblings
                .map(sibling => cleanupDueAt(sibling.detail))
                .reduce<Date | null>(
                    (latest, at) => (at && (!latest || at > latest) ? at : latest),
                    null,
                );
            if (pending(newest, now)) {
                await releaseObjectClaim(tx, storagePath, taken.token);
                return { verdict: "not-due" as const, siblingIds: [], token: "" };
            }

            // The claim itself was written at the top of this transaction, in
            // the one place a claim can live. The event's detail keeps only its
            // schedule -- what it is actually for.
            return {
                verdict: "claimed" as const,
                siblingIds: siblings.map(s => s.id),
                token: taken.token,
            };
        }).catch(error => {
            console.error(
                "[receipts/intake] cleanup claim failed, left pending",
                storagePath,
                error instanceof Error ? error.name : "error",
            );
            return { verdict: "failed" as const, siblingIds: [] as string[], token: "" };
        });

        if (claim.verdict !== "claimed") continue;

        // RE-READ THE CLAIM IMMEDIATELY BEFORE THE DELETE.
        //
        // The verdict above was reached in a transaction that has since
        // committed and closed. This confirms, in its own short transaction,
        // that the claim written there is still ours and still live — so a
        // delete can only proceed on a path nothing else has taken since.
        // RENEWED WITH CURRENT TIME, not confirmed against a stale one.
        //
        // Everything above derives from `now`, captured when the pass started.
        // A late item reaches this point seconds later, and the delete that
        // follows takes up to STORAGE_CALL_MAX_MS more -- so a claim measured
        // from the opening instant can lapse while its own delete is still in
        // flight, and a publisher that takes the path in that window has its
        // freshly sealed object removed by it.
        const stillOurs = await deps.inShortTx(async tx => {
            const fresh = await tx.automationEvent.findUnique({
                where: { id: event.id },
                select: { detail: true, status: true },
            });
            if (!fresh || !CLEANUP_SWEEPABLE_STATUSES.includes(fresh.status as CleanupStatus)) return false;
            // Against the CLAIM TABLE, which is the one place a claim lives.
            const at = deps.now();
            return renewObjectClaim(
                tx,
                storagePath,
                "deleting",
                claim.token,
                new Date(at.getTime() + DELETE_CLAIM_LEASE_MS),
                at,
            );
        }).catch(() => false);
        if (!stillOurs) continue;

        // PHASE 2: the external delete, with NO transaction open.
        //
        // A failure leaves every sibling event exactly as it was — still
        // pending, still due — so the next pass simply tries again. That is
        // the same outcome the old rollback produced, without a connection
        // held for the duration.
        try {
            await deps.remove(storagePath);
        } catch (error) {
            console.error(
                "[receipts/intake] queued cleanup left pending",
                storagePath,
                error instanceof Error ? error.name : "error",
            );
            continue;
        }

        const settled = await deps.inShortTx(async tx => {
            for (const id of claim.siblingIds.length ? claim.siblingIds : [event.id]) {
                await tx.automationEvent.update({ where: { id }, data: { status: "resolved" } });
            }
            return true;
        }).catch(error => {
            // The bytes ARE gone; only the bookkeeping failed. The next pass
            // finds the event still pending, removes nothing (the object is
            // already absent) and resolves it then.
            console.error(
                "[receipts/intake] cleanup settle failed after a successful delete",
                storagePath,
                error instanceof Error ? error.name : "error",
            );
            return false;
        });
        const verdict = settled ? "deleted" : "failed";
        if (verdict === "deleted") cleared++;
    }
    return cleared;
}
