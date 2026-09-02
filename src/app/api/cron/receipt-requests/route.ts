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
    ComponentTooLargeError,
    competingLineFilter,
    componentTouchesBoundary,
    componentVersionOf,
    componentVersionsMatch,
    loadComponentToClosure,
    groupCompetingLines,
    isComponentKey,
    pageComponents,
    hasResolution,
    mergeReceiptRequestDetails,
    planReceiptRequests,
    type ReceiptRequestPlan,
} from "@/lib/receipt-requests";
import { REGISTER_WINDOW_DAYS, registerWindowStartYmd } from "@/lib/bank-register-pull";
import {
    SWEEP_MARKER_KEY,
    formatSweepMarker,
    parseSweepMarker,
    type SweepMarker,
    type SweepPhase,
} from "@/lib/receipt-sweep-marker";
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



/**
 * How far back the sweep looks for chaseable debits — THE SAME 60-calendar-day
 * boundary the QBO pull's deep sweep and minting use (`REGISTER_WINDOW_DAYS`).
 * Three subsystems have to agree on this or a chase can outlive the evidence
 * that would close it.
 */
export const LOOKBACK_DAYS = REGISTER_WINDOW_DAYS;

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

/** Which half of the sweep is in progress. Persisted, so a resume knows. */
const PHASE_KEY = SWEEP_MARKER_KEY;

/**
 * The sweep's two passes, in order, plus "done".
 *
 * A CURSOR is not a phase marker. Both cursors are cleared the moment their
 * pass finishes, so "open-issue pass complete, budget spent before a single
 * line batch" looked exactly like "nothing in progress" — the `?continue=1`
 * pass exited, and the line half of the sweep waited for tomorrow. The phase is
 * what says a cycle is unfinished when neither cursor is parked.
 */
export type { SweepPhase };

/**
 * Where the cycle stands once a run ends. ONE place, so the marker can never
 * disagree with what the run actually finished.
 *
 * A pass that errored is NOT complete: its cursor was deliberately left parked
 * on the failure, and the phase has to keep pointing at it or the next resume
 * would step over the row that failed — the same "silently never chased" bug
 * the cursor rule exists to prevent.
 */
export function sweepPhaseAfter(run: {
    openExhausted: boolean;
    openErrors: number;
    lineExhausted: boolean;
    lineErrors: number;
}): SweepPhase {
    if (!run.openExhausted || run.openErrors > 0) return "open-issues";
    if (!run.lineExhausted || run.lineErrors > 0) return "lines";
    return "done";
}

/**
 * A resume pass has work whenever the cycle is unfinished — by the phase, or by
 * either cursor. The cursors stay in the test for rows written before the phase
 * marker existed.
 */
export function shouldResumeSweep(
    phase: SweepPhase,
    lineCursor: string | null,
    openCursor: string | null,
): boolean {
    return phase !== "done" || !!lineCursor || !!openCursor;
}

async function readMarker(): Promise<SweepMarker> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: PHASE_KEY } });
        return parseSweepMarker(row?.value);
    } catch {
        return { phase: "done", chaserCompletedAt: null };
    }
}

async function readPhase(): Promise<SweepPhase> {
    return (await readMarker()).phase;
}

/**
 * Write the phase, and STAMP A COMPLETION when the cycle actually finished.
 *
 * That stamp is what the morning cards cron waits for: a card built from a
 * half-reconciled open set asks people for receipts they already sent and
 * misses the ones they did not, and selection costs the owner their whole day
 * (the claim is per owner per Pacific day). A previous stamp is CARRIED
 * FORWARD on every other write — losing it would block tomorrow's cards on a
 * technicality.
 */
