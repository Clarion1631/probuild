import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { evaluateReviewIssue, type EvaluateReviewIssueResult } from "@/lib/review-alert-lifecycle";
import type { ReasonCode } from "@/lib/review-alert-reasons";
import {
    DEAD_INTAKE_STATES,
    RECEIPT_MATCH_DATE_SLOP_DAYS,
    RECEIPT_REQUEST_TARGET_TYPE,
    decimalStringToCents,
    hasResolution,
    mergeReceiptRequestDetails,
    planReceiptRequests,
    type ReceiptRequestPlan,
} from "@/lib/receipt-requests";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Nightly missing-receipt request sweep (Phase 2 §5).
 *
 * Runs at 13:00 UTC (6 AM Pacific), AFTER `/api/cron/bank-register-pull`
 * (02:00 UTC) has landed last night's QBO register observations — that
 * ordering is why the pull was built first. The external
 * `scripts/post-qbo-register.mjs` runner is now a manual backfill tool, not a
 * dependency of this run.
 *
 * It opens/closes `ReviewIssue` rows on `targetType:"bank-line"` and NOTHING
 * else. It never advances `BankLine.state`, never writes a link, never touches
 * an Expense. Idempotency is structural: `@@unique([targetType,targetKey])`
 * plus the lifecycle's same-hash "touch" step, so two runs over identical data
 * create zero new issues and zero new episodes.
 *
 * `episodeStatus: "SUPPRESSED"` keeps these OUT of `drainReviewAlerts`. That
 * drainer sends one card per issue — one Chat card per unmatched bank line is
 * exactly the noise this feature exists to avoid — and it is gated by the
 * qbo-purchase `RolloutGate`, which must not quietly acquire a second meaning.
 * Delivery is the per-owner digest in `/api/cron/receipt-request-cards`.
 *
 * OVERLAP SAFETY: `pg_try_advisory_xact_lock` in one short claim transaction
 * (pgbouncer forbids session-scoped advisory locks).
 */

const CLAIM_LOCK_KEY = "receipt-requests";

/** How far back the sweep looks for chaseable debits. */
export const LOOKBACK_DAYS = 60;

/** Belt-and-braces cap: a runaway query must not turn into thousands of writes. */
const MAX_BANK_LINES = 2_000;

async function claim(): Promise<boolean> {
    return prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
        );
        return lock?.locked === true;
    });
}

export interface ReceiptRequestApplySummary {
    opened: number;
    closed: number;
    touched: number;
    skipped: number;
}

export type EvaluateFn = (
    targetKey: string,
    codes: ReasonCode[],
    displayDetails: Record<string, unknown> | null,
) => Promise<EvaluateReviewIssueResult>;

/**
 * Apply a plan through the review-issue lifecycle. Injected `evaluate` so the
 * "two runs, zero new issues" promise is testable against the REAL lifecycle
 * with an in-memory client, rather than asserted from the source text.
 *
 * A single target's failure is reported, not thrown: one bad row must not
 * abandon the rest of the night's sweep.
 */
export async function applyReceiptRequestPlan(
    plan: ReceiptRequestPlan,
    evaluate: EvaluateFn,
): Promise<ReceiptRequestApplySummary> {
    const summary: ReceiptRequestApplySummary = { opened: 0, closed: 0, touched: 0, skipped: 0 };

    for (const item of plan.open) {
        try {
            const { decision } = await evaluate(item.targetKey, ["MISSING_RECEIPT"], item.displayDetails);
            if (decision.action === "create" || decision.action === "reopen") summary.opened++;
            else if (decision.action === "noop") summary.skipped++;
            else summary.touched++;
        } catch (error) {
            summary.skipped++;
            console.error("[cron/receipt-requests] open failed", item.targetKey, error instanceof Error ? error.message : "UnknownError");
        }
    }

    for (const targetKey of plan.close) {
        try {
            const { decision } = await evaluate(targetKey, [], null);
            if (decision.action === "clear") summary.closed++;
            else summary.skipped++;
        } catch (error) {
            summary.skipped++;
            console.error("[cron/receipt-requests] close failed", targetKey, error instanceof Error ? error.message : "UnknownError");
        }
    }

    return summary;
}

