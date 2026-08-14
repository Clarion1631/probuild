import { prisma } from "./prisma";
import { getFreshQBTokens } from "./quickbooks-payments";
import { fetchBankRegister } from "./qbo-bank-register";
import { isPurchaseType } from "./register-types";
import {
    mergeRegister,
    type PurchaseClassification,
    type RegisterMergeClassification,
    type RegisterMergeExpense,
    type RegisterMergeReceiptEvent,
} from "./register-merge";
import { deriveReasonCodes, type ReasonCode } from "./review-alert-reasons";
import { evaluateReviewIssue, type ReviewIssueLifecycleClient } from "./review-alert-lifecycle";
import { ensureRolloutBaseline, type EnsureRolloutBaselineResult, type ReviewTarget } from "./review-alert-rollout";

/**
 * Review-alert evaluators (Unified Money Register plan §5 step 8): the two
 * entry points that turn the merged register (register-merge.ts, read-only
 * dependency — owned by a parallel workstream, not modified here) into
 * ReviewIssue/ReviewAlertEpisode writes.
 *
 *  - `evaluateReviewAlertsPostSync` — hooked into `syncQboExpenses`
 *    completion (qbo-expense-sync.ts), best-effort, never throws into the
 *    money-sync path it rides alongside (same posture as that function's own
 *    `persistClassification`/`attachReceipt`).
 *  - `evaluateReviewAlertsBackstop` — periodic (cron) safety net. Deliberately
 *    IDENTICAL work to the post-sync path, not a narrower "just what
 *    changed" pass: `logAutomationEvent` swallows insert failures
 *    (automation-events.ts:61) and the post-sync hook itself can throw and be
 *    swallowed by its own try/catch, so nothing here can assume the ingest
 *    path's last run actually landed. Re-sweeping the whole window on a timer
 *    is what makes a missed evaluation self-heal on the NEXT run instead of
 *    silently skipping that target forever (plan §5 step 8, "Codex flagged
 *    this as a new finding").
 *
 * Both are no-ops behind `REVIEW_ALERTS_ENABLED` (ships `false`).
 *
 * Deliberately NOT wired here: draining the outbox. `drainReviewAlerts`
 * (review-alert-outbox.ts) needs a real `ReviewAlertSender`, which doesn't
 * exist until plan step 10 (Google Chat). Calling it here with
 * `unconfiguredSender()` would burn real retry `attempts` on every episode
 * this evaluator creates — possibly exhausting `MAX_ATTEMPTS` into a
 * terminal FAILED before step 10 ever ships a working sender. Draining is
 * step 10's job once it can actually succeed.
 */

const WINDOW_DAYS = 90; // under fetchBankRegister's 92-day cap (qbo-bank-register.ts)
const TARGET_TYPE = "qbo-purchase";

function reviewAlertsEnabled(): boolean {
    return process.env.REVIEW_ALERTS_ENABLED === "true";
}

/** Fail-closed to "unknown" — same convention as the automation page's own
 * fetch glue (not imported from here: that module lives under
 * src/app/automation/**, which another agent is actively editing this
 * session, and the query this needs is a two-line duplicate, not worth a
 * cross-directory coupling). */
function asClassification(value: string): PurchaseClassification {
    return value === "job-cost" || value === "overhead" || value === "owner-draw" ? value : "unknown";
}

async function fetchExpensesByPurchaseIds(purchaseIds: string[]): Promise<RegisterMergeExpense[]> {
    if (purchaseIds.length === 0) return [];
    return prisma.expense.findMany({
        where: { qbPurchaseId: { in: purchaseIds } },
        select: {
            qbPurchaseId: true,
            amount: true,
            receiptUrl: true,
            estimate: { select: { project: { select: { id: true, name: true } } } },
        },
    });
}