async function writePhase(phase: SweepPhase, completedAt?: string): Promise<void> {
    try {
        const previous = await readMarker();
        const value = formatSweepMarker({
            phase,
            chaserCompletedAt: completedAt ?? previous.chaserCompletedAt,
        });
        await prisma.automationSetting.upsert({
            where: { key: PHASE_KEY },
            update: { value },
            create: { key: PHASE_KEY, value },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "UnknownError";
        console.error("[cron/receipt-requests] phase write failed", message);
        throw new CursorWriteError(message);
    }
}

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
/**
 * The most competing lines one recompute will load before it gives up.
 *
 * A cap is not optional: the walk follows real data, and a run of identical
 * daily charges (a card on a subscription, a fuel card at the same pump) chains
 * arbitrarily far. 200 is far past any genuine competition set and still a
 * query Postgres answers instantly.
 */
const MAX_COMPONENT_LINES = 200;

/** How many times one component may be replanned before the run leaves it alone. */
const MAX_COMPONENT_REPLANS = 3;

/**
 * Load the TRUE competing component around one line, by iterating the link rule
 * to closure — the walk itself is `loadComponentToClosure`, which is pure and
 * tested; this supplies the query.
 */
async function loadCompetingComponent(seed: {
    id: string;
    postedDate: Date;
    amountCents: number;
}) {
    return loadComponentToClosure(
        seed.postedDate.toISOString().slice(0, 10),
        (fromYmd, toYmd) => prisma.bankLine.findMany({
            where: {
                amountCents: seed.amountCents,
                // `BankLine.postedDate` is `@db.Date` — calendar bounds.
                postedDate: {
                    gte: new Date(`${fromYmd}T00:00:00Z`),
                    lte: new Date(`${toYmd}T00:00:00Z`),
                },
            },
            // One past the cap, so an oversized component is DETECTED rather
            // than silently truncated into a wrong answer.
            take: MAX_COMPONENT_LINES + 1,
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }).then(rows => rows.map(row => ({ ...row, postedDate: row.postedDate.toISOString().slice(0, 10) }))),
        { maxNodes: MAX_COMPONENT_LINES },
    );
}

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
    let loadedLines: Array<{ id: string; postedDate: string; amountCents: number; rawDescriptor: string; checkNumber: string | null }>;
    try {
        loadedLines = await loadCompetingComponent(line);
    } catch (error) {
        if (error instanceof ComponentTooLargeError) {
            // NO VERDICT. Returning [] would CLEAR the issue, which is the one
            // wrong answer available here: it closes a chase because we could
            // not look, not because a receipt exists. Keeping the code leaves
            // the chase open for a human, which is what a run of hundreds of
            // identical charges needs anyway.
            console.error("[cron/receipt-requests] component too large; leaving the chase open", targetKey, error.message);
            return ["MISSING_RECEIPT"];
        }
        throw error;
    }
    // The component that actually contains this line — the loaded window may
    // hold same-amount lines that chain to nothing.
    const component = groupCompetingLines(loadedLines).find(group => group.lineIds.includes(targetKey));
    const componentIds = new Set(component?.lineIds ?? [targetKey]);
    const lines = loadedLines.filter(row => componentIds.has(row.id));

    // Evidence for the component's own span, widened by the match window.
    const componentDays = lines.map(row => Date.parse(`${row.postedDate}T00:00:00Z`));
    const fromYmd = new Date(Math.min(...componentDays) - RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
    const toYmd = new Date(Math.max(...componentDays) + RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
    const range = await evidenceRange(fromYmd, toYmd);

    const [expenseRows, intakeRows] = await Promise.all([
        prisma.expense.findMany({
            where: { date: range.timestamp },
            select: {
                id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                receiptUrl: true, receiptIntake: { select: { id: true } },
            },
        }),
        prisma.receiptIntake.findMany({
            where: { txnDate: range.calendar, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: { id: true, totalCents: true, txnDate: true, vendor: true, state: true, stateReason: true, expenseId: true, qbPurchaseId: true },
        }),
    ]);

    // Resolutions across the whole competing set, so a sibling's signed memo
    // does not get re-asked just because we came in through a retry.
    const siblingIssues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: { in: lines.map(l => l.id) } },
        select: { targetKey: true, clearedAt: true, displayDetails: true },
    });

    const plan = planReceiptRequests({
        bankLines: lines,
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
            // A row parked because its bytes are gone is not evidence.
            stateReason: row.stateReason,
        })),
        // Exactly the span the evidence queries above covered, so a line whose
        // window pokes outside it emits no decision rather than a guess.
        evidenceLoadedFrom: fromYmd,
        evidenceLoadedTo: toYmd,
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


/** The issues that belong to a component, with just enough to version them. */
async function componentIssueRows(lineIds: string[]): Promise<Array<{ updatedAt: Date }>> {
    if (lineIds.length === 0) return [];
    return prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: { in: lineIds } },
        select: { updatedAt: true },
    });
}

