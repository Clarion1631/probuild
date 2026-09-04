/**
 * The intake worker — one pass over the claimed rows
 * (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §5).
 *
 * Dry-run is the safety property this whole file exists to protect: with
 * `RECEIPT_INTAKE_DRYRUN` unset or "true" (the default), a row is read,
 * deduped and routed, and then STOPS. No QuickBooks call, no Expense row. The
 * proof is a test, not a comment: tests/receipt-intake-worker.test.ts drives a
 * full pass with injected fakes and asserts createPurchase was called zero
 * times and no Expense was created.
 *
 * Everything external is injected so that test needs no database, no network,
 * and no module mocking (CI is Node 20, where `mock.module` corrupts the
 * require chain).
 */
import { Prisma } from "@prisma/client";
import { canonicalVendor, dedupKeys } from "./keys";
import { dayKeyInTimeZone, startOfDateInTimeZone } from "@/lib/tz-date";
import {
    backoffMs,
    MAX_BOOK_ATTEMPTS,
    routeState,
    TAX_IMPLAUSIBLE_REASON,
    type DedupHits,
    type ReceiptIntakeState,
} from "./route-state";
import {
    appliedTaxCents,
    buildGroups,
    resolveSuggestedCostCodeId,
    type BookableRow,
    type BookResult,
} from "./book";
import { QBTimeoutError } from "@/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
} from "@/lib/qbo-receipt-push";
import { READ_BUDGET_MS, type ProjectPhase, type ReadOutcome } from "./read";
import type { VerifiedBytes } from "./stored-object";
import { STORAGE_TIMEOUT_MESSAGE } from "./bucket";

/**
 * ONE global constant, deliberately not derived from anything per-row or
 * per-deployment: `pg_try_advisory_xact_lock(hashtextextended(CLAIM_LOCK_KEY,0))`
 * is what guarantees a single worker BATCH runs at a time across every
 * concurrent invocation of the cron. A key that varied by row, region, or
 * process would let two batches run together, and the weak-dedup net (a plain
 * SELECT, not a claim) would then miss a pair that arrived in the same tick.
 */
export const CLAIM_LOCK_KEY = "receipt-intake-worker";
export const BATCH_SIZE = 10;
/** How long a claimed row is hidden from the next run. */
export const CLAIM_LEASE_MINUTES = 10;

/**
 * The states whose ONLY remaining step is a QuickBooks write.
 *
 * A row here has already been read, deduped and routed. Nothing else happens
 * to it in a pass: READ waits to be promoted to BOOKING, and BOOKING waits to
 * be booked. Both are exactly what the dry-run switch forbids.
 */
export const QBO_WRITING_STATES = ["READ", "BOOKING"] as const;

/**
 * ELIGIBILITY IS A FUNCTION OF THE CURRENT GLOBAL SWITCH, not of the row alone.
 *
 * `row.dryRun` is written once at intake and never re-read, so it cannot
 * express a ROLLBACK: flip `RECEIPT_INTAKE_DRYRUN` back on and every row that
 * was claimed while the switch was off keeps `dryRun:false`. The worker loop
 * already refuses to book those (the switch outranks the flag), but refusing
 * INSIDE the loop is not enough when the batch is ten rows and the order is
 * oldest-first: a few hundred old live rows are claimed, skipped, claimed
 * again five minutes later, and no NEW receipt is ever read. The queue looks
 * busy and processes nothing — the same starvation the dry-run park exclusion
 * was written to prevent, arriving through the other door.
 *
 * So while the global switch says dry-run, a QBO-writing state is not
 * claimable at all, whatever the row's own flag says. RECEIVED rows still are:
 * reading and routing is precisely what the shadow week is for.
 */
export function claimableStates(dryRunGlobal: boolean): ReceiptIntakeState[] {
    return dryRunGlobal ? ["RECEIVED"] : ["RECEIVED", ...QBO_WRITING_STATES];
}

/**
 * The claim's whole eligibility predicate, in ONE place.
 *
 * Exported (rather than living inline in the cron route) so both the pure
 * worker tests and the real-Postgres claim test assert against the same
 * object the route actually claims with. A second copy of this predicate is
 * how the loop and the claim came to disagree in the first place.
 *
 * STAGING is absent on purpose: the row exists but its object does not, so
 * claiming it would park a good receipt as "file-missing". sweepStaleStaging
 * is what watches those.
 */
export function eligibleClaimWhere(now: Date, dryRunGlobal: boolean): Prisma.ReceiptIntakeWhereInput {
    return {
        state: { in: claimableStates(dryRunGlobal) },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        /**
         * A row parked by the shadow week (dryRun=true, sitting at READ or
         * BOOKING) is DONE until the cutover, and must be excluded rather than
         * merely skipped inside the loop — for the same batch-starvation
         * reason as above. runIntakeWorker's cutover is what brings them back,
         * once, on the first live pass. Redundant while `dryRunGlobal` is true
         * (those states are already off the list) and load-bearing when it is
         * false.
         */
        NOT: { AND: [{ dryRun: true }, { state: { in: [...QBO_WRITING_STATES] } }] },
    };
}

/**
 * How long a row skipped by the global dry-run switch waits before it is
 * looked at again. Same hour as book.ts's "a switch is off" deferral: nothing
 * is wrong with the document, and hammering it every five minutes only costs
 * batch slots that new receipts need.
 */
export const DRYRUN_PARK_RETRY_MS = 60 * 60_000;
/**
 * Stop taking on NEW rows once this much of the 60s function budget is gone.
 * One 25s read plus a QBO round trip can straddle the ceiling, and a row cut
 * off mid-book is the one case where the lease is doing real work rather than
 * being a formality.
 */
export const RUN_SOFT_DEADLINE_MS = 40_000;
/**
 * The invocation's real ceiling (`maxDuration = 60`), minus a small margin so a
 * booking that starts near the edge still gets to write its result. Bookings
 * measure their runway against THIS, not the soft deadline.
 */
export const RUN_HARD_BUDGET_MS = 55_000;
/**
 * How long a row may sit in STAGING before it is presumed to have lost its
 * upload. Generous on purpose: the intake route uploads inline, so a row that
 * is still STAGING after this either crashed mid-request or hit a storage
 * outage, and neither resolves itself.
 */
export const STAGING_SWEEP_MINUTES = 15;
/** Storage round trips per sweep. Small: the sweep runs before any real work. */
export const STAGING_SWEEP_BATCH = 10;
/**
 * Supabase signed upload URLs are valid for two hours. A STAGING row younger
 * than that may still have its bytes arrive, so declaring it file-missing at
 * the 15-minute sweep window was premature — the row went to review while its
 * own upload link was still usable.
 */
export const SIGNED_UPLOAD_TTL_MS = 2 * 60 * 60_000;

/** When a URL issued now stops working. Written to the row by /intake/start. */
export function uploadLeaseExpiry(now: Date = new Date()): Date {
    return new Date(now.getTime() + SIGNED_UPLOAD_TTL_MS);
}

/**
 * Runway reserved AFTER a read for the write that records its result — the
 * row's applyRead/applyState commit — plus whatever this pass still has left
 * to do before the invocation ends. A read given every last millisecond of
 * the run's own budget could return right as the platform kills the
 * function, and its outcome would never be written at all.
 */
