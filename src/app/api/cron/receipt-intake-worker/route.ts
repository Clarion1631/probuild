import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";
import { acquireCronLease } from "@/lib/cron-lease";
import { logAutomationEvent } from "@/lib/automation-events";
import {
    downloadVerified,
    inspectStoredObject,
    // THE one builder for a lease-bearing CAS. See leaseFence.
    leaseFence,
    sealAndPublish,
} from "@/lib/receipt-intake/stored-object";
import {
    deleteObjectOrRecord,
    queueObjectCleanup,
    rejectRowAndQueueCleanup,
    retryPendingCleanups,
    sealObject,
    settleQueuedCleanup,
    withReceiptPublishLock,
} from "@/lib/receipt-intake/storage-cleanup";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { createQBReceiptPurchase } from "@/lib/qbo-receipt-push";
import { createRouteDeadline, remainingBudgetMs, type RouteDeadline } from "@/lib/quickbooks";
import { readReceipt } from "@/lib/receipt-intake/read";
import { canonicalVendor } from "@/lib/receipt-intake/keys";
import {
    applyCutoverVerdict,
    driveFileIdOf,
    triageCutoverRows, resolveCutoverBoundary, type CutoverRow } from "@/lib/receipt-intake/cutover";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { isCostCodeAllowedForProject, resolveProjectPhaseCodes } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { bookReceipt, type BookPrismaClient } from "@/lib/receipt-intake/book";
import { backoffMs } from "@/lib/receipt-intake/route-state";
import {
    BATCH_SIZE,
    CLAIM_LEASE_MINUTES,
    CLAIM_LOCK_KEY,
    cleanupNotBefore,
    RUN_HARD_BUDGET_MS,
    STAGING_SWEEP_BATCH,
    STAGING_SWEEP_MINUTES,
    type ClaimResult,
    type CutoverRequest,
    eligibleClaimWhere,
    isUniqueViolation,
    readBudgetFor,
    runIntakeWorker,
    uploadLeaseActive,
    type ReadPatch,
    type WorkerDependencies,
    type WorkerRow,
} from "@/lib/receipt-intake/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Receipt Pipeline v2 worker (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §5).
 * Every 5 minutes: claim at most 10 due rows, read/dedup/route the new ones,
 * and book the ones that are cleared to book.
 *
 * OVERLAP SAFETY, in three layers — and it is worth being exact about what
 * each one actually buys, because the first two were once described as though
 * they did the third one's job:
 *
 *   1. A DURABLE INVOCATION LEASE (lib/cron-lease.ts), taken before anything is
 *      read, claimed or booked and released in a `finally`. THIS is what makes
 *      the worker non-overlapping. Its TTL outlives `maxDuration`, so the
 *      platform kills a pass before its lease can lapse.
 *   2. `pg_try_advisory_xact_lock` around the CLAIM TRANSACTION. It is
 *      transaction scoped and is gone the moment that transaction commits — it
 *      makes the cutover triage and the claim atomic with respect to each
 *      other, and NOTHING about the Gemini read and QuickBooks write that
 *      follow. It is retained because a lease that expires under a still-live
 *      pass (or a stray manual invocation) must still not corrupt a claim.
 *   3. Per-row ownership. The claim bumps every taken row's `nextRetryAt` and
 *      stamps a `claimToken` that every completing write is fenced on, so even
 *      two interleaved passes never hand the same row to two workers — and
 *      QBO's DocNumber/requestid idempotency means a double booking creates
 *      one Purchase, not two.
 *
 * pgbouncer is why (2) cannot simply be a SESSION advisory lock: a pooled
 * connection is not the same connection twice (see review-alert-rollout.ts:8).
 *
 * Auth is isCronAuthorized() from lib/cron-auth: constant-time Bearer compare,
 * required EVERYWHERE except an explicit NODE_ENV === "development", and a
 * missing CRON_SECRET rejects rather than waving traffic through.
 */

const LEASE_MS = CLAIM_LEASE_MINUTES * 60_000;

const WORKER_ROW_SELECT = {
    id: true, source: true, sourceRef: true, state: true, dryRun: true,
    projectId: true, costCodeId: true, suggestedCostCodeId: true,
    storagePath: true, fileName: true, mimeType: true, fileSize: true,
    vendor: true, txnDate: true, totalCents: true, taxCents: true,
    docType: true, refNumber: true, memo: true, attempts: true, readAt: true, lastError: true,
    suggestedConfidence: true, sendAttempted: true, claimToken: true, fileSha256: true,
    createdAt: true, dedupWeakKey: true, busyPasses: true, stateReason: true,
} as const;

/**
 * RELEASING OWNERSHIP is part of the transition, not a follow-up write.
 *
 * A claim is what makes a row invisible to the next pass. Every write that
 * COMPLETES, DEFERS or PARKS the work must hand it back in the same update, or
 * the row stays owned by a pass that has finished: the claim query skips it,
 * every fenced write misses it, and it sits until a human notices. The only
 * transitions that keep it are READ -> BOOKING (the same pass books it, under
 * the same token) and abandonment at the soft deadline, where the pass really
 * is still holding the row.
 */
const RELEASE_CLAIM = { claimToken: null, claimedAt: null } as const;

/**
 * How long the invocation lease is held for.
 *
 * Longer than the route's own `maxDuration = 60`, deliberately: a lease that
 * could expire while its pass was still running would let a second invocation
 * in on exactly the run it exists to exclude, and the only alternative is
 * heartbeating from inside a loop that spends its time blocked on Gemini and
 * QuickBooks. The platform kills the pass first, and the next cron is five
 * minutes out, so a crashed invocation's lease is always stale before anyone
 * needs it.
 */