async function fetchReceiptEvents(since: Date): Promise<RegisterMergeReceiptEvent[]> {
    return prisma.automationEvent.findMany({
        where: { kind: { in: ["receipt-push", "receipt-stage"] }, createdAt: { gte: since } },
        select: {
            kind: true,
            status: true,
            qbPurchaseId: true,
            driveFileId: true,
            docNumber: true,
            fileName: true,
            vendor: true,
            amountCents: true,
            reason: true,
            createdAt: true,
        },
        // Same "newest-first cap, then used as-is" convention as
        // automation-events.ts's receiptJourneys() — a display-cap, not a
        // table-size bound (plan §1).
        orderBy: { createdAt: "desc" },
        take: 5000,
    });
}

async function fetchClassifications(purchaseIds: string[]): Promise<RegisterMergeClassification[]> {
    if (purchaseIds.length === 0) return [];
    const rows = await prisma.qboPurchaseClassification.findMany({
        where: { qbPurchaseId: { in: purchaseIds } },
        select: { qbPurchaseId: true, classification: true, reason: true },
    });
    return rows.map(r => ({
        qbPurchaseId: r.qbPurchaseId,
        classification: asClassification(r.classification),
        reason: r.reason,
    }));
}

export interface ReviewTargetsSnapshot {
    targets: ReviewTarget[];
    /** Propagated from `fetchBankRegister`'s own `stale` flag: true when QBO
     * errored this call and a previously-cached register was served instead
     * (qbo-bank-register.ts:147,188). A `stale` snapshot is NOT a trustworthy
     * full picture of what currently exists in QBO — callers that need to
     * know "is a target's absence from this list real" (reconcileMissingTargets's
     * trust gate) must check this before acting on absence. */
    stale: boolean;
}

/**
 * Every register row with a QBO transaction id, over a trailing window,
 * mapped to its CURRENT reason codes (possibly `[]`). `[]` is not filtered
 * out — a row that now passes must still be evaluated so a previously-open
 * issue for it can clear (lifecycle step 1); only the rollout baseline
 * effectively narrows to the non-empty subset, and it does that by
 * definition (an empty-code evaluation against no existing issue is a no-op
 * either way).
 *
 * Finding 8: `deriveReasonCodes` (review-alert-reasons.ts) covers MORE than
 * purchase-type rows — a money-in type posted negative (sign/type conflict)
 * and an unrecognized/"Refund Receipt" type posted negative both derive
 * `UNRECOGNIZED_OUTFLOW` per that function's own final branch, mirroring
 * register-merge.ts's non-purchase-type needs-review branches one-for-one.
 * An earlier version of this loop filtered to `row.isPurchaseType` only,
 * silently dropping that entire domain from ever being evaluated. The only
 * real requirement for a target is a non-null `qbTxnId` (the dedup key);
 * `purchaseIds` above stays purchase-type-scoped on purpose (only purchase
 * rows join to Expense/QboPurchaseClassification), but the target LIST built
 * here must not.
 */
async function computeReviewTargetsSnapshot(now: Date = new Date()): Promise<ReviewTargetsSnapshot> {
    const tokens = await getFreshQBTokens();
    const endDate = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

    const registerResult = await fetchBankRegister(async () => tokens, startDate, endDate);
    const purchaseIds = registerResult.rows
        .filter(r => isPurchaseType(r.qbType) && r.qbTxnId)
        .map(r => r.qbTxnId as string);

    const [expenses, receiptEvents, classifications] = await Promise.all([
        fetchExpensesByPurchaseIds(purchaseIds),
        fetchReceiptEvents(new Date(now.getTime() - WINDOW_DAYS * 86_400_000)),
        fetchClassifications(purchaseIds),
    ]);

    const merged = mergeRegister(registerResult.rows, expenses, receiptEvents, classifications);

    const targets: ReviewTarget[] = [];
    for (const row of merged.rows) {
        if (!row.qbTxnId) continue;
        targets.push({
            targetType: TARGET_TYPE,
            targetKey: row.qbTxnId,
            reasonCodes: deriveReasonCodes(row),
            displayDetails: {
                date: row.date,
                qbType: row.qbType,
                amountCents: row.amountCents,
                docNum: row.docNum,
                vendor: row.name,
                projectName: row.projectName,
                label: row.label,
            },
        });
    }
    return { targets, stale: registerResult.stale };
}

