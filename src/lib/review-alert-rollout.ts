import { prisma } from "./prisma";
import { evaluateReviewIssue, type ReviewIssueLifecycleClient } from "./review-alert-lifecycle";
import type { ReasonCode } from "./review-alert-reasons";

/**
 * Rollout baseline gate (Unified Money Register plan §4 "Rollout", punch 11).
 *
 * NOT a long-held transaction and NOT a session advisory lock — pgbouncer's
 * transaction-pooling mode hands out a different backend connection per
 * statement, so neither primitive survives across the multi-second sweep this
 * needs. Instead: a single durable `RolloutGate` row, claimed with the same
 * conditional-updateMany pattern the outbox uses to claim work, with a
 * stale-claim reclaim window for a crashed worker.
 *
 * Sequence (plan §4 exactly): gate on → write every currently-failing target
 * as a SUPPRESSED episode (so today's entire backlog is visible on the
 * dashboard but produces zero Chat cards) → one final catch-up evaluation
 * (normal PENDING episodes — anything that started failing in the gap
 * between listing the backlog and finishing the sweep gets a REAL alert,
 * which is correct: it's new, not backlog) → persist completion → gate off.
 * `firstObservedAt` (set by evaluateReviewIssue's create/reopen branches)
 * is what "alert on state transition" means afterward — nothing more than
 * the ordinary lifecycle from that point on.
 *
 * Codex round-1 finding 1 ("rollout is a lease, not a gate"): a caller that
 * lost the claim used to get `ranBaseline:false` and its caller
 * (review-alert-evaluator.ts's `runEvaluation`) ignored that entirely and
 * evaluated anyway, creating ordinary PENDING episodes — bypassing the gate
 * completely. The fix has two parts:
 *   1. This module now returns an explicit `state` ("ready" | "in-progress" |
 *      "complete") instead of a bare boolean. Callers (the evaluator, the
 *      outbox drainer) MUST treat anything but "complete" as "do not
 *      evaluate/deliver yet" — see review-alert-evaluator.ts's `runEvaluation`
 *      and review-alert-outbox.ts's `drainReviewAlerts`.
 *   2. review-alert-evaluator.ts now exports `runReviewAlertsBaseline`, a
 *      baseline-ONLY entry point that calls straight into this module with
 *      no `REVIEW_ALERTS_ENABLED` check — the ONLY other callers
 *      (`evaluateReviewAlertsPostSync` / `evaluateReviewAlertsBackstop`) are
 *      both gated behind that flag, which made "baseline before enable"
 *      (the plan's own stated order) operationally impossible. See
 *      scripts/run-review-alerts-baseline.ts.
 */

const GATE_KEY = "review-alerts-baseline";
const STALE_CLAIM_MS = 10 * 60_000; // a crashed baseline sweep is reclaimable after 10 minutes

export type RolloutGateState = "ready" | "in-progress" | "complete";

export interface ReviewTarget {
    targetType: string;
    targetKey: string;
    reasonCodes: ReasonCode[];
    displayDetails: Record<string, unknown> | null;
}

export interface RolloutGateRow {
    key: string;
    status: string;
    claimToken: string | null;
    claimedAt: Date | null;
}

export interface RolloutGateClient {
    rolloutGate: {
        upsert(args: {
            where: { key: string };
            create: { key: string };
            update: Record<string, never>;
        }): Promise<RolloutGateRow>;
        updateMany(args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }): Promise<{ count: number }>;
    };
}

/** Pure — maps a raw gate row (as stored: status "pending" | "in-progress" |
 * "complete") to the caller-facing tri-state, folding a STALE in-progress
 * claim (a crashed sweep) into "ready" — reclaimable, not actively held. */
export function rolloutStateFromRow(row: { status: string; claimedAt: Date | null }, now: Date): RolloutGateState {
    if (row.status === "complete") return "complete";
    if (row.status === "in-progress") {
        const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
        if (row.claimedAt && row.claimedAt < staleBefore) return "ready";
        return "in-progress";
    }
    return "ready";
}

/** Cheap, side-effect-free (beyond ensuring the row exists) state check —
 * used by callers that must NOT attempt to run the sweep themselves (the
 * outbox drainer, finding 1) but still need to know whether it's safe to
 * proceed. */
export async function readRolloutGateState(
    client: RolloutGateClient,
    now: Date = new Date(),
): Promise<RolloutGateState> {
    const gate = await client.rolloutGate.upsert({
        where: { key: GATE_KEY },
        create: { key: GATE_KEY },
        update: {},
    });
    return rolloutStateFromRow(gate, now);
}