/**
 * The lines that could compete inside this window, for the version stamp.
 *
 * BY AMOUNT AND SPAN, NOT BY ID. A line ARRIVING mid-plan — the nightly pull
 * minting one, a statement import landing — is a new competitor for the same
 * evidence, and an id list drawn from the plan itself is exactly the thing that
 * cannot see it. The descriptor is hashed too, because a refreshed one changes
 * the payee and therefore what matches.
 */
async function componentLineRows(
    amounts: number[],
    postedDate: { gte: Date; lt: Date },
): Promise<Array<{ id: string; updatedAt: Date; rawDescriptor: string }>> {
    if (amounts.length === 0) return [];
    return prisma.bankLine.findMany({
        where: { amountCents: { in: [...new Set(amounts)] }, postedDate },
        select: { id: true, updatedAt: true, rawDescriptor: true },
    });
}

function emptySummary(): ReceiptRequestApplySummary {
    return { opened: 0, closed: 0, touched: 0, skipped: 0, errors: 0, failedTargets: [] };
}

/**
 * Plan and apply, replanning when the component moved underneath us.
 *
 * THREE ATTEMPTS, then silence. A component that keeps changing is one a human
 * is actively working on, and the honest answer there is to leave it alone for
 * this run: the next sweep decides it. Looping until it settles would hold the
 * budget hostage to somebody's editing session.
 */