/** Thin wrapper over `computeReviewTargetsSnapshot` that keeps the ORIGINAL
 * `Promise<ReviewTarget[]>` signature — deliberately, so the rollout module's
 * `EnsureRolloutBaselineOptions.computeReviewTargets` seam
 * (review-alert-rollout.ts) and `recomputeCodesFor` below don't need to
 * change shape. Only `runEvaluation`'s reconciliation step needs the `stale`
 * flag, so it calls `computeReviewTargetsSnapshot` directly instead. */
export async function computeReviewTargets(now: Date = new Date()): Promise<ReviewTarget[]> {
    return (await computeReviewTargetsSnapshot(now)).targets;
}

/** Re-derives ONE target's current reason codes from a fresh full sweep —
 * used as the `recomputeCodes` callback on version-conflict retries (finding
 * 6). `fetchBankRegister` caches its QBO report for 120s
 * (qbo-bank-register.ts), so a retry within that window is a cache hit, not
 * a second live QBO call. */
async function recomputeCodesFor(targetKey: string, now: Date): Promise<ReasonCode[]> {
    const fresh = await computeReviewTargets(now);
    return fresh.find(t => t.targetType === TARGET_TYPE && t.targetKey === targetKey)?.reasonCodes ?? [];
}

/** Prisma-shaped subset for listing/updating open issue keys — separate from
 * `ReviewIssueLifecycleClient` (that one is about single-row lifecycle
 * transitions guarded by `version`; this is a plain list read plus bulk
 * `absentSince` bookkeeping writes for reconciliation, finding 8). */
interface OpenIssueKeyLister {
    reviewIssue: {
        findMany(args: {
            where: { targetType: string; clearedAt: null };
            select: { targetKey: true; absentSince: true };
        }): Promise<Array<{ targetKey: string; absentSince: Date | null }>>;
        updateMany(args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }): Promise<{ count: number }>;
    };
}

/** How long a target must be continuously absent from a TRUSTWORTHY snapshot
 * before its open ReviewIssue is actually cleared (arbiter ruling, replacing
 * the immediate-clear design below). Must outlive: `fetchBankRegister`'s
 * 120s per-instance register cache (qbo-bank-register.ts), its 30s QBO-
 * failure cooldown, AND at least one full backstop interval with margin —
 * vercel.json's `review-alerts-backstop` cron runs once per hour (minute 15
 * of every hour), so 6h spans six independent sweeps, well over the
 * required two. */
export const ABSENCE_GRACE_MS = 6 * 3_600_000;

/** Floor below which the coverage gate (below) does not apply. The gate's
 * ratio (`present / openIssues.length`) is a circuit breaker meant to catch
 * mass disappearance from a misconfigured or faulting register — but over a
 * denominator of one or two, the ratio is noise, not signal: a single open
 * issue whose target genuinely vanished from QBO scores 0/1 = 0%, permanently
 * below the 50% threshold, so it can never age out and its ReviewIssue stays
 * open forever. "Mass disappearance" isn't a meaningful concept at 1-4 open
 * issues in the first place. Below this floor the coverage gate is skipped
 * and normal absence tracking proceeds — the `stale` gate and the
 * `ABSENCE_GRACE_MS` grace period are still in effect and remain the primary
 * defense against transient gaps. Do not remove this as "arbitrary": without
 * it, a genuinely-deleted lone target is stranded open forever. */
const COVERAGE_GATE_MIN_OPEN_ISSUES = 5;

