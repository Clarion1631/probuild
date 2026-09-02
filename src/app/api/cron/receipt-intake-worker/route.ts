import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";
import { logAutomationEvent } from "@/lib/automation-events";
import { downloadDocBytesResult, toSecureRef } from "@/lib/secure-storage";
import { downloadVerified, inspectStoredObject } from "@/lib/receipt-intake/stored-object";
import { deleteObjectOrRecord, retryPendingCleanups } from "@/lib/receipt-intake/storage-cleanup";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { createQBReceiptPurchase } from "@/lib/qbo-receipt-push";
import { createRouteDeadline, type RouteDeadline } from "@/lib/quickbooks";
import { readReceipt } from "@/lib/receipt-intake/read";
import { canonicalVendor } from "@/lib/receipt-intake/keys";
import { resolveCutoverBoundary } from "@/lib/receipt-intake/cutover";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { isCostCodeAllowedForProject, resolveProjectPhaseCodes } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { bookReceipt, type BookPrismaClient } from "@/lib/receipt-intake/book";
import { backoffMs } from "@/lib/receipt-intake/route-state";
import {
    BATCH_SIZE,
    CLAIM_LEASE_MINUTES,
    CLAIM_LOCK_KEY,
    RUN_HARD_BUDGET_MS,
    SIGNED_UPLOAD_TTL_MS,
    STAGING_SWEEP_BATCH,
    STAGING_SWEEP_MINUTES,
    type ClaimResult,
    type CutoverRequest,
    isUniqueViolation,
    runIntakeWorker,
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
 * OVERLAP SAFETY. pgbouncer forbids SESSION advisory locks (a pooled
 * connection is not the same connection twice — see review-alert-rollout.ts:8),
 * so the claim runs `pg_try_advisory_xact_lock` inside ONE SHORT transaction
 * and the work happens outside it. Two defences behind that, because a lock is
 * not a correctness argument on its own:
 *   - the claim bumps every taken row's `nextRetryAt`, so even interleaved runs
 *     never hand the same row to two workers, and
 *   - QBO's DocNumber/requestid idempotency means a double booking creates one
 *     Purchase, not two.
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
    createdAt: true, dedupWeakKey: true, busyPasses: true,
} as const;

/**
 * A row parked by the shadow week (dryRun=true, sitting at READ or BOOKING) is
 * DONE until the cutover. It is excluded from the claim rather than merely
 * skipped inside the loop, because the batch is only ten rows: after a couple
 * of shadow days the oldest ten rows are all parked ones, they get re-claimed
 * every five minutes, and no NEW receipt is ever reached. The queue looks
 * healthy and processes nothing. runIntakeWorker's requeueDryRunParked is what
 * brings them back, once, on the first live pass.
 */
