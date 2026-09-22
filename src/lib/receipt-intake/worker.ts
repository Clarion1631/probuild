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
    NO_ARTIFACT_PARK_REASONS,
    parkReleasesStrongKey,
    routeState,
    STRONG_DUP_REASON_PREFIX,
    TAX_IMPLAUSIBLE_REASON,
    type DedupHits,
    type ReceiptIntakeState,
    type RouteInput,
} from "./route-state";
import { duplicateChainReason } from "./duplicate-guard";
import { judgeWeakGroup, type WeakGroupRow } from "./weak-net";
import {
    appliedTaxCents,
    buildGroups,
    resolveSuggestedCostCodeId,
    type BookableRow,
    type BookResult,
} from "./book";
import { isQBTimeoutError } from "@/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
} from "@/lib/qbo-receipt-push";
import { parseReadJson, READ_BUDGET_MS, type ProjectPhase, type ReadOutcome } from "./read";
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
 * Runway below which the evidence-driven close is not even started.
 *
 * It is a COURTESY on top of a completed booking: one indexed candidate query
 * plus up to a handful of component walks. Begun with too little runway left
 * it would only be killed mid-walk, having spent the round trips and decided
 * nothing — so it is skipped with a warn instead, and the nightly sweep
 * (which is still the backstop for every one of these closes) picks it up.
 *
 * Raised from 3s to 8s (Codex round 2, blocker 2a). 3s was only enough to
 * ADMIT the close — it left nothing for the close's OWN budget once
 * CLOSE_REQUESTS_SAFETY_MARGIN_MS is set aside; see
 * closeRequestsSatisfiedByBooking's own derivation below.
 */
export const CLOSE_REQUESTS_MIN_BUDGET_MS = 8_000;
/**
 * Runway the close's own budget must always leave behind for whatever this
 * pass still has to do once it returns — this row's own accounting
 * (`bump()`), and any later row still waiting in the same batch. The close
 * never gets to spend the invocation down to zero just because it started
 * with room to spare.
 */
export const CLOSE_REQUESTS_SAFETY_MARGIN_MS = 5_000;
/**
 * The most the close's own budget may ever be, however much runway is left.
 * One booking's courtesy close must not be able to eat the rest of a 60s
 * invocation — later rows, their accounting, and their own claim release all
 * still have to fit behind it.
 */
