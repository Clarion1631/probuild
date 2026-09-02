import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { resolveCompanyTimeZone, startOfDateInTimeZone } from "@/lib/company-timezone";
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



/** How far back the sweep looks for chaseable debits. */
export const LOOKBACK_DAYS = 60;

/**
 * Lines per BATCH. Small on purpose: the cursor is checkpointed after each one,
 * so a run that dies mid-sweep loses at most this much progress, and the
 * cohort/evidence queries for a batch stay a size Postgres can answer fast.
 */
const BATCH_SIZE = 200;

/**
 * Wall-clock budget for one invocation. `maxDuration` is 60s; stopping at 45
 * leaves room to checkpoint the cursor and return a real answer instead of
 * being killed mid-write with nothing recorded. The cron runs every 15 minutes,
 * so a backlog drains over several invocations rather than in one heroic run.
 */
const RUN_BUDGET_MS = 45_000;

/**
 * How long one run owns the sweep. Longer than a maxDuration=60 run can
 * possibly take, so a lease that is still live means a run is still going;
 * short enough that a crashed run does not block tonight's sweep.
 */
const RUN_LEASE_MS = 15 * 60_000;

/** Where the lease and the resume cursor live (AutomationSetting is a KV table). */
const LEASE_KEY = "receiptRequestsRunLease";
const CURSOR_KEY = "receiptRequestsCursor";
/** The open-issue pass keeps its OWN resume point; sharing one would corrupt both. */
const OPEN_CURSOR_KEY = "receiptRequestsOpenIssueCursor";
/** Open issues per batch. Smaller than the line batch: each one costs a lookup. */
const OPEN_ISSUE_BATCH_SIZE = 100;

/** The resume cursor: the last BankLine id this sweep finished, oldest-first. */
async function readCursor(): Promise<string | null> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: CURSOR_KEY } });
        return row?.value ? row.value : null;
    } catch {
        return null;
    }
}

/**
 * Thrown when the resume cursor cannot be persisted.
 *
 * A swallowed cursor write is the worst failure this sweep has: the batch's
 * work committed, the checkpoint did not, so the NEXT run redoes the same
 * ground — and if the write keeps failing, the sweep never advances past batch
 * one while reporting a cheerful 200 every time. The run must fail loudly
 * instead.
 */
class CursorWriteError extends Error {
    constructor(cause: string) {
        super(`cursor write failed: ${cause}`);
        this.name = "CursorWriteError";
    }
}

async function readOpenCursor(): Promise<string | null> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: OPEN_CURSOR_KEY } });
        return row?.value ? row.value : null;
    } catch {
        return null;
    }
}

