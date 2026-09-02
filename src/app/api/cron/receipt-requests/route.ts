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

    const [windowLines, openIssueLines, expenseRows, intakeRows] = await Promise.all([
        prisma.bankLine.findMany({
            where: { postedDate: { gte: new Date(`${windowStart}T00:00:00Z`) }, amountCents: { lt: 0 } },
            orderBy: { postedDate: "desc" },
            take: MAX_BANK_LINES,
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        // ALWAYS loaded, regardless of age. An issue opened 90 days ago falls
        // out of the window, and a line the matcher cannot see is a line it can
        // never CLOSE — the chase would nag forever after the receipt turned up.
        openIssues.length === 0 ? Promise.resolve([]) : prisma.bankLine.findMany({
            where: { id: { in: openIssues.map(issue => issue.targetKey) } },
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.expense.findMany({
            where: { date: { gte: evidenceStart, lte: evidenceEnd } },
            select: { id: true, amount: true, date: true, vendor: true },
        }),
        prisma.receiptIntake.findMany({
            where: {
                txnDate: { gte: evidenceStart, lte: evidenceEnd },
                state: { notIn: [...DEAD_INTAKE_STATES] },
            },
            select: { id: true, totalCents: true, txnDate: true, vendor: true, state: true },
        }),
    ]);

    // De-duplicate: an in-window line that also has an open issue appears twice.
    const bankLineRows = [...new Map([...windowLines, ...openIssueLines].map(row => [row.id, row])).values()];

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
            return [{ id: row.id, amountCents: cents, date: row.date ? row.date.toISOString().slice(0, 10) : null, vendor: row.vendor }];
        }),
        intakes: intakeRows.map(row => ({
            id: row.id,
            totalCents: row.totalCents,
            txnDate: row.txnDate ? row.txnDate.toISOString().slice(0, 10) : null,
            vendor: row.vendor,
            state: row.state,
        })),
        openIssueKeys: openIssues.map(row => row.targetKey),
        resolvedIssueKeys,
        now,
    });

    // displayDetails is MERGED, never replaced. The matcher owns the facts about
    // the charge and recomputes them nightly; the resolution and the Chat card
    // history are ANSWERS written by other paths, and overwriting them would
    // silently delete a signed memo's PDF link and the threads the sweep needs
    // to find replies in.
    const detailsByKey = new Map(allIssues.map(issue => [issue.targetKey, parseMissingReceiptDetails(issue.displayDetails)]));

    const summary = await applyReceiptRequestPlan(plan, (targetKey, codes, displayDetails) =>
        evaluateReviewIssue(
            RECEIPT_REQUEST_TARGET_TYPE,
            targetKey,
            codes,
            displayDetails ? mergeReceiptRequestDetails(detailsByKey.get(targetKey), displayDetails) : null,
            // Delivery is the per-owner digest, never the per-issue drainer.
            { episodeStatus: "SUPPRESSED" },
        ));

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
