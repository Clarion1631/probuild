import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { releaseLease, takeLease } from "@/lib/cron-lease";
import { evaluateReviewIssue, type EvaluateReviewIssueResult } from "@/lib/review-alert-lifecycle";
import type { ReasonCode } from "@/lib/review-alert-reasons";
import {
    DEAD_INTAKE_STATES,
    RECEIPT_MATCH_DATE_SLOP_DAYS,
    RECEIPT_REQUEST_TARGET_TYPE,
    decimalStringToCents,
    competingLineFilter,
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

/**
 * How many lines ONE run processes. Not a silent ceiling: what does not fit is
 * resumed from a durable cursor on the next run (see readCursor).
 */
const MAX_BANK_LINES = 2_000;

/**
 * How long one run owns the sweep. Longer than a maxDuration=60 run can
 * possibly take, so a lease that is still live means a run is still going;
 * short enough that a crashed run does not block tonight's sweep.
 */
const RUN_LEASE_MS = 15 * 60_000;

/** Where the lease and the resume cursor live (AutomationSetting is a KV table). */
const LEASE_KEY = "receiptRequestsRunLease";
const CURSOR_KEY = "receiptRequestsCursor";

/** The resume cursor: the last BankLine id this sweep finished, oldest-first. */
async function readCursor(): Promise<string | null> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: CURSOR_KEY } });
        return row?.value ? row.value : null;
    } catch {
        return null;
    }
}

