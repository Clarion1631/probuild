import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { decodeReasonCodes, type ReasonCode } from "./review-alert-reasons";
import { readRolloutGateState, type RolloutGateClient } from "./review-alert-rollout";

/**
 * Review-alert delivery outbox (Unified Money Register plan §4 "Delivery" /
 * punch 3). Mirrors `src/lib/payment-outbox.ts`'s drainer FAITHFULLY — an
 * earlier prose version of this plan wrote failures as FAILED + nextAttemptAt
 * but only ever claimed PENDING rows, which stranded every failure
 * permanently. That drainer is the reference implementation; this one
 * generalizes its exact claim/fence/retry mechanics over TWO tables
 * (ReviewAlertEpisode, ReviewAlertBatch — the rate-ceiling overflow summary
 * uses "the SAME claim/fence/retry path" per the plan) via one shared core.
 *
 * One deliberate divergence from payment-outbox.ts, called out because the
 * instructions ask for a faithful mirror: PaymentNotification has a single
 * `processingStartedAt` column that does double duty as both "when this claim
 * was taken" (stale-PROCESSING reclaim) and, implicitly, "when the last
 * attempt happened" (retry backoff, by re-checking the same stale field on a
 * PENDING row). ReviewAlertEpisode/Batch have two SEPARATE columns per the
 * plan's schema (`claimedAt`, `nextAttemptAt`) — so here each field is used
 * for exactly the purpose its name says: `claimedAt` gates stale-claim
 * reclaim, `nextAttemptAt` gates retry backoff, set explicitly on a retry
 * write rather than reused from claim time.
 *
 * Required properties (plan §4 punch 3), all present below:
 *  - background (no scope) AND scoped (one issue's inline fast-path) candidate modes
 *  - due-retry AND stale-claim candidate predicates
 *  - FIFO ordering, a take limit
 *  - `attempts` incremented IN the claim, then read back
 *  - configurable MAX_ATTEMPTS
 *  - retry as PENDING until the cap; terminal FAILED only after
 *  - completion updates caught and FENCED by claimToken
 *  - NO network call inside any transaction — there IS no transaction here,
 *    same as payment-outbox.ts: the claim and the completion write are each
 *    their own atomic conditional `updateMany`, and `deliver()` runs strictly
 *    between them, outside of both.
 */

// ── Sender seam (step 10 wires the real Google Chat call) ──────────────────

export interface ReviewAlertEpisodePayload {
    /** Deterministic idempotency key = `issueId:generation` (plan §4 "Delivery")
     * — step 10 passes this as the Chat `requestId`; a repeated requestId
     * returns the existing message rather than posting a duplicate. */
    requestId: string;
    issueId: string;
    targetType: string;
    targetKey: string;
    generation: number;
    reasonCodes: ReasonCode[];
    displayDetails: Record<string, unknown> | null;
}

export interface ReviewAlertBatchPayload {
    requestId: string; // = batchId
    episodes: ReviewAlertEpisodePayload[];
}

export interface ReviewAlertSendResult {
    chatMessageName: string;
}

/** Injectable delivery seam. Step 10 implements this against the Google Chat
 * API; tests use a fake. Never called from inside a transaction. */
export interface ReviewAlertSender {
    sendEpisode(payload: ReviewAlertEpisodePayload): Promise<ReviewAlertSendResult>;
    sendBatch(payload: ReviewAlertBatchPayload): Promise<ReviewAlertSendResult>;
}

/** Step 10 seam: no Chat integration exists yet (plan §4's console-state note
 * — the service account has no key, Vercel isn't wired). Calling this before
 * step 10 replaces it is a configuration error, not a silent no-op — callers
 * (the manual-send API route) must check `REVIEW_ALERTS_ENABLED` and refuse
 * the request before ever reaching a sender. */
export function unconfiguredSender(): ReviewAlertSender {
    const fail = () => {
        throw new Error(
            "ReviewAlertSender not configured — Google Chat delivery ships in Unified Money Register plan step 10.",
        );
    };
    return { sendEpisode: async () => fail(), sendBatch: async () => fail() };
}

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Rate ceiling (plan §4 "Rate ceiling"): at most this many episodes are sent
 * as individual cards per drain run; the rest overflow into one batch. */
export const EPISODE_RATE_CEILING = 10;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_STALE_CLAIM_MS = 5 * 60_000;
const DEFAULT_TAKE_LIMIT = 50;