/** UTC calendar-day arithmetic — a posted date is a day, not an instant. */
function ymdDaysBefore(now: Date, days: number): string {
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await claim())) {
        return NextResponse.json({ ok: true, skipped: "locked" });
    }

    const now = new Date();
    const windowStart = ymdDaysBefore(now, LOOKBACK_DAYS);
    const windowEnd = now.toISOString().slice(0, 10);
    // Evidence is searched ±2 days around the window, because that is the
    // widest date disagreement the matcher will accept.
    const evidenceStart = new Date(`${ymdDaysBefore(now, LOOKBACK_DAYS + RECEIPT_MATCH_DATE_SLOP_DAYS)}T00:00:00Z`);
    const evidenceEnd = new Date(`${ymdDaysBefore(now, -RECEIPT_MATCH_DATE_SLOP_DAYS)}T00:00:00Z`);

    // Every bank-line issue, open OR cleared. The open ones say what may need
    // closing; the cleared ones carry resolutions that must not be re-asked.
    const allIssues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE },
        select: { targetKey: true, clearedAt: true, displayDetails: true },
    });
    const openIssues = allIssues.filter(issue => issue.clearedAt === null);
    const resolvedIssueKeys = allIssues
        .filter(issue => hasResolution(parseMissingReceiptDetails(issue.displayDetails)))
        .map(issue => issue.targetKey);

    // Dates the evidence search must cover no matter how old: an open issue's
    // bank line may be far outside the lookback, and the receipt that finally
    // answers it is dated near THAT line, not near today (item 8).
    const openIssueLineRows = openIssues.length === 0 ? [] : await prisma.bankLine.findMany({
        where: { id: { in: openIssues.map(issue => issue.targetKey) } },
        select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
    });
    const openIssueDateRanges = openIssueLineRows.map(row => {
        const day = row.postedDate.getTime();
        return {
            gte: new Date(day - RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000),
            lte: new Date(day + RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000),
        };
    });
    const evidenceDateWhere = openIssueDateRanges.length === 0
        ? { date: { gte: evidenceStart, lte: evidenceEnd } }
        : { OR: [{ date: { gte: evidenceStart, lte: evidenceEnd } }, ...openIssueDateRanges.map(range => ({ date: range }))] };
    const intakeDateWhere = openIssueDateRanges.length === 0
        ? { txnDate: { gte: evidenceStart, lte: evidenceEnd } }
        : { OR: [{ txnDate: { gte: evidenceStart, lte: evidenceEnd } }, ...openIssueDateRanges.map(range => ({ txnDate: range }))] };

    const [windowLines, expenseRows, intakeRows] = await Promise.all([
        prisma.bankLine.findMany({
            where: { postedDate: { gte: new Date(`${windowStart}T00:00:00Z`) }, amountCents: { lt: 0 } },
            orderBy: { postedDate: "desc" },
            take: MAX_BANK_LINES,
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.expense.findMany({
            where: evidenceDateWhere,
            select: { id: true, amount: true, date: true, vendor: true, qbPurchaseId: true },
        }),
        prisma.receiptIntake.findMany({
            where: { ...intakeDateWhere, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: { id: true, totalCents: true, txnDate: true, vendor: true, state: true, expenseId: true, qbPurchaseId: true },
        }),
    ]);

    // De-duplicate: an in-window line that also has an open issue appears twice.
    const bankLineRows = [...new Map([...windowLines, ...openIssueLineRows].map(row => [row.id, row])).values()];

    const plan = planReceiptRequests({
        bankLines: bankLineRows.map(row => ({
            id: row.id,
            postedDate: row.postedDate.toISOString().slice(0, 10),
            amountCents: row.amountCents,
            rawDescriptor: row.rawDescriptor,
            checkNumber: row.checkNumber,
        })),
        // Decimal → cents from the STRING form. Number(d) * 100 is a float bug
        // on ordinary receipt totals (19.99 → 1998.9999999999998).
        expenses: expenseRows.flatMap(row => {
            const cents = decimalStringToCents(row.amount.toString());
            if (cents === null) return [];
            return [{ id: row.id, qbPurchaseId: row.qbPurchaseId, amountCents: cents, date: row.date ? row.date.toISOString().slice(0, 10) : null, vendor: row.vendor }];
        }),
        intakes: intakeRows.map(row => ({
            id: row.id,
            expenseId: row.expenseId,
            qbPurchaseId: row.qbPurchaseId,
            totalCents: row.totalCents,
            txnDate: row.txnDate ? row.txnDate.toISOString().slice(0, 10) : null,
            vendor: row.vendor,
            state: row.state,
        })),
        openIssueKeys: openIssues.map(row => row.targetKey),
        resolvedIssueKeys,
        now,
    });

    // displayDetails is MERGED, never replaced, and merged from a FRESH read
    // taken per issue rather than from the run-start snapshot.
    //
    // The sweep loads everything up front and then works through it. A memo
    // signed while that loop is running (the answers endpoint writes the
    // resolution and clears the issue) would be invisible to a snapshot taken
    // minutes earlier — so the reopen would go through and the merge would
    // write the STALE details back over the resolution, un-answering something
    // a human just answered. Re-reading immediately before each write closes
    // that window; `evaluateReviewIssue` then applies its own OCC on top.
    const summary = await applyReceiptRequestPlan(plan, async (targetKey, codes, displayDetails) => {
        const fresh = await prisma.reviewIssue.findUnique({
            where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey } },
            select: { displayDetails: true, clearedAt: true },
        });
        const freshDetails = parseMissingReceiptDetails(fresh?.displayDetails ?? null);

        // A resolution that appeared since the snapshot: do not reopen.
        if (codes.length > 0 && hasResolution(freshDetails)) {
            return { decision: { step: 1, action: "noop", canonicalCodes: [], reasonHash: "" }, applied: false };
        }

        return evaluateReviewIssue(
            RECEIPT_REQUEST_TARGET_TYPE,
            targetKey,
            codes,
            displayDetails ? mergeReceiptRequestDetails(freshDetails, displayDetails) : null,
            // Delivery is the per-owner digest, never the per-issue drainer.
            { episodeStatus: "SUPPRESSED" },
        );
    });

    const result = {
        ok: true,
        window: { start: windowStart, end: windowEnd },
        bankLines: bankLineRows.length,
        candidates: plan.open.length,
        ...summary,
    };
    if (summary.opened > 0 || summary.closed > 0) {
        console.log("[cron/receipt-requests]", JSON.stringify(result));
    }
    return NextResponse.json(result);
}