async function processBatchWithReplan(
    batch: BatchLine[],
    openIssues: Array<{ targetKey: string }>,
    resolvedIssueKeys: string[],
    detailsByKey: Map<string, Record<string, unknown>>,
    now: Date,
    cohortMode: "window" | "closure" = "window",
): Promise<{ summary: ReceiptRequestApplySummary; undecided: number; replans: number }> {
    let replans = 0;
    for (let attempt = 1; attempt <= MAX_COMPONENT_REPLANS; attempt++) {
        const outcome = await processBatch(batch, openIssues, resolvedIssueKeys, detailsByKey, now, cohortMode);
        if (!outcome.replan) return { ...outcome, replans };
        replans++;
        console.log("[cron/receipt-requests] component changed mid-plan; replanning", batch.length, "line(s)", attempt);
    }
    // Deliberately no verdict, and it is REPORTED as undecided rather than
    // hidden: a chase left open is a question a human can answer; a chase
    // closed from a stale plan is a receipt nobody ever asks for again.
    return { summary: emptySummary(), undecided: batch.length, replans };
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
    /**
     * How to find each line's competitors.
     *
     * `"window"` — one wide same-amount query per line. Correct for the LINE
     *   pass, whose batches are already whole components (`pageComponents` cut
     *   the pages between them); the query is only there to catch a competitor
     *   that fell outside the 60-day window.
     * `"closure"` — walk the link rule to closure, per line. The OPEN-ISSUE
     *   pass needs this: its page is an arbitrary set of old issues, not a
     *   component, so a chain of same-amount charges reaching further than the
     *   fixed span was matched as a FRAGMENT — a different answer from the one
     *   the line pass reaches for the same rows.
     */
    cohortMode: "window" | "closure" = "window",
): Promise<{ summary: ReceiptRequestApplySummary; undecided: number; replan: boolean }> {
    // THE LINES THIS BATCH IS ANSWERABLE FOR. The cohort query below drags in
    // neighbours so they can consume the evidence they are entitled to, but a
    // neighbour's OWN verdict belongs to the page that owns it — judging it here,
    // from a view that may be missing ITS competitors, is how a line got closed
    // on one page and reopened on the next, night after night.
    const judgeOnly = new Set(batch.map(row => row.id));
    // 1. THE COHORT.
    const cohortRows: BatchLine[] = [];
    const unresolved: string[] = [];
    if (cohortMode === "closure") {
        // PER LINE, TO CLOSURE. Each target brings its whole component, however
        // far the chain reaches.
        for (const row of batch) {
            try {
                for (const found of await loadCompetingComponent(row)) {
                    cohortRows.push({ ...found, postedDate: new Date(`${found.postedDate}T00:00:00Z`) });
                }
            } catch (error) {
                if (!(error instanceof ComponentTooLargeError)) throw error;
                // Its competition set is unloadable, so it gets NO verdict —
                // not a guess, and not a close. It stays open and reported.
                console.error("[cron/receipt-requests] component too large; leaving the chase open", row.id, error.message);
                judgeOnly.delete(row.id);
                unresolved.push(row.id);
            }
        }
    } else {
        const cohortFilters = batch.map(row => competingLineFilter({
            amountCents: row.amountCents,
            postedDate: row.postedDate.toISOString().slice(0, 10),
        }));
        const found = cohortFilters.length === 0 ? [] : await prisma.bankLine.findMany({
            where: {
                OR: cohortFilters.map(f => ({
                    amountCents: f.amountCents,
                    postedDate: { gte: new Date(`${f.from}T00:00:00Z`), lte: new Date(`${f.to}T00:00:00Z`) },
                })),
            },
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        });
        cohortRows.push(...found);
    }

    // Open-issue lines are NOT bolted on here any more — they get their own
    // pass (see runSweep). Loading every one of them into every batch made each
    // batch's evidence window span the whole backlog, which is exactly what
    // made batching pointless.
    const lines = [...new Map(
        [...batch, ...cohortRows].map(row => [row.id, row]),
    ).values()];
    if (lines.length === 0) {
        return { summary: emptySummary(), undecided: 0, replan: false };
    }

    // 2. EVIDENCE FOR THE COHORT'S FULL SPAN, widened by the match window.
    const days = lines.map(row => row.postedDate.getTime());
    const fromYmd = new Date(Math.min(...days) - RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
    const toYmd = new Date(Math.max(...days) + RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
    // HALF-OPEN, company timezone. See evidenceRange.
    const range = await evidenceRange(fromYmd, toYmd);

    const [expenseRows, intakeRows] = await Promise.all([
        prisma.expense.findMany({
            where: { date: range.timestamp },
            select: {
                id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                receiptUrl: true, receiptIntake: { select: { id: true } },
            },
        }),
        prisma.receiptIntake.findMany({
            where: { txnDate: range.calendar, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: {
                id: true, totalCents: true, txnDate: true, vendor: true, state: true,
                stateReason: true, expenseId: true, qbPurchaseId: true, updatedAt: true,
            },
        }),
    ]);
    // THE VERSION OF THE WORLD THIS PLAN IS ABOUT TO BE MADE FROM — all four
    // inputs, because a verdict is a function of all four.
    const lineIds = lines.map(row => row.id);
    const componentAmounts = lines.map(row => row.amountCents);
    const planVersion = componentVersionOf({
        issues: await componentIssueRows(lineIds),
        intakes: intakeRows,
        lines: await componentLineRows(componentAmounts, range.calendar),
        expenses: expenseRows.map(row => ({
            id: row.id,
            hasReceipt: !!row.receiptUrl || row.receiptIntake !== null,
        })),
    });

    // 3. DECIDE.
    const fullPlan = planReceiptRequests({
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
            // A row parked because its bytes are gone is not evidence.
            stateReason: row.stateReason,
        })),
        openIssueKeys: openIssues.map(row => row.targetKey),
        resolvedIssueKeys,
        evidenceLoadedFrom: fromYmd,
        evidenceLoadedTo: toYmd,
        now,
    });

    // The matching used every line; only this page's own lines get a verdict.
    const plan = {
        open: fullPlan.open.filter(item => judgeOnly.has(item.targetKey)),
        close: fullPlan.close.filter(targetKey => judgeOnly.has(targetKey)),
        undecided: fullPlan.undecided.filter(id => judgeOnly.has(id)),
    };

    /**
     * NOTHING MOVED WHILE WE WERE THINKING.
     *
     * Assignment is a property of the SET: one receipt answering two identical
     * charges is decided by looking at both. So a SIBLING changing mid-sweep —
     * a memo signed on the charge next to this one, an intake booked, an issue
     * a human cleared — can change THIS line's verdict without touching this
     * line at all, and the per-write fresh read cannot see that. It only stops
     * the row itself being overwritten, which is the smaller half.
     *
     * So the plan is checked against the component's version immediately before
     * anything is applied, and a change replans the WHOLE component rather than
     * committing a verdict derived from a world that no longer exists.
     */
    const currentVersion = componentVersionOf({
        issues: await componentIssueRows(lineIds),
        intakes: await prisma.receiptIntake.findMany({
            where: { txnDate: range.calendar, state: { notIn: [...DEAD_INTAKE_STATES] } },
            select: { updatedAt: true },
        }),
        lines: await componentLineRows(componentAmounts, range.calendar),
        // Re-read with the SAME predicate the planner used, so an expense that
        // gained a receipt mid-plan changes the hash rather than slipping in
        // under an unchanged count.
        expenses: (await prisma.expense.findMany({
            where: { date: range.timestamp },
            select: { id: true, receiptUrl: true, receiptIntake: { select: { id: true } } },
        })).map(row => ({
            id: row.id,
            hasReceipt: !!row.receiptUrl || row.receiptIntake !== null,
        })),
    });
    if (!componentVersionsMatch(planVersion, currentVersion)) {
        return { summary: emptySummary(), undecided: plan.open.length + plan.close.length, replan: true };
    }

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

    // A line whose component would not load is undecided too — the caller
    // reports it, and the cursor does not step past it silently.
    return { summary, undecided: plan.undecided.length + unresolved.length, replan: false };
}