/**
 * Finding 8 (part 2): a purchase deleted in QBO, retyped off this
 * evaluator's domain, or simply aged past the trailing WINDOW_DAYS window
 * stops appearing in `computeReviewTargets()` entirely — with no
 * reconciliation, its ReviewIssue (if still open) would never receive the
 * `[]` "clear" evaluation and would stay open forever.
 *
 * Age-out policy (arbiter ruling): NOT immediate. `fetchBankRegister` does
 * NOT fail closed on a QBO error — it returns the last good cached result
 * marked `stale: true` whenever a cache entry exists (qbo-bank-register.ts:
 * 147, 188), and a structurally-valid but wrong/empty report (misconfigured
 * bank account id, QBO fault) is indistinguishable from "everything got
 * fixed" without an independent check. Clearing an issue immediately wipes
 * `acknowledgedCodes`/`acknowledgedAt` (review-alert-lifecycle.ts's "clear"
 * branch) and a later reopen mints a new `requestId`
 * (`issueId:generation`, review-alert-outbox.ts), so a single bad or stale
 * sweep would both destroy a bookkeeper's "I reviewed this" decision AND
 * send her a duplicate card. Instead: track `absentSince` per issue, only
 * treat a snapshot as trustworthy enough to act on absence when it passes
 * BOTH a freshness gate (not `stale`) and a coverage gate (at least half of
 * currently-open issue keys still appear in it — the circuit breaker for a
 * wrong-account/empty-report misconfiguration), and only clear once a target
 * has been continuously absent from trustworthy snapshots for
 * `ABSENCE_GRACE_MS`.
 *
 * `client` lists/updates the bookkeeping columns (`targetKey`, `absentSince`)
 * and `lifecycleClient` is threaded through to `evaluateReviewIssue` for the
 * actual clear — both default to real Prisma but are separately injectable
 * (same split as `EnsureRolloutBaselineOptions.client` /
 * `.lifecycleClient` in review-alert-rollout.ts) so tests can back both with
 * one in-memory fake without touching a database.
 */
export async function reconcileMissingTargets(
    presentKeys: ReadonlySet<string>,
    stale: boolean,
    now: Date,
    client: OpenIssueKeyLister = prisma as unknown as OpenIssueKeyLister,
    lifecycleClient?: ReviewIssueLifecycleClient,
): Promise<number> {
    const openIssues = await client.reviewIssue.findMany({
        where: { targetType: TARGET_TYPE, clearedAt: null },
        select: { targetKey: true, absentSince: true },
    });
    if (openIssues.length === 0) return 0;

    const presentCount = openIssues.filter(issue => presentKeys.has(issue.targetKey)).length;
    const coverageGateApplies = openIssues.length >= COVERAGE_GATE_MIN_OPEN_ISSUES;
    const coverageOk = !coverageGateApplies || presentCount >= openIssues.length / 2;
    if (stale || !coverageOk) {
        console.warn(
            `reconcileMissingTargets: trust gate tripped (stale=${stale}, present=${presentCount}/${openIssues.length} open issue keys) — skipping reconciliation this sweep`,
        );
        return 0;
    }

    const recoveredKeys: string[] = [];
    const newlyAbsentKeys: string[] = [];
    const readyToClearKeys: string[] = [];
    for (const issue of openIssues) {
        if (presentKeys.has(issue.targetKey)) {
            if (issue.absentSince !== null) recoveredKeys.push(issue.targetKey);
            continue;
        }
        if (issue.absentSince === null) {
            newlyAbsentKeys.push(issue.targetKey);
        } else if (now.getTime() - issue.absentSince.getTime() >= ABSENCE_GRACE_MS) {
            readyToClearKeys.push(issue.targetKey);
        }
    }

    if (recoveredKeys.length > 0) {
        await client.reviewIssue.updateMany({
            where: { targetType: TARGET_TYPE, targetKey: { in: recoveredKeys } },
            data: { absentSince: null },
        });
    }
    if (newlyAbsentKeys.length > 0) {
        await client.reviewIssue.updateMany({
            where: { targetType: TARGET_TYPE, targetKey: { in: newlyAbsentKeys } },
            data: { absentSince: now },
        });
    }

    let cleared = 0;
    for (const targetKey of readyToClearKeys) {
        // Finding 6's version-conflict hazard applies here too (item 4 of
        // the arbiter ruling): without recomputeCodes, a retry after a
        // version conflict would reapply the stale `[]` snapshot and stomp
        // a concurrent fresh observation. Mirrors the main loop's pattern.
        await evaluateReviewIssue(TARGET_TYPE, targetKey, [], null, {
            now: () => now,
            recomputeCodes: () => recomputeCodesFor(targetKey, now),
            client: lifecycleClient,
        });
        cleared++;
    }
    if (readyToClearKeys.length > 0) {
        await client.reviewIssue.updateMany({
            where: { targetType: TARGET_TYPE, targetKey: { in: readyToClearKeys } },
            data: { absentSince: null },
        });
    }
    return cleared;
}

