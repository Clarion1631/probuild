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
import { evaluateReviewIssue } from "./review-alert-lifecycle";
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
export async function computeReviewTargets(now: Date = new Date()): Promise<ReviewTarget[]> {
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
    return targets;
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

/** Prisma-shaped subset for listing open issue keys — separate from
 * `ReviewIssueLifecycleClient` (that one is about single-row transitions,
 * this is a plain list read for reconciliation, finding 8). */
interface OpenIssueKeyLister {
    reviewIssue: {
        findMany(args: {
            where: { targetType: string; clearedAt: null };
            select: { targetKey: true };
        }): Promise<Array<{ targetKey: string }>>;
    };
}

/**
 * Finding 8 (part 2): a purchase deleted in QBO, retyped off this
 * evaluator's domain, or simply aged past the trailing WINDOW_DAYS window
 * stops appearing in `computeReviewTargets()` entirely — with no
 * reconciliation, its ReviewIssue (if still open) would never receive the
 * `[]` "clear" evaluation and would stay open forever.
 *
 * Age-out policy: immediate, based on full-snapshot absence. Every call to
 * `computeReviewTargets` re-derives the ENTIRE trailing window from scratch
 * (no pagination, no delta) and `fetchBankRegister` fails CLOSED — throws —
 * on a QBO error rather than silently returning a partial row set (see its
 * own header). A *successful* sweep is therefore a trustworthy full
 * snapshot, so an open issue whose key is absent from it is cleared on the
 * very next sweep rather than requiring a grace period tracked across runs
 * (which would need a new "last seen" column — out of scope here; flagged in
 * the implementation report for arbitration).
 */
async function reconcileMissingTargets(
    presentKeys: ReadonlySet<string>,
    now: Date,
    client: OpenIssueKeyLister = prisma as unknown as OpenIssueKeyLister,
): Promise<number> {
    const openIssues = await client.reviewIssue.findMany({
        where: { targetType: TARGET_TYPE, clearedAt: null },
        select: { targetKey: true },
    });
    let cleared = 0;
    for (const issue of openIssues) {
        if (presentKeys.has(issue.targetKey)) continue;
        await evaluateReviewIssue(TARGET_TYPE, issue.targetKey, [], null, { now: () => now });
        cleared++;
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
    // catch-up pass already computed a fresh target snapshot — reuse it
    // instead of fetching a third time (baseline fetch + catch-up fetch +
    // would-be normal-pass fetch).
    const targets = baseline.ranBaseline && baseline.catchUpTargets ? baseline.catchUpTargets : await computeReviewTargets(now);

    for (const target of targets) {
        await evaluateReviewIssue(target.targetType, target.targetKey, target.reasonCodes, target.displayDetails, {
            recomputeCodes: () => recomputeCodesFor(target.targetKey, now),
        });
    }

    const reconciled = await reconcileMissingTargets(new Set(targets.map(t => t.targetKey)), now);

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