async function writeOpenCursor(value: string | null): Promise<void> {
    try {
        await prisma.automationSetting.upsert({
            where: { key: OPEN_CURSOR_KEY },
            update: { value: value ?? "" },
            create: { key: OPEN_CURSOR_KEY, value: value ?? "" },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "UnknownError";
        console.error("[cron/receipt-requests] open-issue cursor write failed", message);
        throw new CursorWriteError(message);
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
        const message = error instanceof Error ? error.message : "UnknownError";
        console.error("[cron/receipt-requests] cursor write failed", message);
        throw new CursorWriteError(message);
    }
}

export interface ReceiptRequestApplySummary {
    opened: number;
    closed: number;
    touched: number;
    /** Decisions the lifecycle declined to act on (a genuine no-op). */
    skipped: number;
    /**
     * Targets whose write THREW. Counted as errors, never folded into
     * `skipped` — a failure and a no-op look identical in a count, and folding
     * them together is how a broken night reported "0 errors, all quiet".
     */
    errors: number;
    /** The targets behind `errors`. The cursor must not advance past these. */
    failedTargets: string[];
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
 * A single target's failure does not abandon the rest of the night's sweep —
 * but it IS retained. It is reported in `failedTargets`, counted in `errors`,
 * and the caller must neither advance its cursor past it nor call the run a
 * success. Previously a throw was swallowed into `skipped` and the cursor moved
 * on regardless, so a row that failed every night was silently never chased.
 */
export async function applyReceiptRequestPlan(
    plan: ReceiptRequestPlan,
    evaluate: EvaluateFn,
): Promise<ReceiptRequestApplySummary> {
    const summary: ReceiptRequestApplySummary = {
        opened: 0, closed: 0, touched: 0, skipped: 0, errors: 0, failedTargets: [],
    };

    for (const item of plan.open) {
        try {
            const { decision } = await evaluate(item.targetKey, ["MISSING_RECEIPT"], item.displayDetails);
            if (decision.action === "create" || decision.action === "reopen") summary.opened++;
            else if (decision.action === "noop") summary.skipped++;
            else summary.touched++;
        } catch (error) {
            summary.errors++;
            summary.failedTargets.push(item.targetKey);
            console.error("[cron/receipt-requests] open failed", item.targetKey, error instanceof Error ? error.message : "UnknownError");
        }
    }

    for (const targetKey of plan.close) {
        try {
            const { decision } = await evaluate(targetKey, [], null);
            if (decision.action === "clear") summary.closed++;
            else summary.skipped++;
        } catch (error) {
            summary.errors++;
            summary.failedTargets.push(targetKey);
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
    const range = await evidenceRange(competing.from, competing.to);

    const [lines, expenseRows, intakeRows] = await Promise.all([
        prisma.bankLine.findMany({
            where: { amountCents: competing.amountCents, postedDate: range },
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.expense.findMany({
            where: { date: range },
            select: {
                id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                receiptUrl: true, receiptIntake: { select: { id: true } },
            },
        }),
        prisma.receiptIntake.findMany({
            where: { txnDate: range, state: { notIn: [...DEAD_INTAKE_STATES] } },
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
        // The cohort query below loaded exactly [from, to], so declare it: a
        // line whose window pokes outside that emits no decision rather than a
        // guess (item 8).
        evidenceLoadedFrom: competing.from,
        evidenceLoadedTo: competing.to,
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


interface BatchLine {
    id: string;
    postedDate: Date;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
}

/**
 * One batch: build the COHORT, load evidence for the cohort's full span, then
 * decide. In that order, and the order is the point.
 *
 * Deciding before the evidence is in — or with a window narrower than the lines
 * being judged — means "no receipt found" can only mean "we did not look", and
 * that opens a chase for a charge that is perfectly well documented. So the
 * cohort is resolved first (every line that could claim the same evidence,
 * regardless of which page it fell on), the evidence query is widened to that
 * cohort's whole date span ±2 days, and `evidenceLoadedFrom/To` tells the
 * matcher exactly what was loaded so it can decline to judge anything outside.
 */
async function processBatch(
    batch: BatchLine[],
    openIssues: Array<{ targetKey: string }>,
    resolvedIssueKeys: string[],
    detailsByKey: Map<string, Record<string, unknown>>,
    now: Date,
): Promise<{ summary: ReceiptRequestApplySummary; undecided: number }> {
    // 1. THE COHORT.
    const cohortFilters = batch.map(row => competingLineFilter({
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

    // Open-issue lines are NOT bolted on here any more — they get their own
    // pass (see runSweep). Loading every one of them into every batch made each
    // batch's evidence window span the whole backlog, which is exactly what
    // made batching pointless.
    const lines = [...new Map(
        [...batch, ...cohortRows].map(row => [row.id, row]),
    ).values()];
    if (lines.length === 0) {
        return { summary: { opened: 0, closed: 0, touched: 0, skipped: 0, errors: 0, failedTargets: [] }, undecided: 0 };
    }

    // 2. EVIDENCE FOR THE COHORT'S FULL SPAN, widened by the match window.
    const days = lines.map(row => row.postedDate.getTime());
    const fromYmd = new Date(Math.min(...days) - RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
    const toYmd = new Date(Math.max(...days) + RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
    // HALF-OPEN, company timezone. See evidenceRange.
    const range = await evidenceRange(fromYmd, toYmd);

    const [expenseRows, intakeRows] = await Promise.all([
        prisma.expense.findMany({
            where: { date: range },
            select: {
                id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                receiptUrl: true, receiptIntake: { select: { id: true } },
            },
        }),
        prisma.receiptIntake.findMany({
            where: { txnDate: range, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: { id: true, totalCents: true, txnDate: true, vendor: true, state: true, expenseId: true, qbPurchaseId: true },
        }),
    ]);

    // 3. DECIDE.
    const plan = planReceiptRequests({
        bankLines: lines.map(row => ({
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
        evidenceLoadedFrom: fromYmd,
        evidenceLoadedTo: toYmd,
        now,
    });

    const summary = await applyReceiptRequestPlan(plan, async (targetKey, codes, displayDetails) => {
        // FRESH READ before each write. The sweep can run for minutes; a memo
        // signed in that window would otherwise be un-answered by a merge from
        // the run-start snapshot.
        const fresh = await prisma.reviewIssue.findUnique({
            where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey } },
            select: { displayDetails: true, clearedAt: true },
        });
        const freshDetails = fresh
            ? parseMissingReceiptDetails(fresh.displayDetails)
            : detailsByKey.get(targetKey) ?? {};

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
                // On an OCC retry, re-derive from the COMPLETE competing set
                // rather than replaying a stale verdict.
                recomputeCodes: () => recomputeCodesFor(targetKey),
            },
        );
    });

    return { summary, undecided: plan.undecided.length };
}


/**
 * The evidence window, as a half-open range in the COMPANY's timezone.
 *
 * `lte: <a Date at UTC midnight>` silently excluded most of the last allowed
 * day: an expense stamped 14:00 on the 18th is after `2026-08-18T00:00:00Z`, so
 * a receipt filed in the afternoon of the last in-window day was invisible and
 * its charge got chased. And UTC is the wrong day boundary anyway — a receipt
 * uploaded at 5pm Pacific belongs to that Pacific day, not the next UTC one.
 *
 * So: start of the FIRST allowed day, inclusive; start of the day AFTER the
 * last allowed day, exclusive. Both resolved in the company's zone.
 */
async function evidenceRange(fromYmd: string, toYmd: string): Promise<{ gte: Date; lt: Date }> {
    const zone = await resolveCompanyTimeZone();
    const dayAfter = new Date(Date.parse(`${toYmd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return {
        gte: startOfDateInTimeZone(fromYmd, zone),
        lt: startOfDateInTimeZone(dayAfter, zone),
    };
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
    // `?continue=1` is the every-15-minutes RESUME pass. It does no work of its
    // own: if no cursor is parked it exits immediately, so the full sweep keeps
    // its one predictable 6 AM slot instead of re-deriving the world 96 times a
    // day. Checked BEFORE the lease so a resume pass with nothing to do cannot
    // even briefly block the real run.
    const continueOnly = new URL(request.url).searchParams.get("continue") === "1";
    if (continueOnly) {
        // BOTH cursors. The sweep has two independent passes with two resume
        // points, and asking only about the line cursor meant a half-finished
        // OPEN-ISSUE pass looked like nothing in progress — so the resume pass
        // exited and that backlog waited for tomorrow's full sweep.
        const [lineCursor, openCursor] = await Promise.all([readCursor(), readOpenCursor()]);
        if (!lineCursor && !openCursor) {
            return NextResponse.json({ ok: true, skipped: "nothing-in-progress" });
        }
    }

    const leaseToken = randomUUID();
    if (!(await takeLease(LEASE_KEY, RUN_LEASE_MS, now, leaseToken))) {
        return NextResponse.json({ ok: true, skipped: "already-running" });
    }
    try {
        return await runSweep(now);
    } catch (error) {
        // A cursor that will not persist is an INVOCATION ERROR, not a quiet
        // note in the log. Whatever this run committed stays committed, but the
        // checkpoint did not move — so the platform must show the run as failed
        // rather than reporting ok:true while the sweep silently redoes the
        // same batch forever.
        if (error instanceof CursorWriteError) {
            console.error("[cron/receipt-requests]", error.message);
            return NextResponse.json({ ok: false, error: "cursor-write-failed", detail: error.message }, { status: 500 });
        }
        throw error;
    } finally {
        await releaseLease(LEASE_KEY, leaseToken);
    }
}

async function runSweep(now: Date) {
    const windowStart = ymdDaysBefore(now, LOOKBACK_DAYS);
    const windowEnd = now.toISOString().slice(0, 10);

    // Every bank-line issue, open OR cleared. The open ones say what may need
    // closing; the cleared ones carry resolutions that must not be re-asked.
    const allIssues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE },
        select: { targetKey: true, clearedAt: true, displayDetails: true },
    });
    const openIssues = allIssues.filter(issue => issue.clearedAt === null);
    // ONE query for every issue in the sweep, parsed once and reused by every
    // batch — the bulk half of the lifecycle work. The per-issue FRESH read
    // before each write stays: it is what stops a memo signed mid-run from
    // being un-answered, and no amount of bulking is worth losing that.
    const detailsByKey = new Map(
        allIssues.map(issue => [issue.targetKey, parseMissingReceiptDetails(issue.displayDetails)]),
    );
    const resolvedIssueKeys = allIssues
        .filter(issue => hasResolution(parseMissingReceiptDetails(issue.displayDetails)))
        .map(issue => issue.targetKey);

    // OLDEST-FIRST, FROM A DURABLE CURSOR, IN TIME-BUDGETED BATCHES.
    //
    // One 2,000-line pass could not finish inside maxDuration on a real
    // backlog, and being killed mid-pass wrote no cursor at all — so the next
    // run started from the same place and died at the same point, forever. Now
    // each batch is small, the cursor is checkpointed after every one, and the
    // run exits cleanly when the budget is spent. The 15-minute schedule drains
    // whatever is left.
    const startedAt = Date.now();

    // PASS 1: EVERY OPEN ISSUE, every run, whatever the recent-line cursor says.
    //
    // The line cursor walks recent lines. An issue opened 90 days ago sits
    // behind it for the whole sweep, so the receipt that finally answers it
    // could arrive and the chase would keep nagging until the cursor happened
    // to lap round — which, with a `?continue=1` resume, might be never.
    // Closing is the half that must not depend on where the cursor is.
    //
    // PAGED, under the same wall clock, with its OWN checkpoint: a backlog of
    // open issues is exactly as capable of blowing the budget as a backlog of
    // lines, and sharing the line cursor would make each pass corrupt the
    // other's resume point.
    const openPass: ReceiptRequestApplySummary = {
        opened: 0, closed: 0, touched: 0, skipped: 0, errors: 0, failedTargets: [],
    };
    let openUndecided = 0;
    let openCursor = await readOpenCursor();
    let openExhausted = false;
    let openBatches = 0;
    let targetMissing = 0;

    while (Date.now() - startedAt < RUN_BUDGET_MS) {
        const page = await prisma.reviewIssue.findMany({
            where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null },
            orderBy: [{ firstObservedAt: "asc" }, { id: "asc" }],
            take: OPEN_ISSUE_BATCH_SIZE,
            ...(openCursor ? { cursor: { id: openCursor }, skip: 1 } : {}),
            select: { id: true, targetKey: true, displayDetails: true },
        });
        if (page.length === 0) { openExhausted = true; break; }
        openBatches++;

        const lines = await prisma.bankLine.findMany({
            where: { id: { in: page.map(issue => issue.targetKey) } },
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        });

        // AN ISSUE WHOSE BANK LINE IS GONE can never be answered: the matcher
        // has nothing to match, so it would be skipped forever and nag forever.
        // A deleted or re-imported statement line is a real thing that happens.
        // Close it with a reason a human can read rather than leaving a chase
        // pointing at nothing.
        const present = new Set(lines.map(line => line.id));
        const orphaned = page.filter(issue => !present.has(issue.targetKey));
        for (const issue of orphaned) {
            try {
                const details = detailsByKey.get(issue.targetKey) ?? {};
                await evaluateReviewIssue(
                    RECEIPT_REQUEST_TARGET_TYPE,
                    issue.targetKey,
                    [],
                    { ...details, resolution: "target-missing" },
                    { episodeStatus: "SUPPRESSED" },
                );
                openPass.closed++;
                targetMissing++;
            } catch (error) {
                openPass.errors++;
                openPass.failedTargets.push(issue.targetKey);
                console.error("[cron/receipt-requests] target-missing close failed", issue.targetKey,
                    error instanceof Error ? error.message : "UnknownError");
            }
        }

        if (lines.length > 0) {
            const outcome = await processBatch(
                lines,
                page.map(issue => ({ targetKey: issue.targetKey })),
                resolvedIssueKeys,
                detailsByKey,
                now,
            );
            openPass.opened += outcome.summary.opened;
            openPass.closed += outcome.summary.closed;
            openPass.touched += outcome.summary.touched;
            openPass.skipped += outcome.summary.skipped;
            openPass.errors += outcome.summary.errors;
            openPass.failedTargets.push(...outcome.summary.failedTargets);
            openUndecided += outcome.undecided;
            // Same rule as the line pass: never checkpoint past a failure.
            if (outcome.summary.errors > 0) break;
        }

        openCursor = page[page.length - 1].id;
        await writeOpenCursor(openCursor);
        if (page.length < OPEN_ISSUE_BATCH_SIZE) { openExhausted = true; break; }
    }
    // A finished pass starts over next run — that is what re-checks everything.
    if (openExhausted && openPass.errors === 0) await writeOpenCursor(null);

    let cursor = await readCursor();
    const totals: ReceiptRequestApplySummary = {
        opened: openPass.opened,
        closed: openPass.closed,
        touched: openPass.touched,
        skipped: openPass.skipped,
        errors: openPass.errors,
        failedTargets: [...openPass.failedTargets],
    };
    let batches = 0;
    let linesSeen = 0;
    let undecided = openUndecided;
    let exhausted = false;

    while (Date.now() - startedAt < RUN_BUDGET_MS) {
        const batch = await prisma.bankLine.findMany({
            where: { postedDate: { gte: new Date(`${windowStart}T00:00:00Z`) }, amountCents: { lt: 0 } },
            orderBy: [{ postedDate: "asc" }, { id: "asc" }],
            take: BATCH_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        });
        if (batch.length === 0) { exhausted = true; break; }

        const outcome = await processBatch(batch, openIssues, resolvedIssueKeys, detailsByKey, now);
        batches++;
        linesSeen += batch.length;
        undecided += outcome.undecided;
        totals.opened += outcome.summary.opened;
        totals.closed += outcome.summary.closed;
        totals.touched += outcome.summary.touched;
        totals.skipped += outcome.summary.skipped;
        totals.errors += outcome.summary.errors;
        totals.failedTargets.push(...outcome.summary.failedTargets);

        // THE CURSOR STOPS AT THE FIRST FAILURE. Advancing past a target whose
        // write threw is how a row that fails every night is never chased: the
        // sweep would step over it forever and report a clean run. A failed
        // batch keeps its cursor so the next invocation retries the same
        // ground; the lifecycle writes are idempotent, so re-running is free.
        if (outcome.summary.errors > 0) break;

        cursor = batch[batch.length - 1].id;
        await writeCursor(cursor);
        if (batch.length < BATCH_SIZE) { exhausted = true; break; }
    }

    // A finished sweep starts over from the oldest line next time — that pass
    // is what re-checks everything for CLOSES.
    if (exhausted && totals.errors === 0) await writeCursor(null);

    const result = {
        ok: totals.errors === 0,
        window: { start: windowStart, end: windowEnd },
        batches,
        openBatches,
        openIssueCursor: openCursor,
        openIssuesExhausted: openExhausted,
        targetMissing,
        bankLines: linesSeen,
        undecided,
        exhausted,
        // Work remains if EITHER pass has more to do.
        moreToProcess: !exhausted || !openExhausted,
        cursor,
        elapsedMs: Date.now() - startedAt,
        ...totals,
    };
    if (totals.errors > 0) {
        console.error("[cron/receipt-requests]", JSON.stringify(result));
    } else if (totals.opened > 0 || totals.closed > 0) {
        console.log("[cron/receipt-requests]", JSON.stringify(result));
    }
    // 500 when anything failed, so the platform surfaces it. Whatever committed
    // stays committed and the cursor did not move past the failure.
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