export interface EvaluateReviewAlertsResult {
    ran: boolean;
    evaluated: number;
    baseline?: EnsureRolloutBaselineResult;
    /** Open issues cleared this run because their target disappeared from
     * the current snapshot (finding 8, reconciliation). */
    reconciled?: number;
}

async function runEvaluation(now: Date = new Date()): Promise<EvaluateReviewAlertsResult> {
    if (!reviewAlertsEnabled()) return { ran: false, evaluated: 0 };

    const baseline = await ensureRolloutBaseline({
        computeReviewTargets: () => computeReviewTargets(now),
    });

    // Finding 1: the rollout gate is not advisory — a caller that doesn't
    // hold "complete" this cycle (someone else is running it, it just
    // crashed and isn't stale-reclaimable yet, etc.) must NOT create ordinary
    // PENDING episodes. Bypassing this would alert on the pre-existing
    // backlog the baseline exists to suppress.
    if (baseline.state !== "complete") {
        return { ran: false, evaluated: 0, baseline };
    }

    // Finding 5: when THIS call just finished the baseline sweep, its
    // catch-up pass already computed a fresh target snapshot — reuse it for
    // the evaluation loop instead of fetching a third time (baseline fetch +
    // catch-up fetch + would-be normal-pass fetch). Reconciliation still
    // needs the register's `stale` flag, which the baseline path doesn't
    // surface — `computeReviewTargetsSnapshot` is called below regardless,
    // but it's a cache hit against `fetchBankRegister`'s 120s cache (same
    // account+date-range key, computed moments ago), not a second live QBO
    // call.
    const snapshot = await computeReviewTargetsSnapshot(now);
    const targets = baseline.ranBaseline && baseline.catchUpTargets ? baseline.catchUpTargets : snapshot.targets;

    for (const target of targets) {
        await evaluateReviewIssue(target.targetType, target.targetKey, target.reasonCodes, target.displayDetails, {
            recomputeCodes: () => recomputeCodesFor(target.targetKey, now),
        });
    }

    const reconciled = await reconcileMissingTargets(new Set(targets.map(t => t.targetKey)), snapshot.stale, now);

    return { ran: true, evaluated: targets.length, baseline, reconciled };
}

/** Baseline-only entry point (finding 1): runnable regardless of
 * `REVIEW_ALERTS_ENABLED` so the baseline sweep can complete BEFORE alerts
 * are ever turned on — the plan's own stated order ("apply schema → deploy
 * evaluator disabled → baseline → catch-up → enable") was operationally
 * impossible before this existed, because the only two callers of
 * `ensureRolloutBaseline` were both gated behind that flag. See
 * scripts/run-review-alerts-baseline.ts. */
export async function runReviewAlertsBaseline(now: Date = new Date()): Promise<EnsureRolloutBaselineResult> {
    return ensureRolloutBaseline({ computeReviewTargets: () => computeReviewTargets(now) });
}

/** Best-effort — callers (qbo-expense-sync.ts) must wrap this in try/catch so
 * a review-alert failure never blocks or fails the money sync it rides
 * alongside. Finding 5: callers must ALSO schedule this via `after()` rather
 * than awaiting it inline — see qbo-expense-sync.ts's call site — this
 * function itself still does the full sweep (the cheapest correct target set
 * without a register-row shape that only the report fetch produces; see the
 * implementation report for the fuller trade-off discussion), it just must
 * never block the money-sync response. */
export async function evaluateReviewAlertsPostSync(): Promise<EvaluateReviewAlertsResult> {
    return runEvaluation();
}

/** Periodic backstop — same work as the post-sync path, see this module's
 * header for why re-sweeping (not diffing) is the point. */
export async function evaluateReviewAlertsBackstop(): Promise<EvaluateReviewAlertsResult> {
    return runEvaluation();
}