async function writeCursor(value: string | null): Promise<void> {
    try {
        await prisma.automationSetting.upsert({
            where: { key: CURSOR_KEY },
            update: { value: value ?? "" },
            create: { key: CURSOR_KEY, value: value ?? "" },
        });
    } catch (error) {
        console.error("[cron/receipt-requests] cursor write failed", error instanceof Error ? error.message : "UnknownError");
    }
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

/**
 * Re-derive one line's verdict from CURRENT data (Codex round-3 finding 5).
 *
 * Deliberately narrower than the batch: it sees only this line, so it cannot
 * observe another line competing for the same receipt. That makes it slightly
 * MORE likely to close than the batch would be — the safe direction on a retry
 * path, since the next full sweep reopens anything it got wrong, whereas a
 * wrongly-reapplied stale open nags a human tonight.
 */
async function recomputeCodesFor(targetKey: string): Promise<ReasonCode[]> {
    const [line, issue] = await Promise.all([
        prisma.bankLine.findUnique({
            where: { id: targetKey },
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.reviewIssue.findUnique({
            where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey } },
            select: { displayDetails: true },
        }),
    ]);
    // A line that no longer exists cannot owe a receipt.
    if (!line) return [];
    // An answered issue is never re-asked.
    if (hasResolution(parseMissingReceiptDetails(issue?.displayDetails ?? null))) return [];

    // THE COMPLETE COMPETING SET, not this line alone. One-to-one assignment is
    // a property of the batch: two identical charges and one receipt resolve
    // differently depending on which is considered first, so recomputing one
    // row in isolation saw "a receipt exists" and closed a charge whose receipt
    // had already been given to its twin.
    const competing = competingLineFilter({
        amountCents: line.amountCents,
        postedDate: line.postedDate.toISOString().slice(0, 10),
    });
    const from = new Date(`${competing.from}T00:00:00Z`);
    const to = new Date(`${competing.to}T00:00:00Z`);

    const [lines, expenseRows, intakeRows] = await Promise.all([
        prisma.bankLine.findMany({
            where: { amountCents: competing.amountCents, postedDate: { gte: from, lte: to } },
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.expense.findMany({
            where: { date: { gte: from, lte: to } },
            select: {
                id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                receiptUrl: true, receiptIntake: { select: { id: true } },
            },
        }),
        prisma.receiptIntake.findMany({
            where: { txnDate: { gte: from, lte: to }, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: { id: true, totalCents: true, txnDate: true, vendor: true, state: true, expenseId: true, qbPurchaseId: true },
        }),
    ]);

    // Resolutions across the whole competing set, so a sibling's signed memo
    // does not get re-asked just because we came in through a retry.
    const siblingIssues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: { in: lines.map(l => l.id) } },
        select: { targetKey: true, clearedAt: true, displayDetails: true },
    });

    const plan = planReceiptRequests({
        bankLines: lines.map(row => ({
            id: row.id,
            postedDate: row.postedDate.toISOString().slice(0, 10),
            amountCents: row.amountCents,
            rawDescriptor: row.rawDescriptor,
            checkNumber: row.checkNumber,
        })),
        expenses: expenseRows.flatMap(row => {
            const cents = decimalStringToCents(row.amount.toString());
            if (cents === null) return [];
            return [{
                id: row.id,
                qbPurchaseId: row.qbPurchaseId,
                hasReceipt: !!row.receiptUrl || row.receiptIntake !== null,
                amountCents: cents,
                date: row.date ? row.date.toISOString().slice(0, 10) : null,
                vendor: row.vendor,
            }];
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
        openIssueKeys: siblingIssues.filter(i => i.clearedAt === null).map(i => i.targetKey),
        resolvedIssueKeys: siblingIssues
            .filter(i => hasResolution(parseMissingReceiptDetails(i.displayDetails)))
            .map(i => i.targetKey),
        now: new Date(),
    });
    // Only OUR line's verdict is returned; the rest of the set was recomputed
    // so that verdict is the one the batch would have reached.
    return plan.open.some(o => o.targetKey === targetKey) ? ["MISSING_RECEIPT"] : [];
}

/** UTC calendar-day arithmetic — a posted date is a day, not an instant. */
function ymdDaysBefore(now: Date, days: number): string {
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const now = new Date();
    // A DURABLE lease, held for the whole reconciliation. The old advisory
    // claim released before any work began and excluded nothing.
    const leaseToken = randomUUID();
    if (!(await takeLease(LEASE_KEY, RUN_LEASE_MS, now, leaseToken))) {
        return NextResponse.json({ ok: true, skipped: "already-running" });
    }
    try {
        return await runSweep(now);
    } finally {
        await releaseLease(LEASE_KEY, leaseToken);
    }
}

async function runSweep(now: Date) {
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

    // OLDEST-FIRST, FROM A DURABLE CURSOR. `take: MAX_BANK_LINES` ordered
    // newest-first silently abandoned candidates: an older never-seen line sat
    // behind the cap until it aged out of the window entirely, so "one issue
    // per unmatched debit" was quietly false. This resumes where the last run
    // stopped and processes the oldest work first; if the batch fills, the
    // cursor persists and the next run continues rather than starting over.
    const resumeFrom = await readCursor();
    const [windowLines, expenseRows, intakeRows] = await Promise.all([
        prisma.bankLine.findMany({
            where: { postedDate: { gte: new Date(`${windowStart}T00:00:00Z`) }, amountCents: { lt: 0 } },
            orderBy: [{ postedDate: "asc" }, { id: "asc" }],
            take: MAX_BANK_LINES,
            ...(resumeFrom ? { cursor: { id: resumeFrom }, skip: 1 } : {}),
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.expense.findMany({
            where: evidenceDateWhere,
            select: {
                id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                receiptUrl: true,
                // A linked intake IS a receipt: the row only exists because a
                // document was uploaded and read.
                receiptIntake: { select: { id: true } },
            },
        }),
        prisma.receiptIntake.findMany({
            where: { ...intakeDateWhere, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: { id: true, totalCents: true, txnDate: true, vendor: true, state: true, expenseId: true, qbPurchaseId: true },
        }),
    ]);

    // THE COMPLETE COHORT, not just this page.
    //
    // Paging split competing lines across runs: a receipt allocated to a line
    // on page 1 was invisible on page 2, so the same receipt satisfied a second
    // charge and that charge's chase was closed for good. Allocation is a
    // property of every line sharing an identity, so the page is EXPANDED to
    // include its cohort — same amount, within twice the match window — before
    // the matcher ever runs. Extra lines are harmless: each still gets its own
    // correct verdict, and re-emitting an unchanged one is a lifecycle touch.
    const cohortFilters = windowLines.map(row => competingLineFilter({
        amountCents: row.amountCents,
        postedDate: row.postedDate.toISOString().slice(0, 10),
    }));
    const cohortRows = cohortFilters.length === 0 ? [] : await prisma.bankLine.findMany({
        where: {
            OR: cohortFilters.map(f => ({
                amountCents: f.amountCents,
                postedDate: { gte: new Date(`${f.from}T00:00:00Z`), lte: new Date(`${f.to}T00:00:00Z`) },
            })),
        },
        select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
    });

    // De-duplicate: a line can arrive from the page, its cohort, and the
    // open-issue set all at once.
    const bankLineRows = [...new Map(
        [...windowLines, ...cohortRows, ...openIssueLineRows].map(row => [row.id, row]),
    ).values()];

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
            return [{
                id: row.id,
                qbPurchaseId: row.qbPurchaseId,
                hasReceipt: !!row.receiptUrl || row.receiptIntake !== null,
                amountCents: cents,
                date: row.date ? row.date.toISOString().slice(0, 10) : null,
                vendor: row.vendor,
            }];
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
            {
                // Delivery is the per-owner digest, never the per-issue drainer.
                episodeStatus: "SUPPRESSED",
                // RECOMPUTE ON OCC RETRY, never reapply the snapshot.
                //
                // The advisory claim above is transaction-scoped and released
                // before any work, so two sweeps CAN overlap. A version
                // conflict means someone else just committed to this exact row
                // — replaying our minutes-old verdict could let a stale OPEN
                // win over a newer CLOSE, or write details back over a
                // signature that landed in between. This re-derives the verdict
                // for this ONE line from current data instead. Returning []
                // routes through the lifecycle's clear step, which does not
                // touch displayDetails, so a concurrent resolution survives.
                recomputeCodes: () => recomputeCodesFor(targetKey),
            },
        );
    });

    // A FULL batch means there is more behind it: remember where we stopped.
    // A short batch means the window is exhausted, so the next run starts over
    // from the oldest line — which is what re-checks everything for closes.
    const batchWasFull = windowLines.length === MAX_BANK_LINES;
    const lastId = windowLines.length > 0 ? windowLines[windowLines.length - 1].id : null;
    await writeCursor(batchWasFull ? lastId : null);

    const result = {
        ok: true,
        window: { start: windowStart, end: windowEnd },
        resumedFrom: resumeFrom,
        moreToProcess: batchWasFull,
        bankLines: bankLineRows.length,
        candidates: plan.open.length,
        ...summary,
    };
    if (summary.opened > 0 || summary.closed > 0) {
        console.log("[cron/receipt-requests]", JSON.stringify(result));
    }
    return NextResponse.json(result);
}