export const READ_SAFETY_MARGIN_MS = 2_000;
/**
 * Below this much runway (after the safety margin), starting a read is not
 * worth it: the request itself needs at least this long to have any real
 * chance of finishing. The row is handed back un-attempted — the same
 * AI_UNAVAILABLE answer readReceipt gives for an exhausted budget — rather
 * than begun and abandoned mid-flight when the invocation's own deadline
 * lands.
 */
export const READ_MIN_BUDGET_MS = 5_000;

/**
 * How much of `READ_BUDGET_MS` a read starting now may actually use, given
 * how much runway is left in the WHOLE invocation.
 *
 * `read.ts`'s own READ_BUDGET_MS (25s) is sized against a fresh 60s
 * invocation and assumes it is the first thing to run. It is not: a batch of
 * ten rows can reach its ninth row 45 seconds in, and handing that read
 * another full 25 seconds is what let a row started at 40s still be reading
 * at 65s — past the `maxDuration = 60` ceiling the whole run is supposed to
 * respect. This caps the read's OWN budget at whatever is actually left, so
 * the invocation's one deadline governs every read the same way it already
 * governs every QuickBooks call (see `deps.book`'s `deadline`).
 *
 * Pure and exported so this is a unit test, not a fact about `buildDeps`
 * that nothing without a live cron invocation could ever exercise.
 */
export function readBudgetFor(remainingRunMs: number): number {
    const budget = Math.min(READ_BUDGET_MS, remainingRunMs - READ_SAFETY_MARGIN_MS);
    return budget < READ_MIN_BUDGET_MS ? 0 : budget;
}

/**
 * Could the object still arrive under a live upload URL?
 *
 * ROW AGE IS THE WRONG QUESTION for a two-step row. One whose URL was re-issued
 * (a resumed /start, or a re-arm after the sweeper parked it) is older than its
 * lease, and judging it on createdAt declared a receipt missing — or destroyed
 * one it called unacceptable — while the client's own upload link was still
 * live and about to land. `uploadUrlExpiresAt` is what /start actually
 * promised, so that is what is honoured.
 *
 * NULL IS NOT A TWO-HOUR GRACE. It means no signed URL was ever issued: the
 * single-shot path writes its bytes through the server inside one request, so
 * such a row is either published or it failed mid-request. Giving it the
 * SIGNED-URL TTL made every inline STAGING orphan invisible to the sweep for
 * two hours, waiting on a URL that does not exist. Its grace is the stale-
 * STAGING threshold, the same one the sweep selects on.
 */
export function uploadLeaseActive(
    row: { uploadUrlExpiresAt?: Date | null; createdAt: Date },
    now: Date = new Date(),
): boolean {
    return leaseDeadline(row).getTime() > now.getTime();
}

/**
 * The instant this row's upload capability dies. `uploadLeaseActive` is
 * literally "is that instant still ahead of us", so the two can never
 * disagree about a row.
 */
function leaseDeadline(row: { uploadUrlExpiresAt?: Date | null; createdAt: Date }): Date {
    if (row.uploadUrlExpiresAt) return row.uploadUrlExpiresAt;
    return new Date(row.createdAt.getTime() + STAGING_SWEEP_MINUTES * 60_000);
}

/**
 * How long after a signed upload URL expires an object it could still have
 * written may be deleted.
 *
 * A PUT that started one millisecond before the expiry is still in flight
 * after it — Supabase validates the token when the request arrives, not when
 * it completes — so deleting at the expiry itself can still race a write that
 * was authorised. Five minutes is comfortably longer than an 8 MB upload.
 */
export const CLEANUP_GRACE_MS = 5 * 60_000;

/**
 * WHEN AN OBJECT AT THIS ROW'S PATH MAY BE DELETED — null meaning "now".
 *
 * A signed upload URL is a WRITE CAPABILITY, and it does not stop working
 * because the row that requested it was rejected, published elsewhere, or
 * re-pathed. Deleting the object while the URL is live only opens a window:
 * the holder's delayed PUT recreates it (the URL is `upsert`-capable on the
 * resume path), and nothing then references it, nothing remembers it, and no
 * sweep is looking for it. The delete has to happen AFTER the capability
 * dies, not before.
 *
 * This is the exact inverse of `uploadLeaseActive` — the same rule the
 * stale-STAGING sweep already applies before it parks or rejects anything —
 * so rejected-row cleanup and the sweep agree by construction rather than by
 * two authors remembering the same thing.
 *
 * Null when the capability is ALREADY dead: there is nothing left to wait for
 * and an immediate delete is correct.
 */
export function cleanupNotBefore(
    row: { uploadUrlExpiresAt?: Date | null; createdAt: Date },
    now: Date = new Date(),
): Date | null {
    if (!uploadLeaseActive(row, now)) return null;
    return new Date(leaseDeadline(row).getTime() + CLEANUP_GRACE_MS);
}
/**
 * Consecutive AI-unavailable passes before a row is parked for a human. Ported
 * from v3.4: an outage that never ends still has to end somewhere, and 20
 * passes at 5 minutes each is over an hour of "we tried".
 */
export const MAX_BUSY_PASSES = 20;

/** The columns a pass needs. A superset of BookableRow. */
export interface WorkerRow extends BookableRow {
    state: string;
    /** What finalize recorded. Every download is checked against it. */
    fileSha256: string;
    /** The token this pass claimed the row with. Completing writes are fenced on it. */
    claimToken: string | null;
    fileSize: number;
    readAt: Date | null;
    dedupWeakKey: string | null;
    busyPasses: number;
    /**
     * The fallback transaction date when the document's own date is
     * unreadable. v1 used the Drive UPLOAD date (:1509); the intake row is
     * created when the file arrives, so this is the same semantic — and,
     * unlike "now", it does not drift when a read is delayed by an outage.
     */
    createdAt: Date;
}