export const CLOSE_REQUESTS_MAX_BUDGET_MS = 8_000;
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
    /**
     * The document's identity, as routing claimed it — or null.
     *
     * Null on a row that reached READ/BOOKING without one: routing released it
     * (the old rule), or never claimed it because the row was jobless. THIS FILE
     * IS THE ONLY PLACE THAT CAN PUT IT BACK, because a human revival
     * (`setReceiptIntakeJob`, `unmarkReceiptIntakeDuplicate`) writes READ
     * directly and READ never routes again.
     */
    dedupStrongKey: string | null;
    /**
     * The model's raw JSON, persisted at read time. `recoverStrongKey` re-derives
     * the key from it with the SAME `dedupKeys` routing used, so the heal cannot
     * invent an identity routing would not have given the row.
     */
    readJson: string | null;
    /**
     * The row this one was last compared to — set by whichever review named it
     * (`strong-dup-amount-mismatch:`, `vendor-mismatch:`, `strong-dup:`). Set job
     * keeps the column, so a heal colliding with exactly that row means a human
     * has already seen this pair and chosen to book anyway.
     */
    duplicateOfId: string | null;
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
    /**
     * Claim the strong key for a row that reached READ/BOOKING without one.
     * CAS'd on ownership like every other write. When the partial unique index
     * refuses the claim, returns the live owner instead of throwing.
     */
    claimStrongKey: (rowId: string, key: string, ownership: Ownership) => Promise<{ owned: boolean; strongOwner: StrongOwner | null }>;
    /**
     * EVERY live row sharing this weak key, not just the first.
     *
     * A `findFirst` cannot answer the question the weak net now asks — "is this
     * row distinguished from ALL of them?" — because the answer depends on the
     * twin the query happened to return. The list is bounded by the caller at
     * MAX_WEAK_GROUP + 1, which is also how an over-large group is recognised.
     */
    findWeakGroup: (rowId: string, weakKey: string) => Promise<WeakGroupRow[]>;
    /**
     * Park a routed DUPLICATE — or refuse to, if rows are already filed behind
     * this one (round-39 gate finding 2; made transactional by round-40 gate
     * finding 1).
     *
     * ONE call, because the check and the transition have to be ONE
     * transaction: the version that read the references and then wrote in a
     * separate statement let an admin commit A→B in between, which is the exact
     * chain being guarded against. The implementation takes the shared
     * `withEvidenceAndChainLocks`, so this path and the admin actions cannot
     * diverge. Returns the state it actually wrote.
     *
     * Optional so a caller that predates it keeps the old behaviour rather than
     * crashing; the cron wires it.
     */
    applyDuplicateTransition?: (
        rowId: string,
        decision: { state: ReceiptIntakeState; stateReason: string | null; duplicateOfId: string | null },
        patch: Partial<ReadPatch>,
        ownership: Ownership,
    ) => Promise<{ owned: boolean; state: ReceiptIntakeState }>;
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
    ) => Promise<{
        promoted: boolean;
        conflictId?: string;
        stale?: boolean;
        /**
         * The weak twins this promotion ruled DISTINCT on reference numbers,
         * non-empty only when there were twins and the group was cleared. The
         * implementation logs one audit event off it once the transaction has
         * committed; the worker itself has nothing to decide from it, and
         * deliberately does not — the verdict is already durable as the
         * promotion.
         */
        autoDistinctFrom?: string[];
        /**
         * The ONE weak twin the net did not judge, because a human already had
         * (`duplicateOfId`) — see healStrongKey's override below, which this is
         * the second half of. Reported for the same audit row, and for the same
         * reason the worker ignores `autoDistinctFrom`: nothing is left to
         * decide.
         */
        humanDistinctFrom?: string | null;
    }>;
    /** The pass's ONE absolute deadline — never a snapshot of "time left". */
    book: (row: BookableRow) => Promise<BookResult>;
    /** CAS'd on the claim: a superseded worker's result must write nothing. */
    applyBookResult: (rowId: string, result: BookResult, claimToken: string | null) => Promise<void>;
    /**
     * CLOSE ANY MISSING-RECEIPT REQUEST THIS BOOKING NOW ANSWERS.
     *
     * Called only after `applyBookResult` has committed a `booked` outcome, and
     * deliberately NOT inside `book.ts`: that transaction runs under
     * `lockReceiptEvidence` with a documented lock order, and taking
     * issue-lifecycle writes inside it invites a deadlock. Outside the
     * transaction, a slow close also cannot extend a money-path lock.
     *
     * `deadlineExceeded` is the CLOSE's OWN budget (CLOSE_REQUESTS_MAX_BUDGET_MS,
     * CLOSE_REQUESTS_SAFETY_MARGIN_MS below), not the invocation's whole
     * remaining runway. It is only checked BETWEEN the close's own queries, so
     * it cannot alone stop a single slow one from overrunning that budget — the
     * caller also races the WHOLE call against the same budget from outside
     * (see closeRequestsSatisfiedByBooking).
     *
     * OPTIONAL, and its absence is not a degraded mode: the sweep still closes
     * these overnight. Every worker test that does not care about it simply
     * omits it, and the one that throws from it proves the pass survives.
     */
    closeRequestsSatisfiedBy?: (expenseId: string, deadlineExceeded: () => boolean) => Promise<unknown>;
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
    /** Phase 3: `taxCents > 0` — a positive read, never a present-but-zero one. */
    taxAtSource: boolean;
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

export interface StrongKeyRecovery {
    key: string;
    routeInput: RouteInput;
}

/**
 * The strong key this row SHOULD hold, re-derived from its persisted read with
 * the very same dedupKeys() routing used — or null when it is legitimately
 * unobtainable: a placeholder ref, a date the reader could not find (the
 * fallback is OUR value, never the document's), a read that no longer parses,
 * or a docType routing would never have keyed. The persisted refNumber and
 * txnDate must agree with the re-derivation; if they do not, a column was
 * edited after routing and nothing is claimed. Routing's DOCUMENT GATES are run
 * again at the end for the same reason, so this can only ever hand back a key
 * routing itself would have minted for the same row.
 *
 * `txnDate` is compared as its UTC day, which is what `dateOnly` produces for
 * every zone at or behind UTC (the company's is America/Los_Angeles). A zone
 * ahead of UTC would store the previous UTC day and every comparison here would
 * disagree — in the safe direction: no key is claimed, and the row books
 * exactly as it does today.
 *
 * PURE. The whole point of re-deriving rather than trusting a column is that
 * this can be asserted without a database.
 */