/** Every episode read for delivery needs its parent issue's identity —
 * shared by the main drain and the batch-member re-read so both build the
 * same shape of send payload. */
const ISSUE_INCLUDE = {
    issue: { select: { targetType: true, targetKey: true, clearedAt: true } },
} as const;

// ── Generic claim/fence/retry core, shared by episodes and batches ─────────

interface RetryRow {
    id: string;
    status: string;
    attempts: number;
}

/** Minimal Prisma-shaped delegate — same convention as
 * QboPurchaseClassificationPersistenceClient (qbo-expense-sync.ts): a
 * hand-typed subset of the real generated client, satisfied by
 * `prisma.reviewAlertEpisode` / `prisma.reviewAlertBatch` at the real call
 * sites and by an in-memory fake in tests. */
interface RetryDelegate<TRow extends RetryRow> {
    findMany(args: {
        where: Record<string, unknown>;
        orderBy: { createdAt: "asc" };
        take: number;
        include?: Record<string, unknown>;
    }): Promise<TRow[]>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    findUnique(args: { where: { id: string } }): Promise<TRow | null>;
}

interface DrainCoreOptions<TRow extends RetryRow> {
    delegate: RetryDelegate<TRow>;
    /** Extra filter merged into the candidate query — `{ issueId }` for the
     * scoped inline fast-path, omitted for the background drain. */
    scopeWhere?: Record<string, unknown>;
    /** Merged into the candidate `findMany` call — episodes need the parent
     * issue's targetType/targetKey/clearedAt to build a send payload. */
    include?: Record<string, unknown>;
    limit: number;
    maxAttempts: number;
    retryBackoffMs: number;
    staleClaimMs: number;
    now: Date;
    deliver: (row: TRow) => Promise<{ ok: true; chatMessageName: string } | { ok: false; error: string }>;
    /** Invoked after a row's completion write actually lands a TERMINAL
     * FAILED (attempts >= maxAttempts) — used by the batch drain to requeue
     * its stranded members (finding 3). Best-effort: a throw here is
     * swallowed so a member-requeue bug can never re-fail the drain loop
     * itself. */
    onTerminalFailure?: (row: TRow) => Promise<void>;
}

interface DrainCoreResult {
    processed: number;
    retried: number;
    failed: number;
}

/**
 * Claim/fence/retry loop, generic over episodes and batches — both tables
 * carry the identical retry-state column set, so this is the ONE place that
 * implements the mechanics payment-outbox.ts established; each caller below
 * supplies only the model-specific candidate `where` and `deliver` (payload
 * build + send).
 */