export interface EvidenceBounds {
    /** For TIMESTAMP columns (`Expense.date`), resolved in the company's zone. */
    timestamp: { gte: Date; lt: Date };
    /** For DATE columns (`ReceiptIntake.txnDate`), which have no zone at all. */
    calendar: { gte: Date; lt: Date };
}

/**
 * The evidence window — as TWO ranges, because the two evidence tables store
 * their dates in genuinely different types.
 *
 * `Expense.date` is a TIMESTAMP: a real instant, so its day boundary is the
 * company's midnight. (`lte: <UTC midnight>` used to silently exclude most of
 * the last allowed day — an expense stamped 14:00 on the 18th is after
 * `2026-08-18T00:00:00Z` — so a receipt filed in the afternoon of the last
 * in-window day was invisible and its charge got chased.)
 *
 * `ReceiptIntake.txnDate` is `@db.Date`: a calendar day with NO zone, which
 * Prisma reads and writes at UTC midnight. Comparing it against Pacific
 * midnight (08:00Z) is wrong at BOTH ends — an intake on the first allowed day
 * sits at 00:00Z, which is before 08:00Z and was dropped, while an intake on
 * the day AFTER the window sits at 00:00Z, which is before the exclusive upper
 * bound of 08:00Z and was let in. One shared range could not be right for both
 * columns; it was simply wrong for one of them.
 *
 * Both are half-open: start of the FIRST allowed day, inclusive; start of the
 * day AFTER the last allowed day, exclusive.
 */