export function recoverStrongKey(
    row: Pick<WorkerRow, "readJson" | "refNumber" | "txnDate" | "docType" | "totalCents" | "createdAt">,
    timeZone: string,
): StrongKeyRecovery | null {
    if (!row.readJson || !row.txnDate) return null;
    // No phases: a suggestion is not part of any key, and offering none cannot
    // change what the keys come out as.
    const read = parseReadJson(row.readJson, []);
    if (!read) return null;
    // The two docTypes routing keys, AND the row must still agree with the read:
    // a re-classified row is not the document this JSON describes.
    if (read.docType !== "receipt" && read.docType !== "check") return null;
    if (row.docType !== read.docType) return null;

    const arrivalDay = dayKeyInTimeZone(row.createdAt, timeZone);
    const keys = dedupKeys({
        docType: read.docType,
        vendor: read.vendor,
        date: read.date,
        invoice: read.invoice,
        checkNumber: read.checkNumber,
        totalAmount: read.totalAmount,
        fallbackDateStr: arrivalDay,
    });
    if (!keys.strong) return null;
    // The row's own columns are the check on the re-derivation: they were written
    // FROM these keys at read time, so a disagreement means somebody edited one
    // of them afterwards and this key is no longer this row's identity.
    if (keys.ref !== row.refNumber) return null;
    if (keys.dateStr !== toDateStr(row.txnDate)) return null;
    // Same reason, same column-was-edited test: `totalCents` is written from
    // these keys at read time (`base` below), so a disagreement means the money
    // no longer matches the document this key names. It also makes the document
    // gates below see exactly the cents routing saw.
    if (centsOf(keys.amount) !== row.totalCents) return null;

    const routeInput: RouteInput = {
        docType: read.docType,
        amount: keys.amount,
        // The ROW's total, not the read's: it is what a strong-key owner is
        // compared against everywhere else. The check above means the two agree,
        // so this is the number routing itself gated on either way.
        totalCents: row.totalCents,
        canonicalVendor: canonicalVendor(read.vendor),
        dateStr: keys.dateReadOffDocument ? keys.dateStr : null,
        referenceDay: arrivalDay,
    };

    // ROUTING'S OWN DOCUMENT GATES, RUN AGAIN — the gates that WITHHELD the key
    // at routing withhold it here too: a date that cannot belong to this row ("a
    // misread year must not be allowed to claim one", route-state.ts), a zero or
    // negative total, a docType nothing keys. Without this, a row parked
    // `date-implausible` (which never claimed a key, on purpose) and then revived
    // by Set job would come through here, claim the identity routing deliberately
    // refused it, and park `date-implausible` all over again — now HOLDING a key
    // that belongs to no verified document.
    //
    // `hasProject: true` because a MISSING JOB is not a document gate: it is a
    // verdict about our records, and book.ts owns it. Feeding the row's real job
    // in would make the identity depend on whether anyone has filed it yet, which
    // is the coupling the claim-before-the-job-gate change exists to remove.
    if (routeState(routeInput, { strong: null, weak: null }, true).state !== "READ") return null;

    return { key: keys.strong, routeInput };
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
    // What is left of the invocation's REAL ceiling, not of the soft deadline:
    // anything that runs after a booking has already crossed the soft one by
    // definition, and measures its runway against the hard budget the same way
    // `deps.book` does.
    const remainingRunMs = () => RUN_HARD_BUDGET_MS - (deps.monotonicMs() - startedAt);

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
                // BEFORE the promotion, because this is the last point at which a
                // row that was revived by a human (Set job, Retry) can still
                // claim the identity routing never gave it. A dry-run row never
                // gets here, which is correct: it is not about to book.
                const healedRead = await healStrongKey(row, deps);
                if ("parked" in healedRead) { bump(healedRead.parked); continue; }
                current = healedRead.row;
                const promotion = await deps.promoteToBooking(current.id, current.dedupWeakKey, current.claimToken);
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
                current = { ...current, state: "BOOKING", dryRun: false };
                const result = await deps.book(current);
                await deps.applyBookResult(current.id, result, current.claimToken);
                await closeRequestsSatisfiedByBooking(result, deps, remainingRunMs);
                bump(stateForBookResult(result));
            } else if (row.state === "BOOKING") {
                if (row.dryRun || dryRunGlobal) { bump(await parkForDryRun(row, deps)); continue; }
                // Same heal, for the row that resumes here: "Retry now" sends a
                // parked row straight back to BOOKING without routing it.
                const healedBooking = await healStrongKey(row, deps);
                if ("parked" in healedBooking) { bump(healedBooking.parked); continue; }
                current = healedBooking.row;
                const result = await deps.book(current);
                await deps.applyBookResult(current.id, result, current.claimToken);
                await closeRequestsSatisfiedByBooking(result, deps, remainingRunMs);
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
 * THE COURTESY CLOSE, after the booking is already written.
 *
 * A booked receipt frequently IS the answer to a missing-receipt request that
 * is still open, and the nightly sweep is the only thing that notices — except
 * that every native booking bumps `receiptEvidenceEpoch`, which the sweep reads
 * as a stale cycle and restarts its open-issue pass for. On a day with a
 * booking every few minutes it never reaches the end of the list, so a charge
 * whose receipt is already booked keeps being chased for hours. Judging it here
 * removes the starvation rather than racing it.
 *
 * BEST EFFORT, FOUR WAYS, because the money has already moved and a courtesy
 * must never disturb it:
 *   - it only runs for a `booked` outcome, after the result was applied;
 *   - it is SKIPPED with a warn when the invocation has no runway left, rather
 *     than started and killed mid-walk;
 *   - it gets its OWN budget, never the invocation's whole remaining runway
 *     (Codex round 2, blocker 2b) — capped at CLOSE_REQUESTS_MAX_BUDGET_MS and
 *     always leaving CLOSE_REQUESTS_SAFETY_MARGIN_MS behind for whatever this
 *     pass still has to do after it;
 *   - that budget is enforced from OUTSIDE the close too (blocker 2c): the
 *     whole call is RACED against a timer of the same length, because the
 *     `deadlineExceeded` predicate threaded into it is only checked BETWEEN
 *     its own queries and cannot alone stop one slow round trip from
 *     overrunning it. A close that loses the race keeps running in the
 *     background — there is no cancelling a promise — and is left for the
 *     nightly sweep to finish from wherever it lands, exactly like one that
 *     threw or ran out of candidates.
 *
 * THE TIMER LATCHES, IT DOES NOT JUST TIME (round 4, blocker 3): once the
 * race's own timer fires, `closeDeadlineExceeded()` returns `true` from that
 * instant on, for every future call, regardless of what the elapsed-time
 * arithmetic would separately say. A purely time-based predicate leaves a gap
 * — an apply already past its budget when the timer fires but not yet at its
 * own next check would still read "not yet" off the clock alone. The flag
 * closes that gap outright: the close (evidence-close-store.ts) checks this
 * SAME predicate immediately before every apply, so once the timer has fired
 * no new apply can start, whatever the clock says.
 */
async function closeRequestsSatisfiedByBooking(
    result: BookResult,
    deps: WorkerDependencies,
    remainingRunMs: () => number,
): Promise<void> {
    if (result.outcome !== "booked" || !deps.closeRequestsSatisfiedBy) return;
    const remaining = remainingRunMs();
    if (remaining < CLOSE_REQUESTS_MIN_BUDGET_MS) {
        console.warn("[cron/receipt-intake-worker] evidence close skipped: out of budget", result.expenseId);
        return;
    }

    // THE CLOSE'S OWN BUDGET — never the invocation's whole remaining runway.
    // Capped at CLOSE_REQUESTS_MAX_BUDGET_MS, and always leaving
    // CLOSE_REQUESTS_SAFETY_MARGIN_MS behind for this row's own accounting and
    // whatever rows are still queued after it.
    const closeBudgetMs = Math.min(remaining - CLOSE_REQUESTS_SAFETY_MARGIN_MS, CLOSE_REQUESTS_MAX_BUDGET_MS);
    const closeStartedAt = deps.monotonicMs();
    // LATCHED below by the race's own timer — see the module comment above.
    let cancelled = false;
    const closeDeadlineExceeded = () => cancelled || deps.monotonicMs() - closeStartedAt >= closeBudgetMs;

    // `.then`/`.catch` attached to the call's OWN promise, before the race
    // below even starts — not to the race's result. A close that loses the
    // race keeps running with nothing else awaiting it, so if a rejection
    // were only handled after `Promise.race` settled, one landing after that
    // point would be unhandled. Attaching the handling here means it is
    // always in place, whichever side of the race the call lands on — and
    // both branches resolve to `false`, so the race's own result can only
    // ever mean "the timer won".
    const closePromise = deps.closeRequestsSatisfiedBy(result.expenseId, closeDeadlineExceeded)
        .then(() => false as const)
        .catch(error => {
            // Error NAME only, never the message (Codex round 3, should-fix
            // 2) — a message can echo query parameters or other unbounded
            // text; a name is one of a small, fixed set, so this line stays
            // ids-only the same way evidence-close's own warns do.
            console.warn("[cron/receipt-intake-worker] evidence close failed", result.expenseId,
                error instanceof Error ? error.name : "UnknownError");
            return false as const;
        });

    // THE WHOLE CALL is raced against the SAME budget, not just polled by it.
    // `closeDeadlineExceeded` is cooperative — checked only between the
    // close's own queries — so one slow round trip could still overrun the
    // budget with nothing there to notice. Racing the call is what actually
    // bounds how long THIS pass waits: on a timeout the close is abandoned
    // from the worker's point of view (it keeps running in the background;
    // nothing here can cancel a promise) and left for the nightly sweep to
    // finish from wherever it was, exactly like one that threw.
    let timer!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<true>(resolve => {
        timer = setTimeout(() => {
            // LATCH FIRST, resolve second: any deadlineExceeded() call from
            // this instant forward — including one already in flight inside
            // the still-running closePromise — sees `cancelled`, even one
            // whose own elapsed-time arithmetic has not yet crossed the
            // budget (round 4, blocker 3).
            cancelled = true;
            resolve(true);
        }, closeBudgetMs);
    });
    try {
        if (await Promise.race([closePromise, timedOut])) {
            console.warn("[cron/receipt-intake-worker] evidence close timed-out; leaving it to the nightly sweep", result.expenseId);
        }
    } finally {
        clearTimeout(timer);
    }
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
 * A row about to book without its strong key claims it now, or learns that it
 * cannot.
 *
 * READ AND BOOKING ARE REACHED WITHOUT ROUTING. `setReceiptIntakeJob` and
 * `unmarkReceiptIntakeDuplicate` write READ straight onto a parked row, and
 * "Retry now" resumes a row at BOOKING; none of them runs the routing that
 * claims a strong key. So a row whose key was released at park time (the old
 * rule), or never claimed because the row was jobless, would book owning no
 * identity at all — and the same document re-sent, read with a different total,
 * would miss both nets and book a second time.
 *
 * The key is RE-DERIVED from the row's persisted read rather than trusted from
 * anywhere, so this can never claim an identity routing itself would not have
 * given the row. A null recovery is a legitimate answer and the row books as it
 * always did.
 *
 * Returns the row to carry forward, a terminal state name when the row was
 * parked here, or "STALE" when ownership was lost.
 */
async function healStrongKey(
    row: WorkerRow,
    deps: WorkerDependencies,
): Promise<{ row: WorkerRow } | { parked: string }> {
    // Already owns one. No dep call: the overwhelming majority of rows are here.
    if (row.dedupStrongKey !== null) return { row };

    const recovery = recoverStrongKey(row, await deps.companyTimeZone());
    if (!recovery) {
        // Every other null is a property of the DOCUMENT (no readable date, a
        // placeholder ref, a docType nothing keys) and is not news. A read that
        // no longer parses is a property of OUR data, so it gets a line.
        if (row.readJson && !parseReadJson(row.readJson, [])) {
            console.warn(
                "[receipt-intake] readJson no longer parses, so no strong key can be recovered",
                JSON.stringify({ rowId: row.id }),
            );
        }
        return { row };
    }

    const claim = await deps.claimStrongKey(row.id, recovery.key, ownershipOf(row));
    // Lost the row mid-pass. Write nothing, book nothing.
    if (!claim.owned) return { parked: "STALE" };
    if (claim.strongOwner === null) return { row: { ...row, dedupStrongKey: recovery.key } };

    // A HUMAN ALREADY SAW THIS EXACT COLLISION. The review that parked the row
    // named the owner in `duplicateOfId` (`strong-dup:`, `vendor-mismatch:`,
    // `strong-dup-amount-mismatch:`), and they pressed Set job anyway. Re-parking
    // it against the same row would overrule that decision with the very fact
    // they were shown, so the row books — keyless, which is the honest state: the
    // identity belongs to the other row.
    //
    // THE OTHER HALF OF THIS EXEMPTION IS IN promoteToBooking: the owner named
    // here is a live twin with the same vendor, day, amount and ref, so the weak
    // net would have parked the row `weak-dup:<owner>` the instant this branch
    // let it past — every button looping. `judgeWeakGroup` therefore drops the
    // twin `self.duplicateOfId` names (weak-net.ts), which is what makes this
    // exit real end to end rather than a two-step version of the same stop.
    if (claim.strongOwner.id === row.duplicateOfId) {
        console.warn(
            "[receipt-intake] strong key held by the row a human already compared it to; booking without one",
            JSON.stringify({ rowId: row.id, key: recovery.key, ownerId: claim.strongOwner.id }),
        );
        return { row };
    }

    const decision = routeState(recovery.routeInput, { strong: claim.strongOwner, weak: null }, true);
    // NEVER AUTO-QUARANTINE FROM HERE. A row is keyless at this point largely
    // because a human put it here, so DUPLICATE — which retires the row without
    // asking — is not this function's to write. The same collision that routing
    // resolves automatically becomes a review item instead, naming the owner.
    const verdict = decision.state === "DUPLICATE"
        ? {
            state: "NEEDS_REVIEW" as ReceiptIntakeState,
            stateReason: STRONG_DUP_REASON_PREFIX + claim.strongOwner.id,
            duplicateOfId: claim.strongOwner.id,
        }
        : decision;
    const owned = await deps.applyState(
        row.id,
        verdict.state,
        verdict.stateReason,
        { duplicateOfId: verdict.duplicateOfId },
        ownershipOf(row),
    ).catch(() => false);
    return { parked: owned ? verdict.state : "STALE" };
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

/**
 * A row other rows are already filed behind may not itself become a
 * DUPLICATE (Codex PR #443 gate round 39, finding 2).
 *
 * Routing can reach DUPLICATE for such a row: the strong-key owner it
 * matches was claimed while this row was still being routed, so nothing had
 * published it as an original yet — and parking it there leaves every row
 * pointing at it filed behind a copy, the exact chain the manual path
 * refuses to build.
 *
 * NEEDS_REVIEW rather than a throw: this is a background pass over a batch,
 * and one row that needs a human is not a reason to abandon the rest. The
 * reason names the referencing rows so the human can see what to unmark, and
 * `duplicateOfId` is kept because it is the evidence for the decision they
 * are being asked to make (route-state.ts already pairs the two this way).
 */
async function applyRoutedState(
    deps: Pick<WorkerDependencies, "applyState" | "applyDuplicateTransition">,
    rowId: string,
    decision: { state: ReceiptIntakeState; stateReason: string | null; duplicateOfId: string | null },
    patch: Partial<ReadPatch>,
    ownership: Ownership,
    note: (reason: string | null) => string | null,
): Promise<{ owned: boolean; state: ReceiptIntakeState }> {
    if (decision.state === "DUPLICATE" && deps.applyDuplicateTransition) {
        return deps.applyDuplicateTransition(rowId, decision, patch, ownership);
    }
    const owned = await deps.applyState(rowId, decision.state, note(decision.stateReason), patch, ownership);
    return { owned, state: decision.state };
}

/** QBTimeoutError is deliberately NOT here — a timeout is transport, not a verdict. */
export function isTerminalQboFault(error: unknown): boolean {
    // NAME-BASED (round 40, item 4): Node 20 + tsx can load quickbooks.ts
    // twice under different specifiers, and an `instanceof` that answers false
    // for a timeout the QBO client itself threw would classify it as a
    // TERMINAL fault  parking a row that only needed a retry.
    if (isQBTimeoutError(error)) return false;
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
        // Nothing was sent and nothing is written back: the row is already
        // whatever the human made it (VOID, DUPLICATE, ...). Reporting the
        // state it USED to be in would overwrite their decision.
        case "aborted": return "ABORTED";
        // book.ts already recorded the orphaned Purchase on the row; the state
        // is whatever the human set (VOID/DUPLICATE) and must not be moved.
        case "booked-after-void": return "BOOKED_AFTER_VOID";
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
            return parkTerminal(row, deps, NO_ARTIFACT_PARK_REASONS.contentChanged);
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
    // The company's calendar day, not UTC's. `toISOString().slice(0,10)`
    // rolls over at 16:00/17:00 local, so a receipt uploaded on a Pacific
    // evening got TOMORROW's date as its fallback — changing its dedup key
    // and its reporting period. Resolved once: it is both the dedup fallback
    // and the reference the read date's plausibility is judged against.
    const arrivalDay = dayKeyInTimeZone(row.createdAt, timeZone);
    const keys = dedupKeys({
        docType: read.docType,
        vendor: read.vendor,
        date: read.date,
        invoice: read.invoice,
        checkNumber: read.checkNumber,
        totalAmount: read.totalAmount,
        fallbackDateStr: arrivalDay,
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
        // Phase 3: the receipt carried sales tax GTR paid at the register. An
        // ABSENT tax read and a ZERO one are the same answer here — neither is
        // evidence that tax was paid — so this is derived from `taxCents` being
        // a positive number, never from the field merely existing.
        taxAtSource: taxCents !== null && taxCents > 0,
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
        // ONLY the DOCUMENT's own date is judged. When the reader found none —
        // or produced something malformed, which `dedupKeys` treats the same
        // way — `keys.dateStr` is `arrivalDay` itself, and measuring our own
        // substitute against itself proves nothing. Note what that means
        // downstream: the substitute is PERSISTED as `txnDate` below, so such a
        // row books on its arrival day. That is deliberate, long-standing
        // behaviour (v1 used the upload date) and this guard does not revisit
        // it — it has an opinion about a date the reader GOT WRONG, never about
        // one it could not read.
        dateStr: keys.dateReadOffDocument ? keys.dateStr : null,
        referenceDay: arrivalDay,
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
    // So: the document-level gates first (multi, non-receipt, refund/zero,
    // implausible date, no job) because those outrank dedup entirely; then the
    // STRONG claim, which is the only net that can answer DUPLICATE on its own;
    // and only if the strong net is silent do we fall back to the weak one,
    // which by design never decides anything itself.
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
    if (gate.state !== "READ" && gate.state !== "NEEDS_JOB") {
        // A multi-doc, a non-receipt, a $0/negative misread, or a date that
        // cannot belong to this row must never hold a dedup key — it would
        // quarantine the real receipt that arrives next (:531 and the v3.6
        // rationale). The date matters here twice over: it is half the strong
        // key, so a misread year invents one nothing else will ever collide
        // with.
        //
        // NEEDS_JOB IS NOT ONE OF THOSE. It is a verdict about our records, not
        // about the document: the receipt is perfectly readable and perfectly
        // real, it just has nobody to bill yet. So it falls through to the
        // claim below and parks HOLDING its key.
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
        const gated = await applyRoutedState(deps, row.id, gate, {
            ...base,
            state: gate.state,
            dedupStrongKey: null,
            duplicateOfId: gate.duplicateOfId,
        }, ownershipOf(row), note);
        return gated.owned ? gated.state : "STALE";
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
        const applied2 = await applyRoutedState(deps, row.id, second, {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: second.duplicateOfId,
        }, ownershipOf(row), note);
        return applied2.owned ? applied2.state : "STALE";
    }

    // NO JOB YET: parked AFTER the claim, HOLDING the key. Set job sends this
    // row to READ, and READ never routes again — the strong claim happens here
    // or never. The patch deliberately carries no `dedupStrongKey`, so the
    // claim applyRead committed stands. The weak net is not consulted for a row
    // nobody can book yet; promotion runs it when the row is actually about to
    // book, exactly as before.
    if (gate.state === "NEEDS_JOB") {
        const jobless = await applyRoutedState(deps, row.id, gate, {
            ...base,
            duplicateOfId: null,
        }, ownershipOf(row), note);
        return jobless.owned ? jobless.state : "STALE";
    }

    // No strong hit (or no strong key at all — a placeholder ref). The weak net
    // is a plain query and never a claim (:1591-1596); when it stops a row it
    // only ever asks a human, because two genuine same-day purchases from one
    // vendor for the same amount do happen.
    //
    // BUT IT IS A FALLBACK, NOT AN OVERRIDE. The weak key is a coarse hash of
    // vendor + day + amount; a reference number is the vendor's own identifier
    // for the transaction. When BOTH documents carry a real one and the two are
    // not plausibly misreads of each other, the question the weak net is asking
    // has already been answered and it must not overrule that. judgeWeakGroup
    // holds the whole rule; see weak-net.ts for why it reads `refNumber` rather
    // than the strong key this very branch is about to release.
    //
    // A THROW here leaves the row RECEIVED with its keys already written, which
    // is exactly right: the next pass re-runs the identical claim (updating a
    // row to the strong key it already holds is a no-op, not a conflict) and
    // re-checks the weak net.
    const twins = await deps.findWeakGroup(row.id, keys.weak);
    const self: WeakGroupRow = { id: row.id, refNumber: keys.ref, resolution: null };
    const verdict = judgeWeakGroup(self, twins);
    if (verdict.kind === "park") {
        const third = routeState(routeInput, { strong: null, weak: { id: verdict.twinId } }, hasProject);
        // THE STRONG KEY IS KEPT, and the patch says so by saying nothing: it
        // carries no `dedupStrongKey`, so the claim applyRead already committed
        // stands.
        //
        // This branch used to release it. The partial unique index is
        // `WHERE dedupStrongKey IS NOT NULL AND state NOT IN ('DUPLICATE','VOID')`
        // — the index itself encodes the rule that DEAD rows give keys back. A
        // row parked NEEDS_REVIEW awaiting a decision is not dead; it still
        // represents its document, and releasing its key asserts that the
        // document's identity is unclaimed, which is false.
        //
        // The release's own justification was that the parked row had no exit,
        // so a corrected resend would collide with a row that could never
        // proceed. This PR dissolves that premise: the row now has three exits
        // (it auto-clears, Retry re-routes it, Set job revives it). And leaving
        // the key held is what makes the resend cases correct — an identical
        // resend hits the index and routes DUPLICATE, a resend with a corrected
        // total routes `strong-dup-amount-mismatch:<owner>`, which is exactly
        // what the strong net exists to say when it cannot tell which total is
        // right. Released, both of those sail past every net and book twice.
        const applied3 = await applyRoutedState(deps, row.id, third, {
            ...base,
            duplicateOfId: third.duplicateOfId,
        }, ownershipOf(row), note);
        return applied3.owned ? applied3.state : "STALE";
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
 * IT TAKES BOTH A PROPERTY OF THE ROW AND A PROPERTY OF THE REASON.
 *
 *   - THE REASON: only a row that has OUTLIVED ITS DOCUMENT gives its key back
 *     (`parkReleasesStrongKey` — `receipt-bytes-missing`, `content-changed`).
 *     Every other park here — `file-missing`, `unreadable`, `ai-unavailable`,
 *     `storage-timeout`, `max-retries`, a worker error — leaves a row that
 *     still represents its document and that a human revives with Set job or
 *     Retry. Neither of those routes the row again, so a key released at park
 *     time is never re-claimed: the same document re-sent with a differently
 *     read total misses both nets and books, and the parked row then books too.
 *   - THE ROW: if a QBO send may have happened, a Purchase may exist, and the
 *     key stays claimed whatever the reason says.
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
    // The re-read is only worth a round trip when a release is on the table.
    const release = parkReleasesStrongKey(reason)
        && !(row.sendAttempted || await deps.sendAttemptedNow(row.id).catch(() => true))
        ? { dedupStrongKey: null }
        : {};
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