const WORKER_LEASE_MS = 90_000;
const WORKER_LEASE_KEY = "receiptIntakeWorkerLease";

async function claim(opts: CutoverRequest): Promise<ClaimResult | null> {
    const now = new Date();
    return prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
        );
        if (!lock?.locked) return null;

        // CUTOVER, inside the lock and the same transaction as the claim.
        //
        // Everything received during the shadow week was booked by v1, so v2
        // RETIRES it — SHADOW_DONE, terminal, never booked here. It is not
        // requeued, because v2's QBO identity for an email/chat/mobile/web row
        // is the intake UUID, which v1 never saw: QuickBooks' DocNumber
        // idempotency could not have recognised the Purchase v1 already made,
        // and the entire backlog would have booked a second time on real books
        // in a single pass. (Drive rows book under the Drive file id — v1's own
        // identity — so those alone would have been safe. That is not enough to
        // requeue the rest.)
        //
        // The rows keep their read results and dedup keys, so a post-cutover
        // resend of the same receipt still collides with them and is caught.
        let shadowRetired = 0;
        let shadowQuarantined = 0;
        let requeued = 0;
        /** Rows that moved between the select and the write, so no verdict landed. */
        let shadowSkippedMoved = 0;
        if (!opts.dryRunGlobal) {
            // runIntakeWorker halts before ever calling claim() without one, so
            // this is belt-and-braces rather than the real gate.
            if (!opts.boundary) {
                console.error("[cron/receipt-intake-worker] claim() reached with no boundary — refusing");
            } else {
                const parked: Prisma.ReceiptIntakeWhereInput = {
                    dryRun: true,
                    state: { in: ["READ", "BOOKING"] },
                };

                // RETIREMENT NEEDS POSITIVE EVIDENCE, not just an old timestamp.
                //
                // "Received before the boundary" says when the file ARRIVED, not
                // that anything booked it. v1 skips documents constantly — a bad
                // read, a park, a file it never picked up — and every one of
                // those would have been retired as "booked-by-v1" and silently
                // dropped. So a row is only retired when we can point at the
                // booking:
                //
                //   * an AutomationEvent from v1's own push (it goes through
                //     ProBuild's create route, which logs kind receipt-push with
                //     status created/already-exists and the Drive fileId), or
                //   * the forwarder telling us it archived the file
                //     (archivedByV1, set from the forward payload).
                //
                // Everything else is handed to v2. That is safe for the Drive
                // rows this applies to: they book under the DRIVE FILE ID, so
                // QBO's DocNumber/requestid idempotency collapses a v1/v2
                // overlap into one Purchase.
                // EVERY parked row, not just the ones older than the
                // boundary. Evidence outranks the timestamp: the forwarder can
                // hand over a file v1 had ALREADY booked minutes after the
                // flip (a queued send, a retry, a slow archive step), and
                // filtering by createdAt first meant those rows never reached
                // the evidence check at all — they went straight into the
                // requeue and v2 booked a second Purchase for an email or chat
                // receipt, where there is no shared identity to collapse it.
                // The boundary is only used to decide what to do with rows that
                // have NO evidence either way.
                const candidates = await tx.receiptIntake.findMany({
                    where: parked,
                    select: {
                        id: true, source: true, sourceRef: true,
                        archivedByV1: true, createdAt: true,
                        // The evidence each write fences on, read here so the
                        // verdict and the row it was reached about travel
                        // together instead of the write re-deriving a predicate.
                        // claimToken is PINNED at what was observed rather than
                        // required null — see CutoverRow for why demanding null
                        // would hide a stale-claimed row from the cutover for
                        // good.
                        state: true, stateReason: true, dryRun: true, claimToken: true,
                    },
                });

                const driveIds = candidates
                    .map(driveFileIdOf)
                    .filter((v): v is string => !!v);

                const bookedByV1 = driveIds.length
                    ? new Set(
                        (await tx.automationEvent.findMany({
                            where: {
                                kind: "receipt-push",
                                status: { in: ["created", "already-exists"] },
                                driveFileId: { in: driveIds },
                            },
                            select: { driveFileId: true },
                        })).map(e => e.driveFileId).filter((v): v is string => !!v),
                    )
                    : new Set<string>();

                // Three outcomes, not two. The middle one is the honest answer
                // to a question we cannot settle from data:
                //
                //   evidenced      -> v1 booked it. Retire.
                //   no evidence,
                //     DRIVE row    -> hand to v2. Safe BECAUSE it books under
                //                     the Drive file id, so if v1 did book it
                //                     after all, QBO's DocNumber/requestid
                //                     idempotency collapses the two into one
                //                     Purchase.
                //   no evidence,
                //     NOT a Drive  -> quarantine. There is no shared identity
                //     row             here: v2 would book under the intake
                //                     UUID, which v1 never saw, so a duplicate
                //                     would go through silently. Booking risks
                //                     double-paying; retiring risks losing a
                //                     real expense. A human checks QBO and uses
                //                     "book anyway".
                // ONE implementation of the three-way split, in the lib, so
                // it is testable without standing up a cron route.
                const { evidenced, unevidenced, quarantined } =
                    triageCutoverRows(candidates, opts.boundary, bookedByV1);

                // EVERY cutover write is a CAS over the row the verdict was
                // reached about — see applyCutoverVerdict. Constraining only
                // `id` let a concurrent transition (an admin review, a late
                // completion) be overwritten with a terminal SHADOW_* state or
                // silently handed to v2, in a transaction that had read the row
                // before any of that happened.
                const byId = new Map<string, CutoverRow>(candidates.map(row => [row.id, row]));
                const rowsFor = (ids: string[]) =>
                    ids.map(id => byId.get(id)).filter((row): row is CutoverRow => !!row);

                if (evidenced.length) {
                    const retired = await applyCutoverVerdict(
                        rowsFor(evidenced),
                        { state: "SHADOW_DONE", stateReason: "booked-by-v1", nextRetryAt: null },
                        tx.receiptIntake,
                    );
                    shadowRetired = retired.moved;
                    shadowSkippedMoved += retired.skippedMoved;
                }

                if (quarantined.length) {
                    const held = await applyCutoverVerdict(
                        rowsFor(quarantined),
                        {
                            state: "SHADOW_QUARANTINE",
                            stateReason: "no-v1-evidence",
                            // Terminal: it must never come back round on a
                            // retry timer. Only a human moves it.
                            nextRetryAt: null,
                            dryRun: false,
                        },
                        tx.receiptIntake,
                    );
                    shadowQuarantined = held.moved;
                    shadowSkippedMoved += held.skippedMoved;
                }

                // Everything else is v2's to book. The list is built row by
                // row above rather than re-derived from a createdAt predicate
                // here, so the two can never disagree about which rows the
                // evidence check already claimed.
                if (unevidenced.length) {
                    const handed = await applyCutoverVerdict(
                        rowsFor(unevidenced),
                        { dryRun: false, nextRetryAt: null },
                        tx.receiptIntake,
                    );
                    requeued = handed.moved;
                    shadowSkippedMoved += handed.skippedMoved;
                }

                if (shadowRetired > 0 || requeued > 0 || shadowQuarantined > 0 || shadowSkippedMoved > 0) {
                    console.log("[cron/receipt-intake-worker] cutover", JSON.stringify({
                        boundary: opts.boundary.toISOString(),
                        shadowRetired, requeued, shadowQuarantined, shadowSkippedMoved,
                    }));
                }
            }
        }

        // ONE predicate, shared with the worker lib and with the real-Postgres
        // claim test, and a FUNCTION of the current global switch — see
        // eligibleClaimWhere. A second copy of it here is how the claim and the
        // processing loop came to disagree about which rows were workable.
        const ELIGIBLE = eligibleClaimWhere(now, opts.dryRunGlobal);

        const due = await tx.receiptIntake.findMany({
            where: ELIGIBLE,
            orderBy: { createdAt: "asc" },
            take: BATCH_SIZE,
            select: { id: true },
        });
        if (due.length === 0) return { rows: [], shadowRetired, requeued, shadowQuarantined, shadowSkippedMoved };

        // THE claim is ATOMIC with the select it followed: the UPDATE re-checks
        // the SAME eligibility predicate rather than blindly writing every id
        // the SELECT returned. Between those two statements — even inside this
        // one transaction, under READ COMMITTED — another writer with no reason
        // to touch the advisory lock (a late `retryRow`, a `deferRead`, an admin
        // action) can still move a row's `nextRetryAt` into the future or its
        // state off the eligible list. Claiming by id alone would stomp that
        // write and hand the row to this pass anyway; re-checking the predicate
        // here means such a row is left untouched instead.
        const ids = due.map(r => r.id);
        const claimToken = randomUUID();
        const claimed = await tx.receiptIntake.updateMany({
            where: { id: { in: ids }, ...ELIGIBLE },
            data: { nextRetryAt: new Date(now.getTime() + LEASE_MS), claimToken, claimedAt: now },
        });
        if (claimed.count === 0) return { rows: [], shadowRetired, requeued, shadowQuarantined, shadowSkippedMoved };

        // Re-read by id AND the fresh token — never by the original id list —
        // so only the rows this UPDATE actually touched are handed to the pass.
        // A row the predicate above skipped keeps its OLD claimToken and is
        // invisible here even though its id is still in `ids`.
        const rows = await tx.receiptIntake.findMany({
            where: { id: { in: ids }, claimToken },
            select: WORKER_ROW_SELECT,
        });
        return {
            rows: rows as WorkerRow[],
            shadowRetired,
            requeued,
            shadowQuarantined,
            shadowSkippedMoved,
        };
    });
}