const NOT_DRY_RUN_PARKED: Prisma.ReceiptIntakeWhereInput = {
    NOT: { AND: [{ dryRun: true }, { state: { in: ["READ", "BOOKING"] } }] },
};

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
        if (opts.run) {
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
                const candidates = await tx.receiptIntake.findMany({
                    where: { ...parked, createdAt: { lt: opts.boundary } },
                    select: { id: true, source: true, sourceRef: true, archivedByV1: true },
                });

                const driveIds = candidates
                    .map(r => (r.source === "drive" && r.sourceRef.startsWith("drive:")
                        ? r.sourceRef.slice("drive:".length)
                        : null))
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
                const evidenced: string[] = [];
                const unevidenced: string[] = [];
                const quarantined: string[] = [];
                for (const row of candidates) {
                    const driveId = row.source === "drive" && row.sourceRef.startsWith("drive:")
                        ? row.sourceRef.slice("drive:".length)
                        : null;
                    if (row.archivedByV1 || (driveId && bookedByV1.has(driveId))) evidenced.push(row.id);
                    else if (driveId) unevidenced.push(row.id);
                    else quarantined.push(row.id);
                }

                if (evidenced.length) {
                    const retired = await tx.receiptIntake.updateMany({
                        where: { id: { in: evidenced } },
                        data: { state: "SHADOW_DONE", stateReason: "booked-by-v1", nextRetryAt: null },
                    });
                    shadowRetired = retired.count;
                }

                if (quarantined.length) {
                    const held = await tx.receiptIntake.updateMany({
                        where: { id: { in: quarantined } },
                        data: {
                            state: "SHADOW_QUARANTINE",
                            stateReason: "no-v1-evidence",
                            // Terminal: it must never come back round on a
                            // retry timer. Only a human moves it.
                            nextRetryAt: null,
                            dryRun: false,
                        },
                    });
                    shadowQuarantined = held.count;
                }

                // Everything else — after the boundary, or before it with no
                // evidence — is v2's to book.
                const handed = await tx.receiptIntake.updateMany({
                    where: {
                        OR: [
                            { ...parked, createdAt: { gte: opts.boundary } },
                            ...(unevidenced.length ? [{ id: { in: unevidenced } }] : []),
                        ],
                    },
                    data: { dryRun: false, nextRetryAt: null },
                });
                requeued = handed.count;

                if (shadowRetired > 0 || requeued > 0 || shadowQuarantined > 0) {
                    console.log("[cron/receipt-intake-worker] cutover", JSON.stringify({
                        boundary: opts.boundary.toISOString(),
                        shadowRetired, requeued, shadowQuarantined,
                    }));
                }
            }
        }

        const due = await tx.receiptIntake.findMany({
            where: {
                // STAGING is absent on purpose: the row exists but its object
                // does not, so claiming it would park a good receipt as
                // "file-missing". sweepStaleStaging is what watches those.
                state: { in: ["RECEIVED", "READ", "BOOKING"] },
                OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
                ...NOT_DRY_RUN_PARKED,
            },
            orderBy: { createdAt: "asc" },
            take: BATCH_SIZE,
            select: WORKER_ROW_SELECT,
        });
        if (due.length === 0) return { rows: [], shadowRetired, requeued, shadowQuarantined };

        // THE claim. Anything this run took is invisible to the next one for
        // the lease, whether or not the advisory lock held — AND it is stamped
        // with a fresh token, so a completing write can prove it still owns the
        // row rather than merely having owned it once.
        const claimToken = randomUUID();
        await tx.receiptIntake.updateMany({
            where: { id: { in: due.map(r => r.id) } },
            data: { nextRetryAt: new Date(now.getTime() + LEASE_MS), claimToken, claimedAt: now },
        });
        // The rows were SELECTed before the stamp, so hand back the token this
        // pass just wrote rather than whatever they were carrying before.
        return {
            rows: due.map(row => ({ ...row, claimToken })) as WorkerRow[],
            shadowRetired,
            requeued,
            shadowQuarantined,
        };
    });
}