export interface EnsureRolloutBaselineOptions {
    /** Enumerates every currently-failing target — the evaluator module
     * supplies the real Prisma+QBO-backed implementation; tests pass a fake. */
    computeReviewTargets: () => Promise<ReviewTarget[]>;
    client?: RolloutGateClient;
    lifecycleClient?: ReviewIssueLifecycleClient;
    now?: () => Date;
    evaluate?: typeof evaluateReviewIssue;
}

export interface EnsureRolloutBaselineResult {
    /** "complete" once the baseline is fully done — either it already was, or
     * THIS call finished it. Anything else means the caller must NOT create
     * ordinary PENDING episodes or drain anything this cycle. */
    state: RolloutGateState;
    /** True only when THIS call performed (and committed) the sweep. */
    ranBaseline: boolean;
    baselineCount?: number;
    catchUpCount?: number;
    /** Only set when `ranBaseline` is true — the catch-up pass's freshly
     * computed targets, so the caller can reuse them as this cycle's normal
     * evaluation pass instead of fetching a third time (finding 5). */
    catchUpTargets?: ReviewTarget[];
}

/**
 * Idempotent, cheap to call on every evaluation once the baseline is
 * complete (a single indexed read). Runs the one-time sweep exactly once
 * across however many concurrent callers race for it — everyone else either
 * sees "complete" immediately or loses the claim and returns `state:
 * "in-progress"` without touching anything.
 */
export async function ensureRolloutBaseline(
    options: EnsureRolloutBaselineOptions,
): Promise<EnsureRolloutBaselineResult> {
    const client = options.client ?? (prisma as unknown as RolloutGateClient);
    const now = options.now ?? (() => new Date());
    const evaluate = options.evaluate ?? evaluateReviewIssue;

    const nowValue = now();
    const gate = await client.rolloutGate.upsert({
        where: { key: GATE_KEY },
        create: { key: GATE_KEY },
        update: {},
    });
    if (rolloutStateFromRow(gate, nowValue) === "complete") return { state: "complete", ranBaseline: false };

    const staleBefore = new Date(nowValue.getTime() - STALE_CLAIM_MS);
    const claimToken = `${nowValue.getTime()}:${Math.random().toString(36).slice(2)}`;
    const claim = await client.rolloutGate.updateMany({
        where: {
            key: GATE_KEY,
            OR: [{ status: "pending" }, { status: "in-progress", claimedAt: { lt: staleBefore } }],
        },
        data: { status: "in-progress", claimToken, claimedAt: nowValue, startedAt: nowValue },
    });
    if (claim.count === 0) {
        // Another worker holds a fresh claim (or just completed it) — not our
        // job right now. Report "in-progress" rather than re-reading for the
        // rare completed-between-our-two-reads race: safe either way, and
        // the NEXT call's initial upsert read will see "complete" for real.
        return { state: "in-progress", ranBaseline: false };
    }

    try {
        const baseline = await options.computeReviewTargets();
        for (const target of baseline) {
            await evaluate(target.targetType, target.targetKey, target.reasonCodes, target.displayDetails, {
                episodeStatus: "SUPPRESSED",
                client: options.lifecycleClient,
                recomputeCodes: async () => {
                    const fresh = await options.computeReviewTargets();
                    return (
                        fresh.find(t => t.targetType === target.targetType && t.targetKey === target.targetKey)
                            ?.reasonCodes ?? []
                    );
                },
            });
        }

        // Final catch-up: re-list and re-evaluate normally (PENDING). Targets
        // already baselined above hit lifecycle step 5 ("same reasonHash —
        // touch only") and produce no new episode; only a target that started
        // failing in the gap gets a real alert.
        const catchUp = await options.computeReviewTargets();
        for (const target of catchUp) {
            await evaluate(target.targetType, target.targetKey, target.reasonCodes, target.displayDetails, {
                client: options.lifecycleClient,
                recomputeCodes: async () => {
                    const fresh = await options.computeReviewTargets();
                    return (
                        fresh.find(t => t.targetType === target.targetType && t.targetKey === target.targetKey)
                            ?.reasonCodes ?? []
                    );
                },
            });
        }

        const completed = await client.rolloutGate.updateMany({
            where: { key: GATE_KEY, claimToken },
            data: { status: "complete", completedAt: now() },
        });
        if (completed.count === 0) {
            // Our lease expired and someone else reclaimed mid-sweep — leave
            // it to them; do not report success we didn't actually commit.
            return { state: "in-progress", ranBaseline: false };
        }
        return {
            state: "complete",
            ranBaseline: true,
            baselineCount: baseline.length,
            catchUpCount: catchUp.length,
            catchUpTargets: catchUp,
        };
    } catch (error) {
        await client.rolloutGate
            .updateMany({
                where: { key: GATE_KEY, claimToken },
                data: {
                    status: "pending",
                    lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
                    attempts: { increment: 1 },
                },
            })
            .catch(() => undefined);
        throw error;
    }
}