async function drainCore<TRow extends RetryRow>(opts: DrainCoreOptions<TRow>): Promise<DrainCoreResult> {
    const { delegate, scopeWhere, include, limit, maxAttempts, retryBackoffMs, staleClaimMs, now, deliver, onTerminalFailure } =
        opts;
    const result: DrainCoreResult = { processed: 0, retried: 0, failed: 0 };
    const staleBefore = new Date(now.getTime() - staleClaimMs);

    const candidates = await delegate.findMany({
        where: {
            ...(scopeWhere ?? {}),
            OR: [
                { status: "PENDING", nextAttemptAt: null },
                { status: "PENDING", nextAttemptAt: { lte: now } },
                { status: "CLAIMED", claimedAt: { lt: staleBefore } },
            ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        ...(include ? { include } : {}),
    });

    for (const row of candidates) {
        // Atomic claim scoped to the exact state observed, so two concurrent
        // drainers (inline fast-path + periodic backstop) can never both
        // transition the same row to CLAIMED. The claimToken set here fences
        // the completion update below.
        const claimToken = randomUUID();
        const claim = await delegate.updateMany({
            where: {
                id: row.id,
                status: row.status,
                ...(row.status === "CLAIMED" ? { claimedAt: { lt: staleBefore } } : {}),
            },
            data: { status: "CLAIMED", claimedAt: now, attempts: { increment: 1 }, claimToken },
        });
        if (claim.count === 0) continue; // another drainer already took it

        // Read back the attempts we just set — safe because we now hold the
        // fresh lease (a re-claim requires a stale claimedAt) — so the FAILED
        // cap counts the true post-claim value, not the possibly-stale
        // findMany snapshot.
        const claimed = await delegate.findUnique({ where: { id: row.id } });
        const attempts = claimed?.attempts ?? row.attempts + 1;

        let outcome: { ok: true; chatMessageName: string } | { ok: false; error: string };
        try {
            outcome = await deliver(row);
        } catch (error) {
            outcome = { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 500) };
        }

        // Completion fenced on claimToken AND status:"CLAIMED" (finding 2):
        // if our lease expired and another drainer re-claimed (writing a new
        // token), OR the lifecycle's clear/supersede branches cancelled this
        // exact episode out from under us while its send was in flight (they
        // only ever flip status, never rotate claimToken — see
        // review-alert-lifecycle.ts's OPEN_EPISODE_STATUSES usage), this
        // matches 0 rows and no-ops. Without the status guard, a late FAILED
        // completion whose claimToken still matched would silently rewrite a
        // CANCELLED/SUPERSEDED row back to PENDING and retry a stale alert.
        if (outcome.ok) {
            const done = await delegate
                .updateMany({
                    where: { id: row.id, status: "CLAIMED", claimToken },
                    data: { status: "SENT", sentAt: now, chatMessageName: outcome.chatMessageName, lastError: null },
                })
                .catch(() => ({ count: 0 }));
            if (done.count > 0) result.processed++;
        } else {
            const dead = attempts >= maxAttempts;
            const done = await delegate
                .updateMany({
                    where: { id: row.id, status: "CLAIMED", claimToken },
                    data: dead
                        ? { status: "FAILED", lastError: outcome.error }
                        : {
                              // Retry as PENDING until the cap — terminal FAILED
                              // only once attempts >= maxAttempts (plan punch 3:
                              // the earlier version stranded failures by writing
                              // FAILED here and only ever claiming PENDING).
                              status: "PENDING",
                              lastError: outcome.error,
                              nextAttemptAt: new Date(now.getTime() + retryBackoffMs),
                          },
                })
                .catch(() => ({ count: 0 }));
            if (done.count > 0) {
                if (dead) {
                    result.failed++;
                    if (onTerminalFailure) await onTerminalFailure(row).catch(() => undefined);
                } else {
                    result.retried++;
                }
            }
        }
    }

    return result;
}

// ── Episodes ─────────────────────────────────────────────────────────────────

interface EpisodeCandidateRow extends RetryRow {
    id: string;
    issueId: string;
    generation: number;
    reasonCodes: string;
    displayDetails: string | null;
    status: string;
    attempts: number;
    /** Only present when the query passed `include: ISSUE_INCLUDE` — the
     * plain candidate lookahead in `drainReviewAlerts` doesn't need it and
     * omits it; the per-episode/per-batch-member delivery reads do. */
    issue?: { targetType: string; targetKey: string; clearedAt: Date | null } | null;
}

export interface EpisodeDelegate extends RetryDelegate<EpisodeCandidateRow> {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
}

export interface BatchCandidateRow extends RetryRow {
    id: string;
    status: string;
    attempts: number;
}

export interface BatchDelegate extends RetryDelegate<BatchCandidateRow> {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
}

export interface ReviewAlertOutboxClient {
    reviewAlertEpisode: EpisodeDelegate;
    reviewAlertBatch: BatchDelegate;
    /** Finding 1: the drainer must independently check the rollout gate
     * (not just trust that the evaluator already gated its own episode
     * creation) — the manual "Send now" API route calls `drainReviewAlerts`
     * directly and would otherwise be a live bypass of the baseline gate
     * once a real sender ships. */
    rolloutGate: RolloutGateClient["rolloutGate"];
}

export interface DrainReviewAlertsOptions {
    /** Inline fast-path scope — deliver just the episode(s) this issue's
     * evaluation just enqueued. Omit for the periodic backstop's full sweep. */
    issueId?: string;
    limit?: number;
    maxAttempts?: number;
    retryBackoffMs?: number;
    staleClaimMs?: number;
    now?: Date;
    client?: ReviewAlertOutboxClient;
    sender: ReviewAlertSender;
}

export interface DrainReviewAlertsResult {
    episodes: DrainCoreResult;
    batch: DrainCoreResult;
    /** Number of PENDING episodes moved to BATCHED this run because the
     * candidate count exceeded EPISODE_RATE_CEILING. */
    batchedOverflow: number;
    /** True when this run did NOTHING because the rollout baseline gate
     * (review-alert-rollout.ts) is not yet "complete" (finding 1). */
    blockedByRollout: boolean;
}

function emptyDrainResult(): DrainCoreResult {
    return { processed: 0, retried: 0, failed: 0 };
}

/**
 * Drain the review-alert outbox: episodes first (up to the rate ceiling as
 * individual cards, overflow moved to one batch), then drain any due batch
 * (including the one possibly just created) through the identical
 * claim/fence/retry core.
 *
 * `issueId` scopes to one issue's inline fast-path (mirrors
 * payment-outbox.ts's `{ scheduleId }` — deliver just what that evaluation
 * enqueued). Omitted, this is the periodic backstop's background sweep.
 */
export async function drainReviewAlerts(options: DrainReviewAlertsOptions): Promise<DrainReviewAlertsResult> {
    const now = options.now ?? new Date();
    const client = options.client ?? (prisma as unknown as ReviewAlertOutboxClient);
    const limit = options.limit ?? DEFAULT_TAKE_LIMIT;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
    const sender = options.sender;
    const scopeWhere = options.issueId ? { issueId: options.issueId } : undefined;

    // Finding 1: the gate is the authority on whether ANYTHING may be sent
    // yet, independent of whatever the evaluator did or didn't do upstream —
    // exit immediately unless the baseline is fully complete.
    const gateState = await readRolloutGateState(client, now);
    if (gateState !== "complete") {
        return { episodes: emptyDrainResult(), batch: emptyDrainResult(), batchedOverflow: 0, blockedByRollout: true };
    }

    // Look ahead past the rate ceiling so we know whether there's overflow to
    // batch, without claiming anything yet.
    const staleBefore = new Date(now.getTime() - staleClaimMs);
    const dueEpisodes = await client.reviewAlertEpisode.findMany({
        where: {
            ...(scopeWhere ?? {}),
            OR: [
                { status: "PENDING", nextAttemptAt: null },
                { status: "PENDING", nextAttemptAt: { lte: now } },
                { status: "CLAIMED", claimedAt: { lt: staleBefore } },
            ],
        },
        orderBy: { createdAt: "asc" },
        take: Math.max(limit, EPISODE_RATE_CEILING + 1),
    });

    // Finding 4: ONE total network-send budget of EPISODE_RATE_CEILING per
    // run, shared across individual episodes, the fresh overflow batch (if
    // any), AND any old batches drained in the same run — an earlier version
    // sent up to 10 individual + 1 new-batch summary + up to 50 OLD batches,
    // wildly exceeding the stated "max 10 cards/run" ceiling.
    let batchedOverflow = 0;
    let newBatchId: string | null = null;
    let episodeSendLimit = EPISODE_RATE_CEILING;
    if (dueEpisodes.length > EPISODE_RATE_CEILING) {
        // Overflow: reserve exactly one slot in the shared budget for the new
        // summary batch card — at most 9 individual + 1 summary = 10 total.
        episodeSendLimit = EPISODE_RATE_CEILING - 1;
        const overflow = dueEpisodes.slice(episodeSendLimit);
        const batch = await client.reviewAlertBatch.create({ data: { status: "PENDING" } });
        newBatchId = batch.id;
        for (const episode of overflow) {
            // Conditional on status = "PENDING": a CLAIMED-stale episode is
            // mid-reclaim by definition and is left for the individual path
            // (or a later run) rather than silently vanished into a batch.
            const moved = await client.reviewAlertEpisode.updateMany({
                where: { id: episode.id, status: "PENDING" },
                data: { status: "BATCHED", batchId: batch.id },
            });
            if (moved.count > 0) batchedOverflow++;
        }
    }

    const episodeResult = await drainCore<EpisodeCandidateRow>({
        delegate: client.reviewAlertEpisode,
        scopeWhere,
        include: ISSUE_INCLUDE,
        limit: episodeSendLimit,
        maxAttempts,
        retryBackoffMs,
        staleClaimMs,
        now,
        deliver: async row => {
            if (!row.issue) return { ok: false, error: "episode has no parent issue" };
            try {
                const send = await sender.sendEpisode({
                    requestId: `${row.issueId}:${row.generation}`,
                    issueId: row.issueId,
                    targetType: row.issue.targetType,
                    targetKey: row.issue.targetKey,
                    generation: row.generation,
                    reasonCodes: decodeReasonCodes(row.reasonCodes),
                    displayDetails: row.displayDetails ? (JSON.parse(row.displayDetails) as Record<string, unknown>) : null,
                });
                return { ok: true, chatMessageName: send.chatMessageName };
            } catch (error) {
                return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 500) };
            }
        },
    });

    // Remaining budget for batch draining — the ACTUAL number of individual
    // candidates about to be attempted (capped at episodeSendLimit), plus the
    // slot already reserved for a fresh overflow batch, are subtracted from
    // the shared 10-send budget. Old-batch draining consumes whatever is left
    // (finding 4) — it does NOT get its own separate allowance.
    const episodeCandidateCount = Math.min(dueEpisodes.length, episodeSendLimit);
    const reservedForNewBatch = newBatchId ? 1 : 0;
    const remainingBudget = Math.max(0, EPISODE_RATE_CEILING - episodeCandidateCount - reservedForNewBatch);
    const batchLimit = newBatchId ? 1 : Math.min(limit, remainingBudget);

    // Drain any due batch — including the one just created above, so a fresh
    // overflow sends promptly rather than waiting for the next backstop run.
    const batchResult = await drainCore<BatchCandidateRow>({
        delegate: client.reviewAlertBatch,
        scopeWhere: newBatchId ? { id: newBatchId } : undefined,
        limit: batchLimit,
        maxAttempts,
        retryBackoffMs,
        staleClaimMs,
        now,
        onTerminalFailure: async batchRow => {
            // Finding 3: a batch that permanently fails to send (terminal
            // FAILED, attempts >= maxAttempts) must not strand its members at
            // BATCHED forever — the batch row itself is now terminal and will
            // never be drained again. Requeue members as PENDING with
            // batchId cleared so the NEXT drain reconsiders them
            // individually rather than losing them.
            await client.reviewAlertEpisode.updateMany({
                where: { batchId: batchRow.id, status: "BATCHED" },
                data: { status: "PENDING", batchId: null, nextAttemptAt: null },
            });
        },
        deliver: async row => {
            try {
                // Cleared/superseded members flip OUT of BATCHED status (the
                // lifecycle's clear/supersede branches treat BATCHED as an
                // open, cancellable state — review-alert-lifecycle.ts's
                // OPEN_EPISODE_STATUSES) — so re-reading fresh here and
                // filtering to status "BATCHED" excludes any stale issue from
                // the payload without the batch itself needing to know why a
                // member dropped out (plan §4 "Rate ceiling").
                const members = await client.reviewAlertEpisode.findMany({
                    where: { batchId: row.id, status: "BATCHED" },
                    orderBy: { createdAt: "asc" },
                    take: 1000,
                    include: ISSUE_INCLUDE,
                });
                if (members.length === 0) {
                    // Every member cleared/superseded before this batch sent —
                    // nothing left to say. Treat as a successful no-op send so
                    // it doesn't retry forever.
                    return { ok: true, chatMessageName: "" };
                }
                const send = await sender.sendBatch({
                    requestId: row.id,
                    episodes: members.map(m => ({
                        requestId: `${m.issueId}:${m.generation}`,
                        issueId: m.issueId,
                        targetType: m.issue?.targetType ?? "",
                        targetKey: m.issue?.targetKey ?? "",
                        generation: m.generation,
                        reasonCodes: decodeReasonCodes(m.reasonCodes),
                        displayDetails: m.displayDetails ? (JSON.parse(m.displayDetails) as Record<string, unknown>) : null,
                    })),
                });
                // Finalize EXACTLY the members that actually rode in this
                // payload, by id — otherwise they'd sit at BATCHED forever
                // even though the summary card that covers them was
                // delivered. Finding 3: the previous blanket
                // `where:{batchId,status:"BATCHED"}` update marked ALL
                // still-BATCHED members SENT regardless of whether they were
                // in `members` — a batch larger than the `take: 1000` cap
                // above would have wrongly marked its un-sent overflow SENT.
                // Still fenced by status:"BATCHED" so a member that flipped
                // to CANCELLED/SUPERSEDED between the read above and here is
                // left alone. This is a plain follow-up write, not another
                // network call, so it's fine after `sendBatch` succeeded.
                await client.reviewAlertEpisode.updateMany({
                    where: { id: { in: members.map(m => m.id) }, batchId: row.id, status: "BATCHED" },
                    data: { status: "SENT", sentAt: now, chatMessageName: send.chatMessageName },
                });
                return { ok: true, chatMessageName: send.chatMessageName };
            } catch (error) {
                return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 500) };
            }
        },
    });

    return { episodes: episodeResult, batch: batchResult, batchedOverflow, blockedByRollout: false };
}