function buildDeps(invocationDeadline: RouteDeadline): WorkerDependencies {
    return {
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
            const cutoff = new Date(Date.now() - STAGING_SWEEP_MINUTES * 60_000);
            const stale = await prisma.receiptIntake.findMany({
                where: { state: "STAGING", createdAt: { lt: cutoff } },
                select: {
                    id: true, storagePath: true, mimeType: true,
                    createdAt: true, expectedSha256: true,
                },
                // Small on purpose: each row costs a storage round trip, and the
                // sweep runs BEFORE any receipt is processed. A big batch here
                // spends the invocation on housekeeping.
                take: STAGING_SWEEP_BATCH,
            });

            let published = 0;
            let parked = 0;
            let rejected = 0;
            for (const row of stale) {
                // The sweep is inside the run's deadline, not outside it.
                if (shouldStop()) break;

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
                        await prisma.receiptIntake.updateMany({
                            where: { id: row.id, state: "STAGING" },
                            data: { state: "NEEDS_REVIEW", stateReason: "sha-mismatch", nextRetryAt: null },
                        });
                        parked++;
                        continue;
                    }
                    await prisma.receiptIntake.updateMany({
                        where: { id: row.id, state: "STAGING" },
                        data: {
                            state: "RECEIVED",
                            nextRetryAt: null,
                            mimeType: check.mimeType,
                            fileSize: check.fileSize,
                            fileSha256: check.fileSha256,
                        },
                    });
                    published++;
                    continue;
                }
                if (check.kind === "transient") continue; // unknown is not a verdict
                if (check.kind === "missing") {
                    // The signed upload URL is good for two hours. Parking at 15
                    // minutes declared a receipt missing while its own upload
                    // link was still perfectly usable — a slow phone on a bad
                    // connection came back to find its row already in the review
                    // queue. Wait until the URL cannot possibly land any more.
                    if (row.createdAt.getTime() > Date.now() - SIGNED_UPLOAD_TTL_MS) continue;
                    await prisma.receiptIntake.updateMany({
                        where: { id: row.id, state: "STAGING" },
                        data: { state: "NEEDS_REVIEW", stateReason: "file-missing", nextRetryAt: null },
                    });
                    parked++;
                    continue;
                }
                // Rejected: the object exists and is not acceptable. Same
                // outcome as /finalize — the row goes and so does the object.
                await prisma.receiptIntake.deleteMany({ where: { id: row.id, state: "STAGING" } });
                await deleteObjectOrRecord(row.storagePath, check.reason);
                rejected++;
            }
            if (published || parked || rejected) {
                console.log("[cron/receipt-intake-worker] STAGING sweep", JSON.stringify({ published, parked, rejected }));
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

        read: (bytes, mime, phases) => readReceipt(bytes, mime, phases),

        applyRead: async (rowId, patch: ReadPatch) => {
            try {
                // nextRetryAt is deliberately UNTOUCHED: the claim lease must
                // survive until routing finishes. Clearing it here let an
                // overlapping invocation reclaim a half-routed row and book it
                // while this one was still deciding — and then this one would
                // regress it. finishRouting()/applyState() release the lease.
                await prisma.receiptIntake.update({
                    where: { id: rowId },
                    data: { ...patch, lastError: null },
                });
                return { strongOwner: null };
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

        applyState: async (rowId, state, stateReason, patch) => {
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: { ...(patch ?? {}), state, stateReason, nextRetryAt: null },
            });
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

        promoteToBooking: async (rowId, weakKey) => prisma.$transaction(async tx => {
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
                    await tx.receiptIntake.update({
                        where: { id: rowId },
                        data: {
                            state: "NEEDS_REVIEW",
                            stateReason: `weak-dup:${conflict.id}`,
                            // Parked without ever reaching QuickBooks, so the
                            // strong key goes back (same rule as book.ts).
                            dedupStrongKey: null,
                            nextRetryAt: null,
                        },
                    });
                    return { promoted: false, conflictId: conflict.id };
                }
            }
            await tx.receiptIntake.update({
                where: { id: rowId },
                data: { state: "BOOKING", stateReason: null },
            });
            return { promoted: true };
        }),

        book: row => bookReceipt(row, {
            db: prisma as unknown as BookPrismaClient,
            companyTimeZone: resolveCompanyTimeZone,
            markSendAttempted: async rowId => {
                await prisma.receiptIntake.update({ where: { id: rowId }, data: { sendAttempted: true } });
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
            getTokens: deadline => getFreshQBTokens(deadline),
            createPurchase: (tokens, input, deadline) =>
                createQBReceiptPurchase(tokens, input, {}, deadline),
            downloadBytes: (storagePath, expectedSha256) => downloadVerified(storagePath, expectedSha256),
            logEvent: logAutomationEvent,
            now: () => new Date(),
        }),

        applyBookResult: async (rowId, result) => {
            const now = new Date();
            if (result.outcome === "booked") return; // bookReceipt already committed it
            if (result.outcome === "needs-review") {
                await prisma.receiptIntake.update({
                    where: { id: rowId },
                    data: {
                        state: "NEEDS_REVIEW",
                        stateReason: result.reason,
                        nextRetryAt: null,
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
                await prisma.receiptIntake.update({
                    where: { id: rowId },
                    data: {
                        state: "BOOKING",
                        stateReason: result.reason,
                        nextRetryAt: new Date(now.getTime() + 60 * 60_000),
                    },
                });
                return;
            }
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: {
                    state: "BOOKING",
                    attempts: result.attempts,
                    lastError: result.reason.slice(0, 400),
                    nextRetryAt: result.nextRetryAt,
                },
            });
        },

        deferRead: async (rowId, busyPasses, reason) => {
            // The service was unavailable; the document was never read, so this
            // costs no `attempts` — only a delay and one busy pass. Reuses the
            // booking backoff table so one outage does not hammer Gemini from
            // every row at once.
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: {
                    busyPasses,
                    lastError: reason,
                    nextRetryAt: new Date(Date.now() + backoffMs(1)),
                },
            });
        },

        retryRow: async (rowId, attempts, nextRetryAt, reason) => {
            await prisma.receiptIntake.update({
                where: { id: rowId },
                data: { attempts, lastError: reason, nextRetryAt },
            });
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