export function evidenceBoundsFor(fromYmd: string, toYmd: string, zone: string): EvidenceBounds {
    const dayAfter = new Date(Date.parse(`${toYmd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return {
        timestamp: {
            gte: startOfDateInTimeZone(fromYmd, zone),
            lt: startOfDateInTimeZone(dayAfter, zone),
        },
        calendar: {
            gte: new Date(`${fromYmd}T00:00:00Z`),
            lt: new Date(`${dayAfter}T00:00:00Z`),
        },
    };
}

async function evidenceRange(fromYmd: string, toYmd: string): Promise<EvidenceBounds> {
    return evidenceBoundsFor(fromYmd, toYmd, await resolveCompanyTimeZone());
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
    let resumePhase: SweepPhase = "open-issues";
    if (continueOnly) {
        // THE PHASE, plus both cursors. The sweep has two independent passes
        // with two resume points, and asking only about the line cursor meant a
        // half-finished OPEN-ISSUE pass looked like nothing in progress — so the
        // resume pass exited and that backlog waited for tomorrow's full sweep.
        // Even both cursors are not enough: each is cleared the instant its pass
        // completes, so a run that finished the open-issue pass and then ran out
        // of budget parked NEITHER, and the line pass never resumed.
        const [phase, lineCursor, openCursor] = await Promise.all([readPhase(), readCursor(), readOpenCursor()]);
        if (!shouldResumeSweep(phase, lineCursor, openCursor)) {
            return NextResponse.json({ ok: true, skipped: "nothing-in-progress" });
        }
        resumePhase = phase === "done" ? "open-issues" : phase;
    }

    const leaseToken = randomUUID();
    if (!(await takeLease(LEASE_KEY, RUN_LEASE_MS, now, leaseToken))) {
        return NextResponse.json({ ok: true, skipped: "already-running" });
    }
    try {
        // A scheduled full run always starts a fresh cycle at the top.
        return await runSweep(now, continueOnly ? resumePhase : "open-issues");
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

async function runSweep(now: Date, startPhase: SweepPhase = "open-issues") {
    const windowStart = registerWindowStartYmd(now, LOOKBACK_DAYS);
    const windowEnd = now.toISOString().slice(0, 10);
    // The cycle is unfinished from here until the line pass exhausts.
    if (startPhase !== "lines") await writePhase("open-issues");

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
    // A resume that already completed this pass goes straight to the lines:
    // re-running it would be correct but would eat the budget the line pass has
    // been waiting for.
    let openExhausted = startPhase === "lines";
    let openBatches = 0;
    let targetMissing = 0;
    // How many components had to be replanned because a sibling moved while the
    // plan was being made. Reported: a run full of them is a run racing a human.
    let replans = 0;

    while (startPhase !== "lines" && Date.now() - startedAt < RUN_BUDGET_MS) {
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
            const outcome = await processBatchWithReplan(
                lines,
                page.map(issue => ({ targetKey: issue.targetKey })),
                resolvedIssueKeys,
                detailsByKey,
                now,
                // An arbitrary page of old issues is not a component. Walk each
                // one's chain to closure or judge a fragment.
                "closure",
            );
            replans += outcome.replans;
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

    // COMPONENTS FIRST, THEN PAGES — never the other way round.
    //
    // Paging by line id cut the window wherever the 200th row happened to fall,
    // and a set of lines competing for one receipt could land either side of
    // that cut. Each half then matched against the same evidence without seeing
    // the other, and one receipt closed two charges — the exact bug the
    // one-to-one matching exists to prevent. So the whole window's identity
    // keys are grouped into competition components up front, and pages are cut
    // BETWEEN components (`pageComponents`); a component larger than BATCH_SIZE
    // gets its own oversized page rather than being split.
    const windowLines = await prisma.bankLine.findMany({
        where: { postedDate: { gte: new Date(`${windowStart}T00:00:00Z`) }, amountCents: { lt: 0 } },
        orderBy: [{ postedDate: "asc" }, { id: "asc" }],
        select: { id: true, postedDate: true, amountCents: true },
    });
    const windowDates = new Map(windowLines.map(row => [row.id, row.postedDate.toISOString().slice(0, 10)]));
    const components = groupCompetingLines(windowLines.map(row => ({
        id: row.id,
        postedDate: windowDates.get(row.id) as string,
        amountCents: row.amountCents,
    })));
    /**
     * Components whose chain might continue OUTSIDE the loaded window.
     *
     * Grouping over a 60-day window makes a component whole WITHIN it and says
     * nothing about what sits just past either end: a charge on day 61 linking
     * to one on day 59 is a real competitor this pass never loaded, so what it
     * has is a FRAGMENT — and a fragment allocates evidence differently from
     * the whole. These get the full closure walk; the interior is provably
     * complete already and keeps the cheap query.
     */
    const boundaryLineIds = new Set(
        components
            .filter(component => componentTouchesBoundary(
                component.lineIds.map(id => windowDates.get(id) ?? ""),
                windowStart,
                windowEnd,
            ))
            .flatMap(component => component.lineIds),
    );
    // The cursor is a COMPONENT KEY now. A cursor left by an older build is a
    // bare BankLine id; it cannot be placed in this ordering, so the cycle
    // restarts once — idempotent, and it self-corrects on the first checkpoint.
    const resumeFrom = isComponentKey(cursor) ? cursor : null;
    const pages = pageComponents(
        resumeFrom ? components.filter(component => component.key > resumeFrom) : components,
        BATCH_SIZE,
    );
    let pageIndex = 0;
    exhausted = pages.length === 0;

    while (pageIndex < pages.length && Date.now() - startedAt < RUN_BUDGET_MS) {
        const page = pages[pageIndex++];
        const ids = page.flatMap(component => component.lineIds);
        const batch = await prisma.bankLine.findMany({
            where: { id: { in: ids } },
            orderBy: [{ postedDate: "asc" }, { id: "asc" }],
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        });
        // Every line in the page vanished between the two queries. Nothing to
        // judge, but the checkpoint still has to move past it.
        if (batch.length === 0) {
            cursor = page[page.length - 1].key;
            await writeCursor(cursor);
            if (pageIndex >= pages.length) exhausted = true;
            continue;
        }

        // Split the page by where its components sit. Distinct components share
        // no candidate evidence by construction, so judging them in two calls
        // cannot change any allocation — it only changes how each one's
        // competitors were found.
        const boundaryBatch = batch.filter(row => boundaryLineIds.has(row.id));
        const interiorBatch = batch.filter(row => !boundaryLineIds.has(row.id));
        let pageErrors = 0;
        for (const [rows, mode] of [
            [interiorBatch, "window"],
            [boundaryBatch, "closure"],
        ] as const) {
            if (rows.length === 0) continue;
            const outcome = await processBatchWithReplan(rows, openIssues, resolvedIssueKeys, detailsByKey, now, mode);
            replans += outcome.replans;
            undecided += outcome.undecided;
            totals.opened += outcome.summary.opened;
            totals.closed += outcome.summary.closed;
            totals.touched += outcome.summary.touched;
            totals.skipped += outcome.summary.skipped;
            totals.errors += outcome.summary.errors;
            totals.failedTargets.push(...outcome.summary.failedTargets);
            pageErrors += outcome.summary.errors;
        }
        batches++;
        linesSeen += batch.length;

        // THE CURSOR STOPS AT THE FIRST FAILURE. Advancing past a target whose
        // write threw is how a row that fails every night is never chased: the
        // sweep would step over it forever and report a clean run. A failed
        // batch keeps its cursor so the next invocation retries the same
        // ground; the lifecycle writes are idempotent, so re-running is free.
        if (pageErrors > 0) break;

        // The checkpoint is the last COMPONENT this page finished, so a resume
        // can never land in the middle of a competition set.
        cursor = page[page.length - 1].key;
        await writeCursor(cursor);
        if (pageIndex >= pages.length) { exhausted = true; break; }
    }

    // A finished sweep starts over from the oldest line next time — that pass
    // is what re-checks everything for CLOSES.
    if (exhausted && totals.errors === 0) await writeCursor(null);

    // THE PHASE, LAST, FROM WHAT ACTUALLY HAPPENED. It is what carries "the
    // open-issue half is done" across an invocation boundary — the cursor that
    // pass just cleared cannot, and a run that finished the open pass and then
    // spent its budget parked NEITHER cursor, so `?continue=1` saw nothing in
    // progress and the line half waited for tomorrow.
    const phase = sweepPhaseAfter({
        openExhausted,
        openErrors: openPass.errors,
        lineExhausted: exhausted,
        lineErrors: totals.errors - openPass.errors,
    });
    // A CLEAN, COMPLETE cycle stamps the clock the cards cron reads. Anything
    // else leaves the previous stamp alone: yesterday's completion is still a
    // true statement about yesterday, and the cards cron compares it to TODAY.
    await writePhase(phase, phase === "done" ? new Date().toISOString() : undefined);

    const result = {
        ok: totals.errors === 0,
        phase,
        window: { start: windowStart, end: windowEnd },
        batches,
        openBatches,
        openIssueCursor: openCursor,
        openIssuesExhausted: openExhausted,
        targetMissing,
        replans,
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