function buildDeps(invocationDeadline: RouteDeadline): WorkerDependencies {
    return {
        acquireLease: () => acquireCronLease(WORKER_LEASE_KEY, WORKER_LEASE_MS),

        claim,

        isDryRunEnabled: () => process.env.RECEIPT_INTAKE_DRYRUN !== "false",

        cutoverBoundary: resolveCutoverBoundary,

        sweepStaleStaging: async shouldStop => {
            // NEVER a blanket "old therefore missing". A STAGING row that is old
            // because its publish UPDATE failed HAS its object in the bucket,
            // and declaring that receipt file-missing would hand a human a
            // problem that does not exist while the real file sits there. Ask
            // storage about each one, and let a transient storage fault mean
            // "come back next pass" rather than either verdict.
            const sweptAt = new Date();
            const cutoff = new Date(sweptAt.getTime() - STAGING_SWEEP_MINUTES * 60_000);
            const stale = await prisma.receiptIntake.findMany({
                // A LIVE LEASE IS NOT SWEEPABLE, and it must not occupy one of
                // the ten slots either. Selecting it and skipping it inside the
                // loop meant a handful of clients still uploading could fill the
                // whole batch every pass, so the orphans behind them were never
                // reached — the queue looked busy and cleared nothing.
                where: {
                    state: "STAGING",
                    createdAt: { lt: cutoff },
                    OR: [
                        { uploadUrlExpiresAt: null },
                        { uploadUrlExpiresAt: { lte: sweptAt } },
                    ],
                },
                select: {
                    // `state` is read rather than assumed from the WHERE above:
                    // every mutation below fences on the row as OBSERVED, and a
                    // hard-coded "STAGING" in the fence would be a second copy
                    // of that fact that could drift from the query.
                    id: true, state: true, storagePath: true, mimeType: true, stateReason: true,
                    createdAt: true, expectedSha256: true, uploadUrlExpiresAt: true,
                    uploadLeaseVersion: true, uploadLeaseNonce: true,
                },
                // Rows that never had a signed URL first (an inline upload that
                // died mid-request is an orphan NOW, and nothing is coming for
                // it), then oldest-first among the expired leases.
                orderBy: [
                    { uploadUrlExpiresAt: { sort: "asc", nulls: "first" } },
                    { createdAt: "asc" },
                ],
                // Small on purpose: each row costs a storage round trip, and the
                // sweep runs BEFORE any receipt is processed. A big batch here
                // spends the invocation on housekeeping.
                take: STAGING_SWEEP_BATCH,
            });

            let published = 0;
            let parked = 0;
            let rejected = 0;
            let leaseActive = 0;
            for (const row of stale) {
                // The sweep is inside the run's deadline, not outside it.
                if (shouldStop()) break;

                // NOTHING DESTRUCTIVE WHILE THE UPLOAD LEASE IS LIVE.
                //
                // `uploadUrlExpiresAt` is the promise /start made to this
                // client. Until it passes, whatever is (or is not) at the path
                // is provisional: an empty path is an upload in flight, and a
                // half-written or superseded object is one the client is about
                // to replace. Publishing is still allowed — a complete, correct
                // object is a complete, correct object — but parking it as
                // file-missing, or DELETING it as unacceptable, would destroy a
                // receipt whose own upload link is still working.
                // Belt and braces: the query already excluded live leases, but
                // one can be re-armed between that SELECT and this check.
                const leaseLive = uploadLeaseActive(row);

                // THE SAME validator /finalize uses. Publishing on "the object
                // exists" alone would wave through a 40 MB video, an executable,
                // or a truncated upload that /finalize would have refused — and
                // those rows then go to Gemini and, if they read at all, to
                // QuickBooks. One implementation, so the two cannot diverge.
                const check = await inspectStoredObject(row.storagePath, row.mimeType);

                if (check.ok) {
                    // The bytes that landed must be the document /start was told
                    // about. Otherwise the sweep would publish whatever happened
                    // to be at that path — which is the same overwrite the seal
                    // exists to close, arriving by a different door.
                    if (row.expectedSha256 && row.expectedSha256 !== check.fileSha256) {
                        // RECOVERABLE, not a park. A partial or superseded
                        // upload sitting at the path while the signed URL is
                        // still valid is exactly the state a client is about to
                        // fix by finishing its upload. Parking it here would
                        // turn a retry-in-progress into a review item, and the
                        // correct bytes arriving a minute later would find the
                        // row already gone from STAGING.
                        if (leaseLive) { leaseActive++; continue; }
                        // THE COMPLETE LEASE IDENTITY the verdict was reached
                        // about — not state + version.
                        //
                        // `leaseLive` was computed from the SELECT at the top
                        // of this sweep, and everything since (a storage round
                        // trip per row) is time in which a /start retry can
                        // extend the lease over the same path at the same
                        // version, moving only the nonce and the expiry. A
                        // fence of {state, version} still matched, so the sweep
                        // parked a row whose upload URL had just been renewed
                        // and whose client was still uploading to it. The
                        // reject branch below already pinned the whole identity;
                        // this is the same rule, applied to the writes that
                        // forgot it.
                        const { count: mismatchParked } = await prisma.receiptIntake.updateMany({
                            where: { id: row.id, ...leaseFence(row) },
                            data: { state: "NEEDS_REVIEW", stateReason: "sha-mismatch", nextRetryAt: null },
                        });
                        // COUNTED ONLY WHEN THE CAS LANDED. A losing write
                        // reported a park that never happened, so the sweep's
                        // own log said it had cleared rows it had not touched.
                        if (mismatchParked > 0) parked++;
                        else leaseActive++;
                        continue;
                    }

                    // The SAME seal-and-publish /finalize uses. The sweep must
                    // never publish a row still pointing at the UPLOAD path:
                    // that path stays writable by whoever holds the signed URL,
                    // so a swept row's "verified" bytes would remain replaceable
                    // afterwards.
                    const outcome = await sealAndPublish(row.storagePath, row.id, row.uploadLeaseVersion, check, {
                        withObjectLock: withReceiptPublishLock,
                        seal: sealObject,
                        commit: async (tx, canonicalPath, values) => {
                            const { count } = await tx.receiptIntake.updateMany({
                                // Same complete identity as the parks. This one
                                // publishes rather than parks, but a lease
                                // refreshed since the inspection means the
                                // client is mid-upload of something else — and
                                // publishing that row would seal bytes it is
                                // about to replace, then schedule the upload
                                // path's cleanup against an expiry the live URL
                                // outlives. The schedule below reads the SAME
                                // snapshot this CAS pins, so the two agree by
                                // construction.
                                where: { id: row.id, ...leaseFence(row) },
                                data: {
                                    state: "RECEIVED",
                                    nextRetryAt: null,
                                    storagePath: canonicalPath,
                                    mimeType: values.mimeType,
                                    fileSize: values.fileSize,
                                    fileSha256: values.fileSha256,
                                },
                            });
                            return count;
                        },
                        // PUBLISHING is allowed while the lease is live (a
                        // complete, correct object is one whether or not the
                        // URL has expired), so unlike the park and reject
                        // branches below this one CAN run with a live upload
                        // URL — and the upload path's delete has to wait for
                        // it, or the holder's late PUT recreates an object the
                        // published row no longer points at.
                        //
                        // Enqueued INSIDE the commit transaction, same rule as
                        // /finalize: the queue entry outlives the pointer, so
                        // the two have to commit together.
                        queueUploadCleanup: (tx, uploadPath) =>
                            queueObjectCleanup(tx, uploadPath, "sealed", cleanupNotBefore(row)),
                        settleUploadCleanup: (eventId, uploadPath) =>
                            settleQueuedCleanup(eventId, uploadPath, cleanupNotBefore(row))
                                .then(() => undefined),
                        currentStoragePath: async (tx, rowId) => {
                            const r = await tx.receiptIntake.findUnique({
                                where: { id: rowId },
                                select: { storagePath: true },
                            });
                            return r?.storagePath ?? null;
                        },
                        // A lost CAS here means /finalize (or a resumed
                        // /start's re-armed lease) already moved this row
                        // while the sweep was mid-inspection — best-effort,
                        // same retry queue as every other orphan.
                        dropOrphanedCanonical: canonicalPath =>
                            deleteObjectOrRecord(canonicalPath, "orphaned-lost-publish-cas").then(() => undefined),
                    });
                    if (outcome?.published) published++;
                    continue;
                }
                if (check.kind === "transient") continue; // unknown is not a verdict
                if (check.kind === "missing") {
                    // The signed upload URL is good for two hours. Parking at 15
                    // minutes declared a receipt missing while its own upload
                    // link was still perfectly usable — a slow phone on a bad
                    // connection came back to find its row already in the review
                    // queue. Wait until the URL cannot possibly land any more.
                    if (leaseLive) { leaseActive++; continue; }
                    // The complete identity again: `leaseLive` is a fact about
                    // the SELECT, and a /start retry between it and here
                    // renews the very URL this park says can no longer land.
                    const { count: missingParked } = await prisma.receiptIntake.updateMany({
                        where: { id: row.id, ...leaseFence(row) },
                        data: { state: "NEEDS_REVIEW", stateReason: "file-missing", nextRetryAt: null },
                    });
                    if (missingParked > 0) parked++;
                    else leaseActive++;
                    continue;
                }
                // Rejected: the object exists and is not acceptable.
                //
                // Not while the lease is live: what is at the path may be a
                // partial write the client is still finishing, and deleting the
                // row destroys the only record of an inbound receipt.
                if (leaseLive) { leaseActive++; continue; }

                // The SAME fenced transaction /finalize rejects with: the row
                // and its cleanup record commit together, under the exact state
                // and path we just inspected. The unfenced delete this replaces
                // could destroy a row a concurrent /finalize had just published
                // — and then delete the bytes that published row pointed at.
                const dropped = await rejectRowAndQueueCleanup(
                    {
                        id: row.id,
                        // The OBSERVED state, like every other field here — a
                        // literal would be a second copy of the SELECT's own
                        // predicate, free to drift from it.
                        state: row.state,
                        stateReason: row.stateReason,
                        storagePath: row.storagePath,
                        uploadLeaseVersion: row.uploadLeaseVersion,
                        // The generation too: the version alone cannot see a
                        // same-path lease refresh (see leaseFence). The
                        // `verify` callback below still re-reads the row, and
                        // the two are complementary — this one fails the CAS,
                        // that one aborts the transaction.
                        uploadLeaseNonce: row.uploadLeaseNonce,
                        uploadUrlExpiresAt: row.uploadUrlExpiresAt,
                        // Always null here — `leaseLive` above already refused
                        // to reject a row whose URL still works. Passed anyway
                        // so both rejecters state the rule the same way rather
                        // than one of them relying on a guard several lines up.
                        cleanupNotBefore: cleanupNotBefore(row),
                    },
                    check.reason,
                    undefined,
                    // DECIDED ON A ROW RE-READ INSIDE THE TRANSACTION.
                    //
                    // Between the inspection above and this delete a client can
                    // resume its upload: /start bumps the lease and hands out a
                    // fresh URL. The fence catches the version, and this catches
                    // the case the fence cannot see — a lease that is live again
                    // — so a receipt in flight is never deleted for what its
                    // previous attempt left at the path.
                    fresh => uploadLeaseActive(fresh as { uploadUrlExpiresAt: Date | null; createdAt: Date })
                        ? "upload-lease-active"
                        : null,
                );
                // FENCE LOST: somebody else owns this row now. Touch NOTHING —
                // above all not the object, which the winner may be using.
                if (!dropped.ok) continue;
                await settleQueuedCleanup(dropped.eventId, row.storagePath, cleanupNotBefore(row));
                rejected++;
            }
            if (published || parked || rejected || leaseActive) {
                console.log("[cron/receipt-intake-worker] STAGING sweep", JSON.stringify({
                    published, parked, rejected, "upload-lease-active": leaseActive,
                }));
            }
            return published + parked + rejected;
        },

        // ONLY this project's phases — no company-wide fallback, and an empty
        // list is a real answer.
        //
        // Returning every active cost code meant the model was offered phases
        // the job does not have, so it confidently suggested one, and booking
        // then had to throw that suggestion away (isCostCodeAllowedForProject).
        // The visible symptom was receipts arriving uncoded for no stated
        // reason; the real cost is that a plausible-but-wrong phase is exactly
        // the kind of thing a reviewer accepts without checking.
        //
        // A row with no project has no phases at all. Suggesting one from the
        // whole company would be a guess with nothing behind it.
        loadPhases: async projectId => {
            if (!projectId) return [];
            const phases = await resolveProjectPhaseCodes(prismaPhaseDataSource, projectId);
            return phases.map(phase => ({ id: phase.id, code: phase.code, name: phase.name }));
        },

        downloadBytes: (storagePath, expectedSha256) => downloadVerified(storagePath, expectedSha256),

        // The invocation's ONE deadline, not a fresh 25s per row (see
        // readBudgetFor). A row reached late in the batch gets whatever
        // runway is actually left instead of a full budget stacked on top
        // of what the run has already spent — the same deadline that
        // already governs every QuickBooks call below.
        read: (bytes, mime, phases) => {
            const budgetMs = readBudgetFor(remainingBudgetMs(invocationDeadline));
            if (budgetMs <= 0) {
                // Same answer readReceipt gives for an exhausted budget: the
                // document was never read, so this costs no `attempts` — the
                // row comes back next pass with a full budget again.
                return Promise.resolve({ ok: false, decisive: false });
            }
            return readReceipt(bytes, mime, phases, { budgetMs });
        },

        applyRead: async (rowId, patch: ReadPatch, ownership) => {
            try {
                // CAS on {id, state, claimToken}. nextRetryAt is deliberately
                // UNTOUCHED: the claim lease must survive until routing
                // finishes. Clearing it here let an overlapping invocation
                // reclaim a half-routed row and book it while this one was
                // still deciding — and then this one would regress it.
                // finishRouting()/applyState() release the lease.
                const { count } = await prisma.receiptIntake.updateMany({
                    where: { id: rowId, state: ownership.state, claimToken: ownership.claimToken },
                    data: { ...patch, lastError: null },
                });
                return { strongOwner: null, owned: count > 0 };
            } catch (error) {
                // The partial unique index refused the claim — the DATABASE is
                // the lock the Apps Script did with Script Properties. Load the
                // owner so the caller can compare totals.
                // Which constraint fired is resolved by looking the owner up
                // BY dedupStrongKey — a fact about the data — rather than by
                // string-matching Prisma's `meta`, whose shape is version
                // dependent and is empty for a partial index on some engine
                // builds (i.e. exactly this index).
                if (!isUniqueViolation(error) || !patch.dedupStrongKey) throw error;
                const owner = await prisma.receiptIntake.findFirst({
                    where: {
                        dedupStrongKey: patch.dedupStrongKey,
                        state: { notIn: ["DUPLICATE", "VOID"] },
                        id: { not: rowId },
                    },
                    select: { id: true, totalCents: true, vendor: true },
                });
                // No owner means some OTHER unique constraint rejected the
                // write; re-throw rather than reporting a dedup hit that isn't.
                if (!owner) throw error;
                return {
                    owned: true,
                    strongOwner: {
                        id: owner.id,
                        totalCents: owner.totalCents,
                        canonicalVendor: owner.vendor ? canonicalVendor(owner.vendor) : null,
                    },
                };
            }
        },

        findWeakHit: async (rowId, weakKey) => prisma.receiptIntake.findFirst({
            where: {
                dedupWeakKey: weakKey,
                id: { not: rowId },
                state: { notIn: ["DUPLICATE", "VOID", "NON_RECEIPT"] },
            },
            select: { id: true },
            orderBy: { createdAt: "asc" },
        }),

        applyState: async (rowId, state, stateReason, patch, ownership) => {
            const { count } = await prisma.receiptIntake.updateMany({
                where: { id: rowId, state: ownership.state, claimToken: ownership.claimToken },
                data: { ...(patch ?? {}), state, stateReason, nextRetryAt: null, ...RELEASE_CLAIM },
            });
            return count > 0;
        },

        // RECEIVED -> READ, and the ONLY place the routing lease is released.
        finishRouting: async (rowId, claimToken, stateReason) => {
            // FENCED on state AND token, and it clears both claim fields.
            //
            // The state alone is not enough: a worker whose invocation was
            // killed mid-routing can resume after its row has been re-claimed
            // and re-read, find it back in RECEIVED, and publish READ over the
            // successor's work — including over a NEEDS_REVIEW the successor
            // had every reason to set. Matching the token makes that write
            // affect zero rows instead.
            const { count } = await prisma.receiptIntake.updateMany({
                where: { id: rowId, state: "RECEIVED", claimToken },
                data: {
                    state: "READ",
                    stateReason,
                    nextRetryAt: null,
                    claimToken: null,
                    claimedAt: null,
                },
            });
            if (count === 0) {
                console.warn("[cron/receipt-intake-worker] finishRouting fenced out", rowId);
            }
        },

        companyTimeZone: resolveCompanyTimeZone,

        retryStorageCleanups: shouldStop => retryPendingCleanups(STAGING_SWEEP_BATCH, shouldStop),

        promoteToBooking: async (rowId, weakKey, claimToken) => prisma.$transaction(async tx => {
            // LAST weak-dedup check, taken INSIDE the transition. The check at
            // read time can miss a pair that arrived in the same batch window,
            // and READ -> BOOKING is the last instant before money moves.
            //
            // WHY A SECOND LOCK, keyed on the weak key rather than just relying
            // on the global claim lock: that lock is transaction-scoped and is
            // released the moment the CLAIM transaction commits, which is
            // before any row is processed. Holding it across the whole pass
            // instead would mean one long-lived transaction wrapping every
            // Gemini and QuickBooks call — minutes of open transaction on a
            // pgbouncer pool, which is exactly what the pooler cannot afford.
            //
            // So the serialization is narrowed to what actually needs it. Two
            // rows sharing a weak key take the SAME lock here and go one at a
            // time; the loser's SELECT then sees the winner already in BOOKING.
            // Without it both SELECTs can run before either UPDATE commits
            // (classic write skew, and READ COMMITTED will not catch it because
            // neither row writes what the other read) and both documents book.
            // Rows with different weak keys take different locks and never
            // block each other.
            if (weakKey) {
                // $executeRaw, NOT $queryRaw. pg_advisory_xact_lock returns
                // VOID: `SELECT` of it produces a row whose single column has no
                // readable type, and Prisma's query path can reject that outright
                // — which would throw INSIDE the promotion transaction and, on
                // the retry path, look like a transient DB fault forever while
                // the lock was never actually taken. $executeRaw runs the
                // statement for its effect and asks nothing of the result.
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${weakKey}, 0))`;
                // EVERY LIVE STATE, not just the post-booking ones.
                //
                // Limiting this to BOOKING/BOOKED/ARCHIVED meant a twin sitting
                // in NEEDS_REVIEW — which is exactly where the weak net puts
                // the FIRST of a suspected pair — was invisible here, so the
                // second copy sailed past the human decision that was still
                // pending on the first and booked itself. A twin awaiting
                // review is the strongest possible signal to stop, not the
                // weakest.
                //
                // DUPLICATE / VOID / NON_RECEIPT are excluded because those are
                // settled: somebody already decided they are not a purchase.
                const conflict = await tx.receiptIntake.findFirst({
                    where: {
                        dedupWeakKey: weakKey,
                        id: { not: rowId },
                        state: { notIn: ["DUPLICATE", "VOID", "NON_RECEIPT"] },
                    },
                    select: { id: true },
                    orderBy: { createdAt: "asc" },
                });
                if (conflict) {
                    await tx.receiptIntake.updateMany({
                        where: { id: rowId, state: "READ", claimToken },
                        data: {
                            state: "NEEDS_REVIEW",
                            stateReason: `weak-dup:${conflict.id}`,
                            // Parked without ever reaching QuickBooks, so the
                            // strong key goes back (same rule as book.ts).
                            dedupStrongKey: null,
                            nextRetryAt: null,
                            ...RELEASE_CLAIM,
                        },
                    });
                    return { promoted: false, conflictId: conflict.id };
                }
            }
            // CAS: only the current claim holder promotes. A superseded worker
            // must not move a row into BOOKING that its successor is handling.
            //
            // THE ONE TRANSITION THAT KEEPS THE CLAIM, deliberately: promotion
            // hands the row straight to bookReceipt in this same pass, and both
            // its send mark and its BOOKED commit CAS on this token. Releasing
            // here would admit a second worker to the same booking.
            //
            // stateReason is left UNTOUCHED, not cleared: finishRouting is the
            // ONLY path to READ (see worker.ts), and it never writes anything
            // to this column besides null or "tax-implausible" — so whatever a
            // READ row is carrying here is exactly that warning, and it must
            // survive into BOOKING/BOOKED or an automatically booked receipt
            // with a bad tax read becomes indistinguishable from one with no
            // tax read at all.
            const { count } = await tx.receiptIntake.updateMany({
                where: { id: rowId, state: "READ", claimToken },
                data: { state: "BOOKING" },
            });
            if (count === 0) return { promoted: false, stale: true };
            return { promoted: true };
        }),

        book: row => bookReceipt(row, {
            db: prisma as unknown as BookPrismaClient,
            companyTimeZone: resolveCompanyTimeZone,
            markSendAttempted: async (rowId, claimToken) => {
                // CAS: only the CURRENT claim holder may mark a send. A zero
                // count means this worker was superseded, and bookReceipt
                // aborts on it before touching QuickBooks.
                const { count } = await prisma.receiptIntake.updateMany({
                    where: { id: rowId, state: "BOOKING", claimToken },
                    data: { sendAttempted: true },
                });
                return count > 0;
            },
            isCostCodeAllowed: (projectId, costCodeId) =>
                isCostCodeAllowedForProject(prismaPhaseDataSource, projectId, costCodeId),
            // The invocation's ONE absolute deadline, created at entry and
            // shared by every check and every QuickBooks call. Never a
            // remaining-milliseconds snapshot: that is measured once and then
            // decays silently while the work runs.
            deadline: invocationDeadline,
            isPushEnabled: () => process.env.QBO_RECEIPT_PUSH_ENABLED === "true",
            isPushPaused: () => isPaused(PAUSE_KEYS.receiptPush),
            // Same env read as the worker's own isDryRunEnabled — read fresh
            // here too, since book() is the last stop before a real QBO write.
            isDryRunEnabled: () => process.env.RECEIPT_INTAKE_DRYRUN !== "false",
            getTokens: deadline => getFreshQBTokens(deadline),
            createPurchase: (tokens, input, deadline, onBeforeCreate, onExistingPurchase) =>
                createQBReceiptPurchase(tokens, input, { onBeforeCreate, onExistingPurchase }, deadline),
            downloadBytes: (storagePath, expectedSha256) => downloadVerified(storagePath, expectedSha256),
            logEvent: logAutomationEvent,
            now: () => new Date(),
        }),

        applyBookResult: async (rowId, result, claimToken) => {
            const now = new Date();
            if (result.outcome === "booked") return; // bookReceipt already committed it
            // A superseded worker writes NOTHING: the row belongs to whoever
            // holds the current token, and its state is theirs to set.
            if (result.outcome === "stale") return;
            // Every write below is a CAS on the claim AND on the state.
            //
            // The token alone is not enough here: bookReceipt own commit may
            // already have moved the row to BOOKED under this same token, and a
            // late deferred/retry result would then overwrite a booked row with
            // "come back in an hour". Pinning BOOKING means only a row still
            // waiting to book can be written by a booking result.
            const owns = { id: rowId, state: "BOOKING", claimToken } as const;
            if (result.outcome === "needs-review") {
                await prisma.receiptIntake.updateMany({
                    where: owns,
                    data: {
                        state: "NEEDS_REVIEW",
                        stateReason: result.reason,
                        nextRetryAt: null,
                        ...RELEASE_CLAIM,
                        // Parked before any QBO send: hand the strong key back,
                        // or a corrected re-send of the same receipt would be
                        // quarantined against a row that never became a purchase.
                        ...(result.releaseStrongKey ? { dedupStrongKey: null } : {}),
                    },
                });
                return;
            }
            if (result.outcome === "deferred") {
                // A switch is off: hold in BOOKING, look again in an hour, and
                // do NOT spend an attempt — this document did nothing wrong.
                await prisma.receiptIntake.updateMany({
                    where: owns,
                    data: {
                        state: "BOOKING",
                        stateReason: result.reason,
                        nextRetryAt: new Date(now.getTime() + 60 * 60_000),
                        ...RELEASE_CLAIM,
                    },
                });
                return;
            }
            await prisma.receiptIntake.updateMany({
                where: owns,
                data: {
                    state: "BOOKING",
                    attempts: result.attempts,
                    lastError: result.reason.slice(0, 400),
                    nextRetryAt: result.nextRetryAt,
                    ...RELEASE_CLAIM,
                },
            });
        },

        deferRead: async (rowId, busyPasses, reason, ownership) => {
            // The service was unavailable; the document was never read, so this
            // costs no `attempts` — only a delay and one busy pass. Reuses the
            // booking backoff table so one outage does not hammer Gemini from
            // every row at once.
            const { count } = await prisma.receiptIntake.updateMany({
                where: { id: rowId, state: ownership.state, claimToken: ownership.claimToken },
                data: {
                    busyPasses,
                    lastError: reason,
                    nextRetryAt: new Date(Date.now() + backoffMs(1)),
                    ...RELEASE_CLAIM,
                },
            });
            return count > 0;
        },

        // Hand the row back untouched except for when to look at it again. No
        // state change, no attempt spent, no lastError: the dry-run switch is
        // not a verdict on the document. Fenced like every other write, so a
        // superseded pass releases nothing.
        releaseClaim: async (rowId, nextRetryAt, ownership) => {
            const { count } = await prisma.receiptIntake.updateMany({
                where: { id: rowId, state: ownership.state, claimToken: ownership.claimToken },
                data: { nextRetryAt, ...RELEASE_CLAIM },
            });
            return count > 0;
        },

        // Every row the soft deadline cut off, in one token-fenced write per
        // claim token. `nextRetryAt: null` puts them back at the front of the
        // queue: they were never worked on, so there is nothing to back off
        // from, and the ten-minute claim lease they are carrying was written
        // for a pass that has ended.
        releaseUnprocessed: async rows => {
            const byToken = new Map<string, string[]>();
            for (const row of rows) {
                // A row with no token was never really claimed; there is
                // nothing to fence a release on and nothing to release.
                if (!row.claimToken) continue;
                const ids = byToken.get(row.claimToken);
                if (ids) ids.push(row.id);
                else byToken.set(row.claimToken, [row.id]);
            }
            let released = 0;
            for (const [claimToken, ids] of byToken) {
                const { count } = await prisma.receiptIntake.updateMany({
                    // FENCED ON THE TOKEN THIS PASS CLAIMED WITH. A row whose
                    // token changed belongs to a successor, and clearing its
                    // claim here would hand a live pass's row to a third one.
                    where: { id: { in: ids }, claimToken },
                    data: { nextRetryAt: null, ...RELEASE_CLAIM },
                });
                released += count;
            }
            return released;
        },

        retryRow: async (rowId, attempts, nextRetryAt, reason, ownership) => {
            const { count } = await prisma.receiptIntake.updateMany({
                where: { id: rowId, state: ownership.state, claimToken: ownership.claimToken },
                data: { attempts, lastError: reason, nextRetryAt, ...RELEASE_CLAIM },
            });
            return count > 0;
        },

        // Re-read taken RIGHT BEFORE routing, after the download and the model
        // call. A late job assignment landing in that window must not be routed
        // over: NEEDS_JOB for a receipt that HAS a job sends a human looking for
        // a problem that no longer exists.
        sendAttemptedNow: async rowId => {
            const row = await prisma.receiptIntake.findUnique({
                where: { id: rowId },
                select: { sendAttempted: true },
            });
            // A row that vanished, or a read that returned nothing, is answered
            // "a send may have happened": retaining the key costs a review, and
            // releasing it wrongly costs a second Purchase.
            return row?.sendAttempted ?? true;
        },

        refreshProjectId: async rowId => {
            const row = await prisma.receiptIntake.findUnique({
                where: { id: rowId },
                select: { projectId: true },
            });
            return row?.projectId ?? null;
        },

        now: () => new Date(),
        monotonicMs: () => Date.now(),
    };
}

export async function GET(request: Request) {
    // isCronAuthorized: constant-time compare, and it fails CLOSED.
    //
    // The hand-rolled version this replaces had both problems the shared helper
    // exists to fix. `authHeader === \`Bearer ${secret}\`` is a byte-at-a-time
    // string compare that leaks the secret to anyone who can time the response.
    // Worse, the `isLocalDev` escape hatch — no VERCEL, NODE_ENV not
    // "production", and no CRON_SECRET — is satisfied by an unset environment,
    // so any container, self-hosted build, or preview whose env drifted served
    // this endpoint to anyone who asked. On a route that books real money into
    // QuickBooks.
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const summary = await runIntakeWorker(buildDeps(createRouteDeadline(RUN_HARD_BUDGET_MS)));
    if (summary.processed > 0 || summary.skipped) {
        console.log("[cron/receipt-intake-worker]", JSON.stringify(summary));
    }
    return NextResponse.json(summary);
}