export interface WorkerDependencies {
    /**
     * ONE transaction under the global advisory lock: optionally requeue the
     * shadow-week backlog, then claim up to BATCH_SIZE due rows and bump their
     * nextRetryAt. Returns null when another run holds the lock.
     *
     * The requeue lives INSIDE this transaction rather than beside it: run
     * outside the lock, two overlapping invocations could both see the parked
     * backlog and both un-park it, and the second one's UPDATE would race the
     * first one's claim.
     */
    /**
     * Take the whole-invocation lease, or null when another invocation holds a
     * live one. Injected so the overlap rule is a unit test rather than a
     * property only a production race could ever demonstrate.
     */
    acquireLease: () => Promise<{ release: () => Promise<void> } | null>;
    claim: (opts: CutoverRequest) => Promise<ClaimResult | null>;
    /** RECEIPT_INTAKE_DRYRUN is not "false". Injected so the cutover is testable. */
    isDryRunEnabled: () => boolean;
    /** The instant v1 stopped booking. null = not recorded; the cutover then refuses. */
    cutoverBoundary: () => Promise<Date | null>;
    /**
     * Move STAGING rows older than STAGING_SWEEP_MINUTES to NEEDS_REVIEW
     * `file-missing`, or PUBLISH them when the object is actually there.
     * `shouldStop` bounds the pass: the sweep downloads objects, so it must not
     * be able to eat the invocation before any real work starts.
     */
    sweepStaleStaging: (shouldStop: () => boolean) => Promise<number>;
    /** Retry storage deletes that failed when a row was rejected. */
    retryStorageCleanups: (shouldStop: () => boolean) => Promise<number>;
    loadPhases: (projectId: string | null) => Promise<{ id: string; code: string; name: string }[]>;
    /**
     * Re-read the row's projectId immediately before routing.
     *
     * The claim snapshot can be stale by seconds: /finalize accepts a late job
     * assignment while a row is unclaimed, and the Gemini read that runs in
     * between takes 25 seconds. Routing on the snapshot published NEEDS_JOB for
     * a receipt that HAS a job by then — and NEEDS_JOB is where a human goes
     * looking for exactly that problem.
     */
    refreshProjectId: (rowId: string) => Promise<string | null>;
    /**
     * The PERSISTED send flag, re-read at park time.
     *
     * `row.sendAttempted` is the value this pass CLAIMED with, so it is stale
     * the moment the booking marks a send — and the booking marks it precisely
     * so the fact survives a process that dies mid-create. A park decided on
     * the snapshot released the dedup key of a row that has a Purchase in the
     * real books, and the next submission of the same receipt booked it twice.
     *
     * Failing to read it means RETAINING the key: holding one against a
     * booking that did not happen sends a resubmission to a human, and that is
     * a queue item. Releasing one against a booking that did happen is a
     * duplicate payment.
     */
    sendAttemptedNow: (rowId: string) => Promise<boolean>;
    /**
     * Tagged, and VERIFIED: the bytes must hash to what the row recorded at
     * finalize. A sha stored once and never re-checked proves nothing about
     * what is being read now.
     */
    downloadBytes: (storagePath: string, expectedSha256: string) => Promise<VerifiedBytes>;
    read: (bytes: Buffer, mime: string, phases: ProjectPhase[]) => Promise<ReadOutcome>;
    /**
     * Persist the read + routing. Returns the strong-key owner when the partial
     * unique index rejected our claim — that rejection IS the dedup hit.
     */
    /**
     * CAS'd on {id, state, claimToken} like every other mutation. `owned:false`
     * means this worker lost the row mid-pass and must abort — writing on would
     * clobber whatever its successor has since decided.
     *
     * THE ONE WRITE THAT KEEPS THE CLAIM, and the type says so: its state is
     * pinned to "RECEIVED" because routing is not finished when it lands — the
     * strong claim, the weak net and the publish all still have to happen under
     * this same lease. Every TERMINAL outcome goes through applyState instead,
     * which releases ownership in the same fenced write. Writing a terminal
     * state here would leave a finished row holding a claim, and a row that is
     * done but still owned is a row nothing will touch again.
     */
    applyRead: (
        rowId: string,
        patch: ReadPatch & { state: "RECEIVED" },
        ownership: Ownership,
    ) => Promise<{ strongOwner: StrongOwner | null; owned: boolean }>;
    findWeakHit: (rowId: string, weakKey: string) => Promise<{ id: string } | null>;
    /** Marks a row NEEDS_REVIEW / NON_RECEIPT / whatever routing decided, with no keys claimed. */
    applyState: (
        rowId: string,
        state: ReceiptIntakeState,
        stateReason: string | null,
        patch: Partial<ReadPatch> | undefined,
        /** REQUIRED. An unowned write clobbers whatever the successor decided. */
        ownership: Ownership,
    ) => Promise<boolean>;
    /**
     * READ + dryRun=false -> BOOKING, and the LAST weak-dedup check, taken
     * inside the same transaction as the transition. Returns the conflicting
     * row when another document with this weak key is already BOOKING/BOOKED.
     */
    promoteToBooking: (
        rowId: string,
        weakKey: string | null,
        claimToken: string | null,
    ) => Promise<{ promoted: boolean; conflictId?: string; stale?: boolean }>;
    /** The pass's ONE absolute deadline — never a snapshot of "time left". */
    book: (row: BookableRow) => Promise<BookResult>;
    /** CAS'd on the claim: a superseded worker's result must write nothing. */
    applyBookResult: (rowId: string, result: BookResult, claimToken: string | null) => Promise<void>;
    /** AI unavailable: park for a later pass WITHOUT spending an attempt. */
    deferRead: (rowId: string, busyPasses: number, reason: string, ownership: Ownership) => Promise<boolean>;
    /**
     * HAND THE ROW BACK, unchanged except for when to look at it again.
     *
     * A claim is what makes a row invisible to the next pass, so any path that
     * finishes with a row WITHOUT completing, deferring or parking it still has
     * to release ownership — otherwise the row is owned by a pass that has
     * ended, every fenced write misses it, and it sits until its lease lapses.
     * Used by the dry-run skip: nothing about the document is wrong, so it
     * costs no `attempts` and changes no state; it just stops occupying a batch
     * slot that a new receipt needs.
     */
    releaseClaim: (rowId: string, nextRetryAt: Date, ownership: Ownership) => Promise<boolean>;
    /**
     * HAND BACK EVERY ROW THIS PASS CLAIMED AND NEVER LOOKED AT.
     *
     * The claim takes BATCH_SIZE rows in one transaction and stamps them all
     * with a lease (`nextRetryAt = now + LEASE_MS`, ten minutes). The loop then
     * stops at the soft deadline — and the rows it never reached kept that
     * lease AND their claim token, so the next cron five minutes later could
     * not see them at all: `eligibleClaimWhere` skips a row whose `nextRetryAt`
     * is in the future, and every fenced write misses a token no live pass
     * holds. A batch that deadlocked on its first row sat idle for the rest of
     * the ten minutes with nine untouched receipts behind it.
     *
     * Token-fenced, like every other write here: a row whose token changed is
     * owned by somebody else now and must not be handed back by this pass.
     * `nextRetryAt` is cleared rather than set, so the next pass sees them as
     * due immediately — they were never worked on, so there is nothing to
     * back off from.
     *
     * Returns how many rows were actually released.
     */
    releaseUnprocessed: (rows: { id: string; claimToken: string | null }[]) => Promise<number>;
    /** A transient fault anywhere else: spend an attempt and back off. */
    retryRow: (
        rowId: string,
        attempts: number,
        nextRetryAt: Date,
        reason: string,
        ownership: Ownership,
    ) => Promise<boolean>;
    /**
     * RECEIVED -> READ, the release of the claim lease, AND the release of the
     * claim token. Called ONCE, after every dedup net has answered — never
     * before, or an overlapping run could reclaim a half-routed row and book it.
     *
     * FENCED on both the state and the token: a worker whose invocation was
     * killed and whose row has since been re-claimed must not be able to
     * publish READ over whatever its successor produced. Time-based leases
     * cannot express that, because the zombie and the live worker hold
     * identical row ids.
     */
    finishRouting: (
        rowId: string,
        claimToken: string | null,
        stateReason: string | null,
        /** The durable tax marker. READ is reached with no patch of its own. */
        taxWarning: string | null,
    ) => Promise<void>;
    now: () => Date;
    /** Elapsed-time source for the soft deadline. */
    monotonicMs: () => number;
    /** The company's configured time zone — business dates are anchored to it, never UTC. */
    companyTimeZone: () => Promise<string>;
}

/**
 * What a write must still be true of to be allowed.
 *
 * Every worker mutation is a CAS on this. `nextRetryAt` alone is a time-based
 * lease and cannot distinguish a live worker from a zombie whose invocation was
 * killed and whose row has since been re-claimed — both hold the same row id
 * and both believe they own it. Zero rows affected means ownership was lost;
 * the caller aborts rather than overwriting the successor's decisions.
 */
export interface Ownership {
    state: string;
    claimToken: string | null;
}

export interface StrongOwner {
    id: string;
    totalCents: number | null;
    canonicalVendor: string | null;
}

export interface ReadPatch {
    state: ReceiptIntakeState;
    stateReason: string | null;
    /**
     * The dropped-tax-reading marker, in its DURABLE column. `stateReason`
     * carries a copy for the queue to display, but every deferred booking
     * and every park overwrites that column -- see preservedTaxWarning.
     */
    taxWarning: string | null;
    vendor: string | null;
    txnDate: Date | null;
    totalCents: number | null;
    taxCents: number | null;
    docType: string | null;
    refNumber: string | null;
    memo: string | null;
    readJson: string | null;
    readAt: Date;
    dedupStrongKey: string | null;
    dedupWeakKey: string;
    duplicateOfId: string | null;
    suggestedCostCodeId: string | null;
    suggestedConfidence: number | null;
}

export interface WorkerRunSummary {
    processed: number;
    byState: Record<string, number>;
    /**
     * "lease-held": another invocation is mid-pass, so this one did nothing.
     * "already-running": the claim's own advisory lock was taken — only
     * reachable when a lease has expired under a still-running pass.
     */
    skipped?: "already-running" | "lease-held";
    /** Rows left unprocessed because the soft deadline hit. */
    deferredToNextRun?: number;
    /**
     * How many of those `deferredToNextRun` rows were successfully handed back.
     * A shortfall means some rows stayed claimed — either a successor had
     * already taken them, or the release write failed — and those wait out
     * their lease.
     */
    releasedUnprocessed?: number;
    /** Rows v1 already booked, retired as SHADOW_DONE by the first live pass. */
    shadowRetired?: number;
    /** Rows received AFTER v1 stopped: nobody booked these, so they are handed to v2. */
    requeued?: number;
    /** Held for a human: no v1 evidence AND no Drive identity to make v2 idempotent. */
    shadowQuarantined?: number;
    /**
     * Cutover rows whose fenced write matched nothing: they changed between the
     * select that triaged them and the update that would have moved them, so
     * the verdict was DROPPED rather than applied to a row it was not computed
     * for. They come back round on the next pass.
     */
    shadowSkippedMoved?: number;
    /** The cutover could not run because no boundary is recorded. */
    cutoverBlocked?: "cutover-boundary-missing";
    /** STAGING rows whose upload never landed, parked for a human. */
    staleStagingSwept?: number;
    /** Previously-failed object deletions that finally succeeded. */
    orphansCleaned?: number;
}

function centsOf(amount: string): number | null {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

/**
 * The calendar day the receipt was written, anchored in the COMPANY's time
 * zone — not UTC.
 *
 * A receipt read as 2026-08-03 was stored as 2026-08-03T00:00:00Z, which in
 * America/Los_Angeles is 5pm on August 2nd. Every date-range report that
 * bounds by local midnight (job cost by month, the WA tax period, variance by
 * week) therefore put roughly a third of receipts in the wrong bucket, and the
 * error is invisible unless you already suspect it. Everything else in the app
 * anchors business dates with startOfDateInTimeZone; this now does too.
 */
export function dateOnly(value: string, timeZone: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    try {
        const at = startOfDateInTimeZone(value, timeZone);
        return Number.isFinite(at.getTime()) ? at : null;
    } catch {
        return null;
    }
}

/**
 * The most sales tax a receipt can plausibly carry, as a fraction of the total.
 *
 * Washington's highest combined rate is about 10.6%; 12% leaves headroom for a
 * local surcharge without accepting nonsense. The model reads the TAX line off
 * a photo, and a misread decimal point ("$2.92" as "$292") or a grabbed
 * subtotal posts real money to the reimbursable-sales-tax account and inflates
 * a state filing. This is a SANITY bound, not a tax calculation — the tax that
 * survives it is still whatever the document said.
 */
export const MAX_PLAUSIBLE_TAX_RATE = 0.12;

/**
 * Accept the OCR'd tax only when it is between zero and MAX_PLAUSIBLE_TAX_RATE
 * of the total, rounded UP to the cent so a legitimate rounding artefact at the
 * boundary is not rejected.
 *
 * An implausible value is DROPPED, not parked: the receipt itself is fine and
 * its total is what the bank charge will match, so booking it is right. The row
 * simply books as a single un-split line and carries a note, which is exactly
 * what happens for a receipt with no readable tax line at all.
 */
export function validateTaxCents(
    taxCents: number | null,
    totalCents: number | null,
    docType: string | null,
): { taxCents: number | null; implausible: boolean } {
    // No tax line is the NORMAL case here, not a problem.
    if (taxCents === null || taxCents <= 0) return { taxCents: null, implausible: false };

    // A handwritten check to a subcontractor has no sales tax, full stop. If the
    // model produced one it read the wrong number off the cheque — the amount
    // box, a memo figure — and booking it would move real money into the
    // reimbursable-sales-tax account for a payment that was never taxed.
    // sendToQBOviaAPI.js:148 refuses to split tax on a check for the same
    // reason; this makes the row SAY so instead of dropping it silently.
    if (String(docType ?? "receipt").toLowerCase() === "check") {
        return { taxCents: null, implausible: true };
    }

    if (totalCents === null || totalCents <= 0) return { taxCents: null, implausible: true };
    // Tax can never BE the total, let alone exceed it — that is a grabbed
    // subtotal or a misread line, not a tax figure.
    if (taxCents >= totalCents) return { taxCents: null, implausible: true };
    const ceiling = Math.ceil(totalCents * MAX_PLAUSIBLE_TAX_RATE);
    if (taxCents > ceiling) return { taxCents: null, implausible: true };
    return { taxCents, implausible: false };
}

export function toDateStr(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** One pass. Never throws for a single bad row — one poison document must not stall the queue. */
export interface CutoverRequest {
    /**
     * The CURRENT global switch, read ONCE per pass and handed down.
     *
     * ONE field, not a `run` flag beside it: the cutover runs exactly when the
     * pass is live, and claim eligibility depends on the very same answer. Two
     * fields that must always be each other's negation is how they drift, and
     * a claim that disagreed with the loop about the switch is finding #1.
     */
    dryRunGlobal: boolean;
    /**
     * The instant v1 stopped booking. Only rows received before it are even
     * CANDIDATES for retirement — and each still needs its own evidence that v1
     * booked it. Never null when `dryRunGlobal` is false: the pass halts before
     * claiming rather than proceed without it.
     */
    boundary: Date | null;
}

export interface ClaimResult {
    rows: WorkerRow[];
    shadowRetired: number;
    requeued: number;
    /** Pre-boundary, no evidence, and no Drive identity — a human decides. */
    shadowQuarantined: number;
    /** Rows that moved under the triage, so no cutover verdict was applied. */
    shadowSkippedMoved: number;
}

export async function runIntakeWorker(deps: WorkerDependencies): Promise<WorkerRunSummary> {
    // MUTUAL EXCLUSION FOR THE WHOLE PASS, taken before anything is read,
    // claimed or booked.
    //
    // The claim transaction's advisory lock is transaction scoped: it is gone
    // the moment that transaction commits, which is BEFORE the first Gemini
    // read and long before any QuickBooks write. So it never made the worker
    // non-overlapping — it only made the claim itself atomic. A second
    // invocation could (and, at five-minute cron spacing against 60-second
    // passes, eventually would) claim a different batch and run alongside.
    // This lease is what the "one worker at a time" property actually rests
    // on; the per-row claim token is the layer under it that keeps an overlap
    // harmless rather than merely unlikely.
    const lease = await deps.acquireLease();
    if (!lease) return { processed: 0, byState: {}, skipped: "lease-held" };
    try {
        return await runIntakePass(deps);
    } finally {
        // In a `finally`, so a throw out of the pass releases it too. Without
        // that, one crash wedges the queue for a whole lease TTL.
        await lease.release();
    }
}

async function runIntakePass(deps: WorkerDependencies): Promise<WorkerRunSummary> {
    // THE DEADLINE STARTS HERE, at invocation entry — not after the claim and
    // the sweep. The sweep downloads objects, so timing it out of the budget
    // meant it could consume the whole platform timeout and the worker would
    // STILL go on to start a 25s Gemini read and a QBO round trip.
    const startedAt = deps.monotonicMs();
    const outOfTime = () => deps.monotonicMs() - startedAt >= RUN_SOFT_DEADLINE_MS;

    // CUTOVER. Rows received while dry-run was on were booked by v1, so v2 must
    // never book them: they are RETIRED as SHADOW_DONE, not requeued.
    //
    // Requeuing them was a double-booking hazard. v2's QBO identity for an
    // email/chat/mobile/web row is the intake UUID, which v1 never saw, so
    // QuickBooks' DocNumber idempotency could not recognise a Purchase v1 had
    // already created for the same document — and the whole shadow backlog
    // would have been booked a second time, on real books, in one pass.
    // The shadow backlog splits on ONE timestamp: when v1 stopped booking.
    // Everything before it was booked by v1 and is retired to SHADOW_DONE;
    // everything after it was booked by NOBODY and must be handed to v2, or
    // those receipts are silently dropped. Nothing in the database can infer
    // that instant, so with no boundary recorded the pass refuses to touch
    // either side and says so.
    //
    // READ ONCE, USE EVERYWHERE. The switch decides three things in this pass —
    // whether the cutover runs, which states are even claimable, and whether a
    // claimed row may book — and they have to be the same answer. Calling
    // isDryRunEnabled() separately at each of those points is what let the
    // claim hand out rows the loop then refused, forever.
    const dryRunGlobal = deps.isDryRunEnabled();
    const runCutover = !dryRunGlobal;
    const boundary = runCutover ? await deps.cutoverBoundary() : null;

    // HALT THE WHOLE PASS, before anything is claimed.
    //
    // Refusing only the retire/requeue was not enough: the pass went on to claim
    // and BOOK rows while the shadow backlog sat in an undecided state. Live
    // mode with no recorded boundary means we cannot tell which rows v1 already
    // booked, and booking anything under that uncertainty is the double-booking
    // this whole mechanism exists to prevent. Nothing is touched until an
    // operator records the boundary.
    if (runCutover && !boundary) {
        console.error("[cron/receipt-intake-worker] cutover-boundary-missing: halting the pass, nothing claimed");
        return { processed: 0, byState: {}, cutoverBlocked: "cutover-boundary-missing" };
    }

    const claimed = await deps.claim({ dryRunGlobal, boundary });
    if (claimed === null) {
        return { processed: 0, byState: {}, skipped: "already-running" };
    }
    const { rows, shadowRetired, requeued, shadowQuarantined, shadowSkippedMoved } = claimed;

    // Rows whose upload never landed are invisible to the claim by design, so
    // this is the only thing that will ever notice them.
    const staged = await deps.sweepStaleStaging(outOfTime).catch(() => 0);
    // Orphaned objects from rejected rows. Nothing else remembers them.
    const cleaned = await deps.retryStorageCleanups(outOfTime).catch(() => 0);

    const byState: Record<string, number> = {};
    const bump = (state: string) => { byState[state] = (byState[state] ?? 0) + 1; };

    let processed = 0;
    let deferredToNextRun = 0;

    for (const row of rows) {
        // A row started at 41s can still be reading at 66s, past the function
        // ceiling — the invocation dies mid-book and the row's state is
        // whatever it happened to be. Stop TAKING rows instead, and RELEASE the
        // ones we never reached (below): keeping them would leave rows this
        // pass never looked at holding a ten-minute lease under a token nobody
        // owns, invisible to the next cron five minutes later.
        if (outOfTime()) {
            deferredToNextRun = rows.length - processed;
            break;
        }
        processed++;
        // THE ROW AS THE DATABASE NOW HOLDS IT, not as the claim handed it over.
        //
        // Every recovery write below (retryRow, applyState, releaseClaim) is
        // CAS'd on `ownershipOf(...)`, i.e. on {state, claimToken}. The loop
        // MOVES the state mid-row — READ -> BOOKING, committed by
        // promoteToBooking — so a throw after that promotion was handed the
        // ORIGINAL row and its CAS pinned state "READ", which no longer
        // existed. It matched zero rows, `retryRow` reported false, the error
        // was bumped as STALE, and `attempts` never moved: a persistent
        // pre-send failure (a QBO auth outage, a poisoned vendor lookup)
        // cycled the same row forever, never backing off and never reaching
        // the max-retries park that exists to put it in front of a person.
        //
        // So the promotion's result is carried forward, and it is THIS value
        // every error path is given.
        let current = row;
        try {
            if (row.state === "RECEIVED") {
                bump(await processReceived(row, deps));
            } else if (row.state === "READ") {
                // Dry-run rows PARK at READ. This is the shadow-week gate: a
                // row only moves to BOOKING when BOTH its persisted flag AND
                // the CURRENT global switch say live. The persisted flag alone
                // is not a kill switch — it is written once at intake and
                // never rechecked, so a row claimed while RECEIPT_INTAKE_DRYRUN
                // was off keeps dryRun=false even after the switch is reverted
                // to stop live QBO writes.
                //
                // `dryRunGlobal` is this pass's ONE reading of the switch, the
                // same one the claim used, so a row can no longer be handed out
                // as claimable and then refused here. Belt and braces all the
                // same — and the release is what makes the belt safe: a skip
                // that kept the claim left the row owned by a finished pass.
                const live = !row.dryRun && !dryRunGlobal;
                if (!live) { bump(await parkForDryRun(row, deps)); continue; }
                const promotion = await deps.promoteToBooking(row.id, row.dedupWeakKey, row.claimToken);
                if (promotion.stale) {
                    // Superseded between the claim and the promotion. The
                    // successor owns this row; write nothing, book nothing.
                    bump("STALE");
                    continue;
                }
                if (!promotion.promoted) {
                    // Another document with the same canonical vendor, date and
                    // amount reached BOOKING/BOOKED first. Two same-day, same-
                    // amount purchases from one vendor are real, so this asks a
                    // human rather than quarantining — but it must ask BEFORE
                    // the money moves, which is why the check lives inside the
                    // transition rather than beside it.
                    bump("NEEDS_REVIEW");
                    continue;
                }
                // THE PROMOTION COMMITTED, so the row's state is BOOKING from
                // here on and every CAS below must pin that, not the claimed
                // "READ". The claim token is unchanged — promoteToBooking is
                // fenced on it and does not reissue it — so the rest of the
                // ownership tuple still holds.
                current = { ...row, state: "BOOKING", dryRun: false };
                const result = await deps.book(current);
                await deps.applyBookResult(current.id, result, current.claimToken);
                bump(stateForBookResult(result));
            } else if (row.state === "BOOKING") {
                if (row.dryRun || dryRunGlobal) { bump(await parkForDryRun(row, deps)); continue; }
                const result = await deps.book(row);
                await deps.applyBookResult(row.id, result, row.claimToken);
                bump(stateForBookResult(result));
            }
        } catch (error) {
            bump(await handleRowError(current, deps, error));
        }
    }

    // THE ROWS THE DEADLINE CUT OFF ARE HANDED BACK, not left leased.
    //
    // `processed` is incremented BEFORE a row is worked on, so `rows.slice`
    // from it is exactly the set nothing was ever attempted against — a row
    // that threw is `processed` and was already routed through handleRowError,
    // which releases it. Best-effort: a release that fails leaves the row
    // exactly as the old code did, waiting out its lease, which is strictly no
    // worse than not trying.
    let releasedUnprocessed = 0;
    if (deferredToNextRun > 0) {
        releasedUnprocessed = await deps
            .releaseUnprocessed(rows.slice(processed).map(r => ({ id: r.id, claimToken: r.claimToken })))
            .catch(() => 0);
    }

    return {
        processed,
        byState,
        ...(deferredToNextRun ? { deferredToNextRun } : {}),
        ...(releasedUnprocessed ? { releasedUnprocessed } : {}),
        ...(shadowRetired ? { shadowRetired } : {}),
        ...(requeued ? { requeued } : {}),
        ...(shadowQuarantined ? { shadowQuarantined } : {}),
        ...(shadowSkippedMoved ? { shadowSkippedMoved } : {}),
        ...(staged ? { staleStagingSwept: staged } : {}),
        ...(cleaned ? { orphansCleaned: cleaned } : {}),
    };
}

/**
 * A row the dry-run switch will not let this pass advance.
 *
 * It keeps its state — nothing about it is decided, and the moment the switch
 * goes live again it is claimable and bookable exactly as it was. What it does
 * NOT keep is the claim: a skipped row that stayed owned by a finished pass is
 * invisible to every fenced write until its lease lapses, and (before the
 * eligibility fix above) came straight back into the next batch to be skipped
 * again, crowding out the new receipts the shadow week exists to read.
 *
 * A release that FAILS means the row was already taken from us — report STALE
 * rather than pretending the pass parked it.
 */
async function parkForDryRun(row: WorkerRow, deps: WorkerDependencies): Promise<string> {
    const released = await deps.releaseClaim(
        row.id,
        new Date(deps.now().getTime() + DRYRUN_PARK_RETRY_MS),
        ownershipOf(row),
    ).catch(() => false);
    return released ? row.state : "STALE";
}

/**
 * A throw out of a row's processing is almost never the document's fault:
 * Supabase hiccuped, Prisma lost its connection, the settings read failed, a
 * socket reset. Parking all of those for a human turns one bad minute into a
 * queue full of manual work, and (worse) leaves rows holding their strong keys.
 *
 * Only the CLASSIFIED QuickBooks business faults are terminal here. Everything
 * else spends an attempt and comes back on the normal backoff, with the same
 * 20-attempt ceiling as booking so a genuinely broken row still ends up in
 * front of a person.
 */
export async function handleRowError(
    row: WorkerRow,
    deps: WorkerDependencies,
    error: unknown,
): Promise<string> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";

    if (isTerminalQboFault(error)) {
        // A CLASSIFIED QBO fault means the send happened, so parkTerminal will
        // (correctly) keep the key — the decision is still made in one place.
        return parkTerminal(row, deps, `qbo-fault:${message}`.slice(0, 400));
    }

    const attempts = row.attempts + 1;
    if (attempts >= MAX_BOOK_ATTEMPTS) {
        // Same rule as every other terminal park, applied in the same place.
        return parkTerminal(row, deps, "max-retries");
    }
    const ownedRetry = await deps.retryRow(
        row.id,
        attempts,
        new Date(deps.now().getTime() + backoffMs(attempts)),
        `worker-error:${message}`.slice(0, 400),
        ownershipOf(row),
    ).catch(() => false);
    return ownedRetry ? "RETRY" : "STALE";
}

/** QBTimeoutError is deliberately NOT here — a timeout is transport, not a verdict. */
export function isTerminalQboFault(error: unknown): boolean {
    if (error instanceof QBTimeoutError) return false;
    return (
        error instanceof QboPurchaseFaultError ||
        error instanceof QboAccountConfigError ||
        error instanceof QboVendorDuplicateError
    );
}

function stateForBookResult(result: BookResult): string {
    switch (result.outcome) {
        case "booked": return "BOOKED";
        case "needs-review": return "NEEDS_REVIEW";
        case "deferred": return "BOOKING";
        case "retry": return "BOOKING";
        case "stale": return "STALE";
    }
}

async function processReceived(row: WorkerRow, deps: WorkerDependencies): Promise<string> {
    const download = await deps.downloadBytes(row.storagePath, row.fileSha256);
    if (!download.ok) {
        // "The object is gone" and "storage was briefly unreachable" demand
        // opposite answers, and collapsing them to null meant a Supabase blip
        // parked good receipts as file-missing, permanently, for a human to
        // untangle. Only an AFFIRMATIVE not-found is terminal.
        if (download.kind === "missing") {
            return parkTerminal(row, deps, "file-missing");
        }
        // The stored bytes are not the ones this row was published with.
        // Terminal, and loud: it means the object was replaced after
        // verification, which is the exact thing sealing exists to prevent.
        if (download.kind === "sha-mismatch") {
            return parkTerminal(row, deps, "content-changed");
        }
        // A TIMEOUT is tagged apart from every other transient storage fault,
        // because only this one is self-inflicted enough to bound separately.
        return retryTransient(
            row,
            deps,
            download.message?.startsWith(STORAGE_TIMEOUT_MESSAGE)
                ? `${STORAGE_TIMEOUT_PREFIX}1`
                : `storage:${download.message}`,
        );
    }
    const bytes = download.bytes;

    const costCodes = await deps.loadPhases(row.projectId);
    const phases: ProjectPhase[] = costCodes.map(c => ({ code: c.code, name: c.name }));

    const outcome = await deps.read(bytes, row.mimeType, phases);
    if (!outcome.ok) {
        // decisive: the model answered and still could not read it -> a human.
        if (outcome.decisive) {
            return parkTerminal(row, deps, "unreadable");
        }
        // The SERVICE was unavailable. That is never the document's fault, so
        // it costs no `attempts` — but it cannot be free forever either, or an
        // outage that outlasts the incident leaves rows cycling silently. v3.4
        // counts the busy passes separately and gives up after 20.
        const busyPasses = row.busyPasses + 1;
        if (busyPasses >= MAX_BUSY_PASSES) {
            return parkTerminal(row, deps, "ai-unavailable");
        }
        const owned = await deps.deferRead(row.id, busyPasses, "ai-unavailable", ownershipOf(row));
        return owned ? "RECEIVED" : "STALE";
    }

    const read = outcome.read;
    // Resolved BEFORE the keys: the fallback date is part of the dedup key, so
    // it has to be the company's calendar day from the start.
    const timeZone = await deps.companyTimeZone();
    const keys = dedupKeys({
        docType: read.docType,
        vendor: read.vendor,
        date: read.date,
        invoice: read.invoice,
        checkNumber: read.checkNumber,
        totalAmount: read.totalAmount,
        // The company's calendar day, not UTC's. `toISOString().slice(0,10)`
        // rolls over at 16:00/17:00 local, so a receipt uploaded on a Pacific
        // evening got TOMORROW's date as its fallback — changing its dedup key
        // and its reporting period.
        fallbackDateStr: dayKeyInTimeZone(row.createdAt, timeZone),
    });

    const totalCents = centsOf(keys.amount);
    const taxCentsRaw = centsOf(read.taxAmount || "0.00");
    const tax = validateTaxCents(
        taxCentsRaw && taxCentsRaw > 0 ? taxCentsRaw : null,
        totalCents,
        read.docType,
    );

    // PERSIST ONLY WHAT BOOKING WILL ACTUALLY USE.
    //
    // The row's taxCents feeds the sales-tax reports, and those must never show
    // a figure that no Purchase ever carried. So the stored value is not the
    // validated one — it is the value read back out of the SAME buildGroups the
    // booking step calls. If the two ever disagree (a rule added on one side
    // only), the row records the BOOKING's answer and is flagged, rather than
    // quietly reporting a tax that was rejected downstream.
    const accepted = totalCents !== null && totalCents > 0
        ? appliedTaxCents(buildGroups(read.docType, totalCents, tax.taxCents, keys.ref))
        : 0;
    const taxCents = accepted > 0 ? accepted : null;
    const taxImplausible = tax.implausible || (tax.taxCents !== null && taxCents === null);

    const base = {
        // WRITTEN ONCE, HERE, and never touched again. The copy `note()`
        // appends to `stateReason` is for the queue to show; this is the
        // one the BOOKED transition reads, because stateReason is
        // overwritten by every deferred booking and every park.
        taxWarning: taxImplausible ? TAX_IMPLAUSIBLE_REASON : null,
        vendor: read.vendor || null,
        txnDate: dateOnly(keys.dateStr, timeZone),
        totalCents,
        taxCents,
        docType: read.docType || null,
        refNumber: keys.ref,
        memo: read.memo || null,
        readJson: read.raw,
        readAt: deps.now(),
        dedupWeakKey: keys.weak,
        suggestedCostCodeId: resolveSuggestedCostCodeId(read.suggestedPhaseCode, costCodes),
        // Stored beside the suggestion so the queue can sort by it and the
        // booking can record how sure the phase pick was.
        suggestedConfidence: read.suggestedConfidence,
    };

    // Re-read RIGHT BEFORE routing. Everything above — the download, a 25s
    // model call — is time in which a late job assignment can have landed.
    //
    // A FAILED RE-READ IS NOT AN ANSWER ABOUT THE JOB.
    //
    // Swallowing the throw and falling back to the CLAIMED snapshot turned a
    // pool timeout into a routing decision: the snapshot is by definition the
    // row as it looked BEFORE the read, so when it carried no project and a
    // person assigned one during those seconds, the fallback parked a receipt
    // NEEDS_JOB for a job it already had. The person sees their own assignment
    // ignored, and the row waits for a human that nothing will summon.
    //
    // So the two cases are split by what the fallback would actually assert:
    //   - snapshot has NO project: the fallback claims "still unassigned",
    //     which is exactly the fact the failed call was supposed to establish.
    //     Transient — normal backoff, attempt spent, claim handed back.
    //   - snapshot HAS a project: the fallback claims "this job", which the
    //     row itself already recorded and which a late assignment can only
    //     have refined, never removed (the column is SetNull on delete, and a
    //     deleted project is not a reason to re-read Gemini). The routing gate
    //     only asks whether a job exists at all, so the stale answer and the
    //     fresh one agree. It may stand.
    const refreshed = await deps.refreshProjectId(row.id).then(
        value => ({ ok: true, value } as const),
        () => ({ ok: false, value: null } as const),
    );
    if (!refreshed.ok && !row.projectId) {
        return retryTransient(row, deps, "project-refresh-unavailable");
    }
    const projectId = refreshed.ok ? refreshed.value : row.projectId;
    const hasProject = !!projectId;

    const routeInput = {
        docType: read.docType,
        amount: keys.amount,
        totalCents,
        canonicalVendor: canonicalVendor(read.vendor),
    };

    // ORDER MATTERS, and it used to be wrong.
    //
    // The weak lookup ran FIRST, so an exact duplicate — same date, same ref,
    // same vendor, same amount, which therefore matches BOTH nets — routed on
    // the weak hit to NEEDS_REVIEW and never attempted the strong claim at all.
    // The one case the strong key exists to resolve automatically was the one
    // case it never got to see, and every re-sent receipt landed in a human's
    // queue.
    //
    // So: the document-level gates first (multi, non-receipt, refund/zero, no
    // job) because those outrank dedup entirely; then the STRONG claim, which
    // is the only net that can answer DUPLICATE on its own; and only if the
    // strong net is silent do we fall back to the weak one, which by design
    // never decides anything itself.
    // A dropped tax reading is recorded, never parked: the receipt is fine and
    // its TOTAL is what the bank charge matches, so it must still book. The note
    // rides along with whatever state routing picks so the row shows it in the
    // queue. `note()` is applied to every write below rather than to one branch,
    // because a document can be both a duplicate and a bad tax read.
    const note = (reason: string | null): string | null => {
        if (!taxImplausible) return reason;
        return reason ? `${reason};tax-implausible` : "tax-implausible";
    };

    const gate = routeState(routeInput, { strong: null, weak: null }, hasProject);
    if (gate.state !== "READ") {
        // A multi-doc, a non-receipt, or a $0/negative misread must never hold
        // a dedup key — it would quarantine the real receipt that arrives next
        // (:531 and the v3.6 rationale).
        //
        // Via applyState, NOT applyRead: this row is FINISHED — nothing else in
        // this pass will touch it — so the write that parks it must also hand
        // the claim back, atomically. applyRead deliberately keeps the lease
        // (routing continues under it), which for a terminal outcome left a
        // done row owned by a pass that had moved on: invisible to the health
        // probe as anything but "claimed", and untouchable by every fenced
        // write until the lease aged out.
        //
        // Safe to swap: the unique-violation path applyRead exists for cannot
        // fire here, because a gated row claims no strong key at all.
        const owned = await deps.applyState(row.id, gate.state, note(gate.stateReason), {
            ...base,
            state: gate.state,
            dedupStrongKey: null,
            duplicateOfId: gate.duplicateOfId,
        }, ownershipOf(row));
        return owned ? gate.state : "STALE";
    }

    // The strong claim IS the partial unique index: a rejection is the hit.
    //
    // The row deliberately stays RECEIVED here, and keeps its claim lease.
    // Publishing READ at this point was wrong twice over:
    //   - the lease was cleared before the weak lookup ran, so an overlapping
    //     invocation could reclaim the row and BOOK it while this one was still
    //     routing — and this one would then regress it to NEEDS_REVIEW.
    //   - if the weak lookup then threw, the row was left in READ having never
    //     been weak-checked. In shadow mode READ is a terminal parking state,
    //     so it would sit there forever while the daily comparison counted it
    //     as fully deduped. A silent false negative in the one report the
    //     cutover decision rests on.
    // READ is now reached only by finishRouting(), after every net has spoken.
    const applied = await deps.applyRead(row.id, {
        ...base,
        state: "RECEIVED",
        stateReason: note(null),
        dedupStrongKey: keys.strong,
        duplicateOfId: null,
    }, ownershipOf(row));
    // Lost the row mid-read. Everything after this — the strong claim, the weak
    // net, the publish — would be decided on a view the successor has moved past.
    if (!applied.owned) return "STALE";

    if (applied.strongOwner) {
        const second = routeState(routeInput, { strong: applied.strongOwner, weak: null }, hasProject);
        const owned = await deps.applyState(row.id, second.state, note(second.stateReason), {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: second.duplicateOfId,
        }, ownershipOf(row));
        return owned ? second.state : "STALE";
    }

    // No strong hit (or no strong key at all — a placeholder ref). The weak net
    // is a plain query and never a claim (:1591-1596); a hit only ever asks a
    // human, because two genuine same-day purchases from one vendor for the
    // same amount do happen.
    //
    // A THROW here leaves the row RECEIVED with its keys already written, which
    // is exactly right: the next pass re-runs the identical claim (updating a
    // row to the strong key it already holds is a no-op, not a conflict) and
    // re-checks the weak net.
    const weak = await deps.findWeakHit(row.id, keys.weak);
    if (weak) {
        const third = routeState(routeInput, { strong: null, weak }, hasProject);
        // RELEASE the strong key. Nothing was sent to QuickBooks, so this row
        // is parked pre-send and the documented rule applies to it like any
        // other. Holding the key made a CORRECTED resend of the same receipt
        // collide with a row that was never booked — the review queue then had
        // two rows and neither could proceed. The weak pair is still visible to
        // a human through duplicateOfId and the reason.
        const owned = await deps.applyState(row.id, third.state, note(third.stateReason), {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: third.duplicateOfId,
        }, ownershipOf(row));
        return owned ? third.state : "STALE";
    }

    // Routing is complete. This is the ONLY path to READ, and the only place
    // the claim lease is released.
    await deps.finishRouting(
        row.id,
        row.claimToken,
        note(null),
        taxImplausible ? TAX_IMPLAUSIBLE_REASON : null,
    );
    return "READ";
}

/**
 * THE one place a row is parked terminally, and the one place the strong-key
 * release is decided.
 *
 * The rule is a property of the ROW, not of the reason string: if no QBO send
 * was ever attempted, no Purchase can exist, so the dedup key must go back or a
 * corrected resubmission collides with a row that never became a purchase. That
 * was previously re-derived at each call site, and the branches that forgot it
 * (file-missing, unreadable, ai-unavailable, worker-error) each held a key
 * against nothing.
 *
 * `sendAttempted` is the PERSISTED flag — markSendAttempted writes it before
 * the create precisely so this decision survives a process that died mid-send,
 * and it is RE-READ here rather than taken from the row this pass claimed. A
 * failure anywhere after the send (the post-create phase check, the Expense
 * commit, a pool timeout) reaches this function with a snapshot that still says
 * "nothing sent", and releasing the key on that is a duplicate payment.
 */
async function parkTerminal(
    row: WorkerRow,
    deps: WorkerDependencies,
    reason: string,
    patch?: Partial<ReadPatch>,
): Promise<string> {
    // Re-read, never the claim-time snapshot: see sendAttemptedNow.
    const sent = row.sendAttempted || await deps.sendAttemptedNow(row.id).catch(() => true);
    const release = sent ? {} : { dedupStrongKey: null };
    const owned = await deps
        .applyState(row.id, "NEEDS_REVIEW", reason, { ...(patch ?? {}), ...release }, ownershipOf(row))
        .catch(() => false);
    // Zero rows means a successor owns this row now; its state is theirs to set.
    return owned ? "NEEDS_REVIEW" : "STALE";
}

/** The row as this pass claimed it — what every CAS matches on. */
export function ownershipOf(row: WorkerRow): Ownership {
    return { state: row.state, claimToken: row.claimToken };
}

/** A transport-class fault during a row's processing: spend an attempt, back off. */
/**
 * How many storage calls in a row may time out on ONE object before it stops
 * heading the queue.
 *
 * A hung object is not a transient fault after the third go: it is a document
 * that costs the pass its whole storage budget every time it is claimed, and
 * because the claim is oldest-first it is claimed FIRST every time. Three is
 * enough to ride out a Supabase blip and few enough that a genuinely stuck
 * object stops crowding out the receipts behind it.
 */
export const MAX_STORAGE_TIMEOUTS = 3;

/** The marker `lastError` carries so the run length survives between passes. */
export const STORAGE_TIMEOUT_PREFIX = "storage-timeout:";

/**
 * How many CONSECUTIVE storage timeouts this row has now seen.
 *
 * The count lives in `lastError` rather than in a column of its own: it is a
 * property of an unbroken run, it needs no migration, and `lastError` is
 * already the column that records why the last pass gave up. Any other failure
 * writes a different reason there, which is exactly what resets the run — so
 * "consecutive" is enforced by the storage of the counter rather than by
 * remembering to clear it.
 */
export function storageTimeoutRun(lastError: string | null | undefined): number {
    const match = /^storage-timeout:(\d+)\b/.exec(lastError ?? "");
    return match ? Number(match[1]) : 0;
}

/** A transport-class fault during a row's processing: spend an attempt, back off. */
async function retryTransient(row: WorkerRow, deps: WorkerDependencies, reason: string): Promise<string> {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_BOOK_ATTEMPTS) {
        // Through parkTerminal like every other terminal park, so the
        // strong-key release is decided in exactly one place.
        return parkTerminal(row, deps, "max-retries");
    }
    // A STALLED OBJECT STOPS HEADING THE QUEUE.
    //
    // Every other transient fault is worth twenty attempts because it costs
    // almost nothing to retry. A storage timeout is different: it burns the
    // pass's whole storage budget, and the claim is oldest-first, so the same
    // object hangs the next run and the one after that. Bounded separately,
    // and parked with its own reason so a human sees WHY rather than a generic
    // "max-retries" twenty passes later.
    if (reason.startsWith(STORAGE_TIMEOUT_PREFIX)) {
        const run = storageTimeoutRun(row.lastError) + 1;
        if (run >= MAX_STORAGE_TIMEOUTS) return parkTerminal(row, deps, "storage-timeout");
        reason = `${STORAGE_TIMEOUT_PREFIX}${run}`;
    }
    const owned = await deps.retryRow(
        row.id,
        attempts,
        new Date(deps.now().getTime() + backoffMs(attempts)),
        reason,
        ownershipOf(row),
    );
    return owned ? "RETRY" : "STALE";
}

/**
 * A unique-constraint violation. NOT specific to the strong key on purpose.
 *
 * The previous version string-matched "dedupStrongKey" inside `error.meta`,
 * which is a Prisma-version-dependent shape AND is empty for a PARTIAL index on
 * some engine builds — the exact index this whole mechanism relies on. The
 * caller resolves which constraint fired by looking the owner up by
 * dedupStrongKey, which is a fact about the DATA rather than about how Prisma
 * happened to render the error.
 */
export function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
