import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { resolveCompanyTimeZone, startOfDateInTimeZone } from "@/lib/company-timezone";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { releaseLease, takeLease } from "@/lib/cron-lease";
import {
    evaluateReviewIssue,
    type EvaluateReviewIssueResult,
    type ReviewIssueLifecycleClient,
} from "@/lib/review-alert-lifecycle";
import type { ReasonCode } from "@/lib/review-alert-reasons";
import {
    COMPETING_LINE_ADJACENCY_DAYS,
    DEAD_INTAKE_STATES,
    RECEIPT_MATCH_DATE_SLOP_DAYS,
    RECEIPT_REQUEST_TARGET_TYPE,
    decimalStringToCents,
    ComponentDeadlineExceededError,
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
import { BANK_PULL_LAST_SUCCESS_KEY, BANK_PULL_CHASER_WINDOW_HOURS } from "@/lib/pipeline-health";
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
 * HOW FRESH THE BANK PULL MUST BE BEFORE THIS CYCLE MAY CALL ITSELF DONE.
 *
 * THE CRON SCHEDULE, from vercel.json, because the whole rule is about how
 * these four lines relate:
 *
 *   0 2 * * *        /api/cron/bank-register-pull      the register this reads
 *   0 13 * * *       /api/cron/receipt-requests        this sweep, full run
 *   0/15 * * * *     /api/cron/receipt-requests?continue=1   its resume passes
 *   30 14 * * 1-5    /api/cron/receipt-request-cards   the cards it releases
 *
 * The pull withholds its success marker when it failed, when a batch errored,
 * when it ran out of budget mid-window, or when reconcile left an ambiguous
 * group — all of which mean the register is INCOMPLETE. Nothing checked that.
 * So the sweep could reconcile a half-populated ledger, stamp its cycle
 * complete, and release the 14:30 cards: charges the pull never fetched are not
 * chased, and nothing anywhere says why.
 *
 * A cycle may only stamp when the last COMPLETE pull success is inside this
 * window. 24h at the 13:00 slot cleanly separates a healthy pull (~11h old)
 * from last night's (~35h old, meaning tonight's failed), while tolerating a
 * pull that ran late. It lives in pipeline-health beside BANK_PULL_STALE_HOURS
 * so the two thresholds are read together and cannot drift apart.
 */
const BANK_PULL_CYCLE_WINDOW_MS = BANK_PULL_CHASER_WINDOW_HOURS * 60 * 60_000;

/** The one `blockedReason` this sweep writes. */
export const BANK_PULL_STALE_REASON = "bank-pull-stale";

/**
 * Is a recorded pull success fresh enough for this cycle? PURE, so the boundary
 * is testable without a database.
 *
 * Four ways to be stale, and all of them are: never succeeded (null), an
 * unparseable value, older than the window, and — less obviously — a mark in
 * the FUTURE. A future timestamp is a clock nobody can trust, and treating it
 * as fresh would hold the gate open for as long as it was wrong.
 */
export function bankPullFresh(lastSuccessAt: string | null, now: Date): boolean {
    if (!lastSuccessAt) return false;
    const at = Date.parse(lastSuccessAt);
    if (!Number.isFinite(at)) return false;
    if (at > now.getTime()) return false;
    return now.getTime() - at <= BANK_PULL_CYCLE_WINDOW_MS;
}

/**
 * What a finished run should write, given the phase it computed and whether its
 * register input was current. PURE — the two decisions the cards depend on, in
 * one place that can be tested directly.
 *
 * A stale pull may NOT reach "done". The phase is held at "lines" so
 * `shouldResumeSweep` keeps answering yes: leaving it "done" without a stamp
 * would make the every-15-minutes resume exit with "nothing-in-progress", and a
 * pull that recovered at 03:00 could never be picked up — the day's cards lost
 * to an outage that was already over. Held open, the next continuation stamps
 * the moment the marker is fresh, hours before the 14:30 cards.
 */
export function sweepCompletionDecision(input: {
    computedPhase: SweepPhase;
    bankPullStale: boolean;
}): { phase: SweepPhase; complete: boolean; blockedReason: string | null } {
    const phase: SweepPhase = input.bankPullStale && input.computedPhase === "done" ? "lines" : input.computedPhase;
    return {
        phase,
        complete: phase === "done",
        // Restated every write, never carried forward, or `chaser-blocked`
        // would keep firing after the pull recovered.
        blockedReason: input.bankPullStale ? BANK_PULL_STALE_REASON : null,
    };
}

/**
 * Did the register pull last SUCCEED inside this cycle's window?
 *
 * A read failure is NOT fresh. The marker is the only evidence the sweep has
 * that its input is complete, and "we could not check" is not evidence — the
 * safe direction is the one that withholds the cards, because a missed morning
 * is recoverable and a wrong one costs the owner their whole day (the card
 * claim is per owner per Pacific day).
 */
async function readBankPullFreshness(now: Date): Promise<{ fresh: boolean; lastSuccessAt: string | null }> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: BANK_PULL_LAST_SUCCESS_KEY } });
        const value = row?.value || null;
        return { fresh: bankPullFresh(value, now), lastSuccessAt: value };
    } catch (error) {
        console.error("[cron/receipt-requests] bank-pull marker read failed", error instanceof Error ? error.message : "UnknownError");
        return { fresh: false, lastSuccessAt: null };
    }
}

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
 *
 * CONTENDED WORK KEEPS THE CYCLE OPEN TOO, and for a sharper reason than an
 * error does. A component that ran out of replans got NO verdict: it was not
 * opened, not closed, and not counted as failed. Reporting the cycle "done"
 * there stamps `chaserCompletedAt`, which is the one signal the cards cron
 * waits for — so the morning card would be built from an issue set that was
 * never reconciled, asking for receipts already sent and staying silent about
 * the ones that are genuinely missing. The phase stays on the pass that hit the
 * contention so the next `?continue=1` run redoes it; a component contended
 * because a human is editing it settles within minutes.
 *
 * Only CONTENTION counts here, not every `undecided` line. A line outside the
 * loaded evidence span, or one whose competing set is too large to load, is a
 * STABLE non-verdict: the next run reproduces it exactly, so blocking on it
 * would stall the cards for good rather than for one cycle. Those stay open,
 * reported, and visible — which is the safe direction — while the cycle is
 * allowed to complete.
 */
export function sweepPhaseAfter(run: {
    openExhausted: boolean;
    openErrors: number;
    /** Components that ran out of replans in the open-issue pass. */
    openContended?: number;
    lineExhausted: boolean;
    lineErrors: number;
    /** Components that ran out of replans in the line pass. */
    lineContended?: number;
}): SweepPhase {
    if (!run.openExhausted || run.openErrors > 0 || (run.openContended ?? 0) > 0) return "open-issues";
    if (!run.lineExhausted || run.lineErrors > 0 || (run.lineContended ?? 0) > 0) return "lines";
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
async function writePhase(phase: SweepPhase, completedAt?: string, blockedReason: string | null = null): Promise<void> {
    try {
        const previous = await readMarker();
        const value = formatSweepMarker({
            phase,
            chaserCompletedAt: completedAt ?? previous.chaserCompletedAt,
            // NOT carried forward. Unlike the completion stamp — which is a true
            // statement about a cycle that really happened — a block is a
            // statement about the run that is ending right now, so every write
            // restates it or clears it. Carrying a stale one forward would keep
            // `chaser-blocked` firing after the pull recovered.
            blockedReason,
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
 *
 * `abortOnError` INVERTS that for the one caller that cannot survive it. Inside
 * the per-component transaction the verdicts are supposed to commit together or
 * not at all, and swallowing a failure broke exactly that promise: the first
 * lifecycle write committed with the transaction while the second was quietly
 * downgraded to a counter. The component then held HALF an allocation — one
 * charge chased, its twin neither chased nor closed — which is the state the
 * one-to-one matching exists to make impossible. So that caller asks for the
 * throw to propagate, the transaction rolls back, and the failure is reported
 * and retried OUTSIDE it (the cursor stops there, so the next run redoes it).
 */
export async function applyReceiptRequestPlan(
    plan: ReceiptRequestPlan,
    evaluate: EvaluateFn,
    options: { abortOnError?: boolean } = {},
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
            if (options.abortOnError) throw error;
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
            if (options.abortOnError) throw error;
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
 *
 * EXPORTED so `/api/cron/receipt-request-cards` can reuse the SAME evidence
 * check immediately before a card is delivered, rather than writing a second
 * matcher (Codex PR #443 gate, finding 1). That cron's own re-verification
 * only ever re-read `ReviewIssue` — clearedAt/acknowledged/resolved/owner —
 * which the NIGHTLY sweep is what normally updates. A receipt photographed
 * after last night's sweep and booked by the 5-minute intake worker satisfies
 * the charge hours before the issue itself is cleared, and the safe-direction
 * bias above is exactly right there too: erring toward NOT sending a chase
 * that might already be answered beats nagging a human for a receipt they
 * already sent.
 *
 * `cache`, when supplied, is an OPTIONAL per-run memo (Codex PR #443 gate,
 * finding 3 in receipt-request-cards): computing one line's verdict already
 * walks the whole competing COMPONENT and its evidence, so a caller re-asking
 * for every sibling line in that same component was repeating the identical
 * traversal once per item. Every member of the resolved component is written
 * into the cache in one pass — not just the line that was asked about — so a
 * later call for a sibling's targetKey is a map read instead of a second
 * `loadCompetingComponent` walk.
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
}, deadlineExceeded?: () => boolean) {
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
            // `updatedAt` rides along for the component fingerprint — see BatchLine.
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, updatedAt: true },
        }).then(rows => rows.map(row => ({ ...row, postedDate: row.postedDate.toISOString().slice(0, 10) }))),
        { maxNodes: MAX_COMPONENT_LINES, deadlineExceeded },
    );
}

/**
 * `deadlineExceeded`, when supplied, is the CALLER'S ABSOLUTE CLOCK, threaded
 * all the way into the closure walk (Codex PR #443 gate round 34, finding 3).
 *
 * One recompute is not one query: it is a multi-pass component walk plus an
 * evidence load plus a sibling-issue read, each a real round trip. The card
 * cron used to check its budget only BEFORE calling this, so a single slow
 * component could run the whole invocation past `maxDuration` from inside — and
 * being killed there costs the checkpoint as well as the answer. Checked
 * between queries, it aborts with `ComponentDeadlineExceededError`, which the
 * caller reads as "not decided this run", never as a verdict. Absent (the
 * nightly sweep, which owns its own outer budget) nothing changes.
 */
export async function recomputeCodesFor(
    targetKey: string,
    cache?: Map<string, ReasonCode[]>,
    deadlineExceeded?: () => boolean,
): Promise<ReasonCode[]> {
    if (cache?.has(targetKey)) return cache.get(targetKey)!;
    // The cache miss is the expensive path; the hit above costs nothing and is
    // still worth serving after the deadline.
    if (deadlineExceeded?.()) throw new ComponentDeadlineExceededError(0);

    const [line, issue] = await Promise.all([
        prisma.bankLine.findUnique({
            where: { id: targetKey },
            // Same shape as every other BankLine read here, `updatedAt`
            // included: one rule for all of them is what keeps a select that
            // feeds a fingerprint from quietly losing the column again.
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, updatedAt: true },
        }),
        prisma.reviewIssue.findUnique({
            where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey } },
            select: { displayDetails: true },
        }),
    ]);
    // A line that no longer exists cannot owe a receipt.
    if (!line) { cache?.set(targetKey, []); return []; }
    // An answered issue is never re-asked.
    if (hasResolution(parseMissingReceiptDetails(issue?.displayDetails ?? null))) { cache?.set(targetKey, []); return []; }

    // THE COMPLETE COMPETING SET, not this line alone. One-to-one assignment is
    // a property of the batch: two identical charges and one receipt resolve
    // differently depending on which is considered first, so recomputing one
    // row in isolation saw "a receipt exists" and closed a charge whose receipt
    // had already been given to its twin.
    let loadedLines: Array<{ id: string; postedDate: string; amountCents: number; rawDescriptor: string; checkNumber: string | null }>;
    try {
        loadedLines = await loadCompetingComponent(line, deadlineExceeded);
    } catch (error) {
        if (error instanceof ComponentTooLargeError) {
            // NO VERDICT. Returning [] would CLEAR the issue, which is the one
            // wrong answer available here: it closes a chase because we could
            // not look, not because a receipt exists. Keeping the code leaves
            // the chase open for a human, which is what a run of hundreds of
            // identical charges needs anyway.
            console.error("[cron/receipt-requests] component too large; leaving the chase open", targetKey, error.message);
            cache?.set(targetKey, ["MISSING_RECEIPT"]);
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
    // CHECKED AGAIN BEFORE THE EVIDENCE LOAD. The walk above may have been
    // cheap and still have consumed the last of the budget; the two queries
    // below scan a 60-day-wide window of Expense and ReceiptIntake and are the
    // most expensive thing left in this function.
    if (deadlineExceeded?.()) throw new ComponentDeadlineExceededError(0);
    // ONE resolved zone for the window AND for every day key derived below —
    // see the day-key note in processBatch.
    const zone = await resolveCompanyTimeZone();
    const range = evidenceBoundsFor(fromYmd, toYmd, zone);

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
                // COMPANY-LOCAL DAY, not the UTC one — see processBatch.
                date: row.date ? dayKeyInTimeZone(row.date, zone) : null,
                vendor: row.vendor,
            }];
        }),
        intakes: intakeRows.map(row => ({
            id: row.id,
            expenseId: row.expenseId,
            qbPurchaseId: row.qbPurchaseId,
            totalCents: row.totalCents,
            // `txnDate` is `@db.Date` — no zone at all, read at UTC midnight —
            // so the UTC slice IS its calendar day. Only `Expense.date` is an
            // instant needing a zone.
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
    // EVERY member of the component gets its verdict cached here, not just the
    // one that was asked for — a later call for a sibling's targetKey is then
    // a map read instead of a second full traversal of this same component.
    if (cache) {
        for (const memberId of componentIds) {
            cache.set(memberId, plan.open.some(o => o.targetKey === memberId) ? ["MISSING_RECEIPT"] : []);
        }
        return cache.get(targetKey)!;
    }
    // Only OUR line's verdict is returned; the rest of the set was recomputed
    // so that verdict is the one the batch would have reached.
    return plan.open.some(o => o.targetKey === targetKey) ? ["MISSING_RECEIPT"] : [];
}


/** The issues that belong to a component, with just enough to version them. */
async function componentIssueRows(lineIds: string[]): Promise<Array<{ targetKey: string; updatedAt: Date }>> {
    if (lineIds.length === 0) return [];
    return prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: { in: lineIds } },
        select: { targetKey: true, updatedAt: true },
    });
}

/**
 * Every bank-line issue, reduced to the three things a plan reads: which are
 * OPEN, which carry a RESOLUTION, and each one's details.
 *
 * One query, one shape, two callers — the run's opening snapshot and every
 * replan. Two loaders would drift, and the drift would be invisible: a replan
 * reading a subtly different set is exactly the bug the replan exists to fix.
 */
async function loadIssueSnapshot(): Promise<{
    openIssues: Array<{ targetKey: string }>;
    resolvedIssueKeys: string[];
    detailsByKey: Map<string, Record<string, unknown>>;
}> {
    const allIssues = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE },
        select: { targetKey: true, clearedAt: true, displayDetails: true },
    });
    const detailsByKey = new Map(
        allIssues.map(issue => [issue.targetKey, parseMissingReceiptDetails(issue.displayDetails)]),
    );
    return {
        openIssues: allIssues.filter(issue => issue.clearedAt === null).map(issue => ({ targetKey: issue.targetKey })),
        resolvedIssueKeys: allIssues
            .filter(issue => hasResolution(detailsByKey.get(issue.targetKey)))
            .map(issue => issue.targetKey),
        detailsByKey,
    };
}

/** Raised inside a component transaction when its inputs moved. Aborts it. */
class ComponentMovedError extends Error {
    constructor() {
        super("component moved between plan and commit");
        this.name = "ComponentMovedError";
    }
}

/**
 * One component's transaction holds row locks while it re-reads and writes.
 * Prisma's interactive default is 5s; a component is a handful of rows, but the
 * re-read is four queries and the writes are one per verdict.
 */
const COMPONENT_TX_TIMEOUT_MS = 15_000;

/**
 * Namespace for the per-component advisory lock. Every writer of a component
 * takes `hashtext(prefix + componentKey)`, so two sweeps working the same set
 * serialize rather than both passing their fingerprint checks and both writing.
 */
const COMPONENT_LOCK_PREFIX = "receipt-component:";

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
): Promise<{ summary: ReceiptRequestApplySummary; undecided: number; contended: number; replans: number }> {
    let replans = 0;
    let issues = openIssues;
    let resolved = resolvedIssueKeys;
    let details = detailsByKey;
    for (let attempt = 1; attempt <= MAX_COMPONENT_REPLANS; attempt++) {
        const outcome = await processBatch(batch, issues, resolved, details, now, cohortMode);
        // A batch that reached a verdict is never contended, whatever else it
        // left undecided — those are the STABLE non-verdicts (see
        // sweepPhaseAfter), and they must not hold the cycle open forever.
        if (!outcome.replan) return { ...outcome, contended: 0, replans };
        replans++;
        console.log("[cron/receipt-requests] component changed mid-plan; replanning", batch.length, "line(s)", attempt);

        /**
         * RELOAD THE ISSUE STATE BEFORE REPLANNING.
         *
         * A replan happens precisely BECAUSE something moved, and the most
         * common something is a memo signed on a sibling — which lands in these
         * three inputs and nowhere else. Retrying with the run-start snapshot
         * replans against the very state that was already stale, so the second
         * attempt reaches the same wrong verdict as the first and opens a chase
         * for a charge somebody just answered.
         */
        const reloaded = await loadIssueSnapshot();
        issues = reloaded.openIssues;
        resolved = reloaded.resolvedIssueKeys;
        details = reloaded.detailsByKey;
    }
    // Deliberately no verdict, and it is REPORTED as undecided rather than
    // hidden: a chase left open is a question a human can answer; a chase
    // closed from a stale plan is a receipt nobody ever asks for again.
    //
    // It is also reported as CONTENDED, which is the stronger claim: this batch
    // was not reconciled at all, so the cycle may not be called complete and
    // the morning card may not be built from it. The caller keeps the phase on
    // this pass and the next run redoes it.
    return { summary: emptySummary(), undecided: batch.length, contended: batch.length, replans };
}

interface BatchLine {
    id: string;
    postedDate: Date;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
    /**
     * CARRIED FOR THE FINGERPRINT, not for the matcher.
     *
     * The in-transaction fingerprint re-reads the component's bank lines WITH
     * their `updatedAt`, so a planned fingerprint that omitted it could never
     * match: for a brand-new unmatched line — no issue, no intake — the planned
     * `newest` was the empty string while the locked one was the line's own
     * timestamp. Every attempt "replanned", the component was abandoned as
     * undecided, and the one case this feature exists for (a fresh charge with
     * no receipt) was the one case it never chased.
     */
    updatedAt: Date;
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
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, updatedAt: true },
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
    //
    // ONE resolved zone for the whole batch: the window boundaries and the day
    // keys derived from `Expense.date` below must come from the SAME zone or
    // they disagree at the edges — the window would load an expense the
    // matcher then files on a different calendar day than the query claimed.
    const zone = await resolveCompanyTimeZone();
    const range = evidenceBoundsFor(fromYmd, toYmd, zone);

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
    const lineIds = lines.map(row => row.id);

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
                /**
                 * THE COMPANY'S CALENDAR DAY, not UTC's.
                 *
                 * `Expense.date` is a TIMESTAMP — an instant — and the query
                 * that loaded it used company-local midnights. Deriving its day
                 * key with `.toISOString()` moves every expense stamped after
                 * 5pm Pacific to the NEXT day, so a receipt filed at 7pm on the
                 * 16th was matched against the 17th: at the ±2-day edge it
                 * dropped out of range entirely and its charge got chased with
                 * the receipt sitting right there. DST-correct, which a fixed
                 * offset would not be.
                 */
                date: row.date ? dayKeyInTimeZone(row.date, zone) : null,
                vendor: row.vendor,
            }];
        }),
        intakes: intakeRows.map(row => ({
            id: row.id,
            expenseId: row.expenseId,
            qbPurchaseId: row.qbPurchaseId,
            totalCents: row.totalCents,
            // `txnDate` is `@db.Date` — a calendar day with no zone, read at
            // UTC midnight — so the UTC slice IS its day. Only the TIMESTAMP
            // above needs a zone.
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
     * APPLY EACH COMPONENT ATOMICALLY, UNDER ITS OWN LOCKS.
     *
     * Assignment is a property of the SET: one receipt answering two identical
     * charges is decided by looking at both. So a SIBLING changing mid-sweep —
     * a memo signed on the charge next to this one, an intake booked, an issue
     * a human cleared — changes THIS line's verdict without touching this line
     * at all. A fresh read per write cannot see that, and a fingerprint checked
     * outside a transaction only narrows the window: the sibling can still move
     * between the check and the writes.
     *
     * So each component gets ONE transaction that:
     *   1. takes `FOR UPDATE` on its ReviewIssue rows and the candidate
     *      ReceiptIntake rows, in id order (the same discipline mark-duplicate
     *      uses — two transactions wanting the same rows ask in the same
     *      sequence, so one waits instead of deadlocking);
     *   2. recomputes the fingerprint from those LOCKED rows plus the bank
     *      lines and expenses re-read inside the same transaction;
     *   3. aborts the whole component if it moved — no partial verdicts — and
     *      the caller replans;
     *   4. otherwise writes every verdict for that component in that
     *      transaction, so the set commits together or not at all.
     */
    const componentsInBatch = groupCompetingLines(lines.map(row => ({
        id: row.id,
        postedDate: row.postedDate.toISOString().slice(0, 10),
        amountCents: row.amountCents,
    })));
    const planIssueRows = await componentIssueRows(lineIds);
    const summary = emptySummary();

    for (const component of componentsInBatch) {
        const ids = new Set(component.lineIds);
        const componentOpen = plan.open.filter(item => ids.has(item.targetKey));
        const componentClose = plan.close.filter(targetKey => ids.has(targetKey));
        if (componentOpen.length === 0 && componentClose.length === 0) continue;

        // The component's own span, and the evidence window around it.
        const componentLines = lines.filter(row => ids.has(row.id));
        const days = componentLines.map(row => row.postedDate.getTime());
        const fromDay = new Date(Math.min(...days) - RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
        const toDay = new Date(Math.max(...days) + RECEIPT_MATCH_DATE_SLOP_DAYS * 86_400_000).toISOString().slice(0, 10);
        const componentRange = await evidenceRange(fromDay, toDay);
        // WIDER, for the BankLine re-read only. `groupCompetingLines` can join a
        // same-amount line up to `COMPETING_LINE_ADJACENCY_DAYS` (4 days) from
        // an EDGE of this component — one day further than the ±2-day evidence
        // fence above ever reaches. A line landing 3-4 days past an edge after
        // the initial scan is a real new competitor for this component, but the
        // evidence-width range would never select it, so the re-read's line
        // count could never change to catch it. The join window, not the
        // evidence window, is what decides whether a bank line belongs here.
        const joinFromDay = new Date(Math.min(...days) - COMPETING_LINE_ADJACENCY_DAYS * 86_400_000).toISOString().slice(0, 10);
        const joinToDay = new Date(Math.max(...days) + COMPETING_LINE_ADJACENCY_DAYS * 86_400_000).toISOString().slice(0, 10);
        const joinRange = await evidenceRange(joinFromDay, joinToDay);
        const amounts = [...new Set(componentLines.map(row => row.amountCents))];
        const intakeInWindow = (value: Date | null) =>
            value !== null && value >= componentRange.calendar.gte && value < componentRange.calendar.lt;
        const expenseInWindow = (value: Date | null) =>
            value !== null && value >= componentRange.timestamp.gte && value < componentRange.timestamp.lt;

        // The fingerprint of what THIS component was planned from, taken from
        // rows already in hand — no extra queries.
        const planned = componentVersionOf({
            issues: planIssueRows.filter(issue => ids.has(issue.targetKey)),
            intakes: intakeRows.filter(row => intakeInWindow(row.txnDate)),
            // `updatedAt` TOO, and it is not decoration: the locked re-read
            // below selects it, so leaving it out here made `newest` disagree
            // for any component with no issue and no intake — i.e. every
            // brand-new unmatched line — and no amount of replanning could
            // reconcile a fingerprint that was never computed from the same
            // fields.
            lines: componentLines.map(row => ({
                id: row.id,
                rawDescriptor: row.rawDescriptor,
                updatedAt: row.updatedAt,
            })),
            // EVERY FIELD THE PLANNER READS, not just identity: an amount, date
            // or vendor correction changes which line an expense can answer,
            // and qbPurchaseId decides which intake it unit-folds with.
            expenses: expenseRows
                .filter(row => expenseInWindow(row.date))
                .map(row => ({
                    id: row.id,
                    hasReceipt: !!row.receiptUrl || row.receiptIntake !== null,
                    amountCents: decimalStringToCents(row.amount.toString()),
                    date: row.date,
                    vendor: row.vendor,
                    qbPurchaseId: row.qbPurchaseId,
                })),
        });

        try {
            await prisma.$transaction(async tx => {
                /**
                 * 0. THE COMPONENT LOCK.
                 *
                 * Row locks cover the rows that EXIST; they cannot exclude a
                 * concurrent sweep that is about to read the same Expense and
                 * BankLine rows (ordinary reads take no lock) or insert a new
                 * competitor into the same window. One advisory lock per
                 * component, taken by every writer of that component, is what
                 * makes the fingerprint check meaningful rather than advisory:
                 * two sweeps serialize instead of both passing their checks and
                 * both writing.
                 *
                 * $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void.
                 */
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${COMPONENT_LOCK_PREFIX}${component.key}`}))`;

                // 1. LOCKS, in id order, one statement each.
                const issueKeys = [...component.lineIds].sort();
                await tx.$queryRaw`
                    SELECT "id" FROM "ReviewIssue"
                    WHERE "targetType" = ${RECEIPT_REQUEST_TARGET_TYPE}
                      AND "targetKey" = ANY(${issueKeys})
                    ORDER BY "id"
                    FOR UPDATE`;
                const candidateIntakeIds = intakeRows
                    .filter(row => intakeInWindow(row.txnDate))
                    .map(row => row.id)
                    .sort();
                if (candidateIntakeIds.length > 0) {
                    await tx.$queryRaw`
                        SELECT "id" FROM "ReceiptIntake"
                        WHERE "id" = ANY(${candidateIntakeIds})
                        ORDER BY "id"
                        FOR UPDATE`;
                }

                // 2. THE FINGERPRINT, FROM THE LOCKED ROWS.
                const current = componentVersionOf({
                    issues: await tx.reviewIssue.findMany({
                        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: { in: component.lineIds } },
                        select: { targetKey: true, updatedAt: true },
                    }),
                    intakes: await tx.receiptIntake.findMany({
                        where: { txnDate: componentRange.calendar, state: { notIn: [...DEAD_INTAKE_STATES] } },
                        select: {
                            id: true, updatedAt: true, state: true, stateReason: true,
                            totalCents: true, txnDate: true, vendor: true,
                            expenseId: true, qbPurchaseId: true,
                        },
                    }),
                    lines: await tx.bankLine.findMany({
                        // The JOIN window, not the evidence window — see
                        // `joinRange` above. A same-amount line up to
                        // `COMPETING_LINE_ADJACENCY_DAYS` past an edge could
                        // have joined this component since it was planned.
                        where: { amountCents: { in: amounts }, postedDate: joinRange.calendar },
                        select: { id: true, updatedAt: true, rawDescriptor: true },
                    }),
                    expenses: (await tx.expense.findMany({
                        where: { date: componentRange.timestamp },
                        select: {
                            id: true, amount: true, date: true, vendor: true, qbPurchaseId: true,
                            receiptUrl: true, receiptIntake: { select: { id: true } },
                        },
                    })).map(row => ({
                        id: row.id,
                        hasReceipt: !!row.receiptUrl || row.receiptIntake !== null,
                        amountCents: decimalStringToCents(row.amount.toString()),
                        date: row.date,
                        vendor: row.vendor,
                        qbPurchaseId: row.qbPurchaseId,
                    })),
                });
                if (!componentVersionsMatch(planned, current)) throw new ComponentMovedError();

                // 3. EVERY VERDICT FOR THIS COMPONENT, IN THIS TRANSACTION.
                //
                // The lifecycle opens its own transaction; handed this one it
                // would nest, which Prisma's interactive client cannot do. The
                // shim flattens it so the callback runs against the SAME tx and
                // one component's writes share one atomic unit.
                const flattened: {
                    reviewIssue: typeof tx.reviewIssue;
                    reviewAlertEpisode: typeof tx.reviewAlertEpisode;
                    $transaction: <T>(fn: (inner: unknown) => Promise<T>) => Promise<T>;
                } = {
                    reviewIssue: tx.reviewIssue,
                    reviewAlertEpisode: tx.reviewAlertEpisode,
                    // The flattening: the lifecycle asks for a transaction and
                    // gets THIS one, so its writes join the component's unit
                    // instead of opening a nested one Prisma cannot give it.
                    $transaction: async fn => fn(flattened),
                };

                const applied = await applyReceiptRequestPlan(
                    { open: componentOpen, close: componentClose, undecided: [] },
                    async (targetKey, codes, displayDetails) => {
                        const fresh = await tx.reviewIssue.findUnique({
                            where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey } },
                            select: { displayDetails: true, clearedAt: true },
                        });
                        const freshDetails = fresh
                            ? parseMissingReceiptDetails(fresh.displayDetails)
                            : detailsByKey.get(targetKey) ?? {};

                        // A resolution that appeared since the snapshot: do not
                        // reopen. Belt and braces now that the rows are locked.
                        if (codes.length > 0 && hasResolution(freshDetails)) {
                            return { decision: { step: 1, action: "noop", canonicalCodes: [], reasonHash: "" }, applied: false };
                        }

                        return evaluateReviewIssue(
                            RECEIPT_REQUEST_TARGET_TYPE,
                            targetKey,
                            codes,
                            displayDetails ? mergeReceiptRequestDetails(freshDetails, displayDetails) : null,
                            {
                                client: flattened as unknown as ReviewIssueLifecycleClient,
                                // Delivery is the per-owner digest, never the
                                // per-issue drainer.
                                episodeStatus: "SUPPRESSED",
                                // Under these locks a version conflict cannot
                                // happen, so this hook is unreachable today.
                                // It stays wired because it is the correct
                                // answer if the locking is ever relaxed, and an
                                // unreachable-but-right retry costs nothing.
                                recomputeCodes: () => recomputeCodesFor(targetKey),
                            },
                        );
                    },
                    // A verdict that throws ABORTS THE COMPONENT. Counting it
                    // and carrying on would let the verdicts that already
                    // succeeded commit with this transaction — a half-applied
                    // allocation, which is the one outcome "all or nothing"
                    // was written to prevent. The catch below records it and
                    // the cursor stops, so the next run redoes the component.
                    { abortOnError: true },
                );
                summary.opened += applied.opened;
                summary.closed += applied.closed;
                summary.touched += applied.touched;
                summary.skipped += applied.skipped;
                summary.errors += applied.errors;
                summary.failedTargets.push(...applied.failedTargets);
            }, { timeout: COMPONENT_TX_TIMEOUT_MS });
        } catch (error) {
            if (error instanceof ComponentMovedError) {
                // NOTHING COMMITTED for this component. The caller replans the
                // batch rather than half-applying a plan drawn from a world
                // that moved.
                return {
                    summary: emptySummary(),
                    undecided: componentOpen.length + componentClose.length,
                    replan: true,
                };
            }
            // Any other failure also wrote nothing: counted, reported, and the
            // cursor will not step past it.
            summary.errors++;
            summary.failedTargets.push(...component.lineIds);
            console.error("[cron/receipt-requests] component transaction failed", component.key,
                error instanceof Error ? error.message : "UnknownError");
        }
    }

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
    //
    // ONE query for every issue in the sweep, parsed once and reused by every
    // batch — the bulk half of the lifecycle work. The per-issue FRESH read
    // before each write stays, and so does the RELOAD on every replan: it is
    // what stops a memo signed mid-run from being un-answered, and no amount of
    // bulking is worth losing that.
    const { openIssues, resolvedIssueKeys, detailsByKey } = await loadIssueSnapshot();

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
    // Batches this pass could not reconcile at all (replans exhausted). Unlike
    // `openUndecided` this BLOCKS the completion stamp — see sweepPhaseAfter.
    let openContended = 0;
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
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, updatedAt: true },
        });

        // AN ISSUE WHOSE BANK LINE IS GONE can never be answered: the matcher
        // has nothing to match, so it would be skipped forever and nag forever.
        // A deleted or re-imported statement line is a real thing that happens.
        // Close it with a reason a human can read rather than leaving a chase
        // pointing at nothing.
        const present = new Set(lines.map(line => line.id));
        const orphaned = page.filter(issue => !present.has(issue.targetKey));
        // ANY failure on THIS page stops the checkpoint. An orphan close that
        // threw used to be counted and then stepped over, and a later
        // `?continue=1` could finish the pass and clear the cursor — stranding
        // that issue permanently, nagging with a target nothing can answer.
        let pageErrors = 0;
        let pageContended = 0;
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
                pageErrors++;
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
            openContended += outcome.contended;
            pageErrors += outcome.summary.errors;
            pageContended += outcome.contended;
        }

        // Same rule as the line pass: never checkpoint past a failure — from
        // EITHER half of this page. A contended component was never reconciled
        // (see processBatchWithReplan) — advancing past it strands the page it
        // sat on just as surely as an error would.
        if (pageErrors > 0 || pageContended > 0) break;

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
    let lineContended = 0;
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
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, updatedAt: true },
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
        let pageContended = 0;
        for (const [rows, mode] of [
            [interiorBatch, "window"],
            [boundaryBatch, "closure"],
        ] as const) {
            if (rows.length === 0) continue;
            const outcome = await processBatchWithReplan(rows, openIssues, resolvedIssueKeys, detailsByKey, now, mode);
            replans += outcome.replans;
            undecided += outcome.undecided;
            lineContended += outcome.contended;
            totals.opened += outcome.summary.opened;
            totals.closed += outcome.summary.closed;
            totals.touched += outcome.summary.touched;
            totals.skipped += outcome.summary.skipped;
            totals.errors += outcome.summary.errors;
            totals.failedTargets.push(...outcome.summary.failedTargets);
            pageErrors += outcome.summary.errors;
            pageContended += outcome.contended;
        }
        batches++;
        linesSeen += batch.length;

        // THE CURSOR STOPS AT THE FIRST FAILURE — OR AT UNRESOLVED CONTENTION.
        // Advancing past a target whose write threw is how a row that fails
        // every night is never chased: the sweep would step over it forever and
        // report a clean run. A contended component (processBatchWithReplan
        // exhausted its replans) was never reconciled either — it has no
        // verdict, so checkpointing past its page persists a cursor beyond a
        // page nothing was decided for, same as an error would. A failed or
        // contended batch keeps its cursor so the next invocation retries the
        // same ground; the lifecycle writes are idempotent, so re-running is
        // free.
        if (pageErrors > 0 || pageContended > 0) break;

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
    const computedPhase = sweepPhaseAfter({
        openExhausted,
        openErrors: openPass.errors,
        openContended,
        lineExhausted: exhausted,
        lineErrors: totals.errors - openPass.errors,
        lineContended,
    });

    // THE REGISTER THIS CYCLE READ HAS TO HAVE BEEN CURRENT.
    //
    // Read at the END, not the start: the pull runs on its own schedule and can
    // land while this sweep is working, and the question is whether the ledger
    // the cycle is about to certify is complete — not whether it was complete
    // when the cycle began.
    //
    // A stale pull does NOT stop the sweep. Every close it just made is still
    // right (a receipt that arrived is a receipt that arrived), and so is every
    // chase it opened against a line that does exist. What is not right is
    // calling the cycle finished: the pull's failure means lines are MISSING,
    // and those charges would go unchased while the morning card said the list
    // was complete.
    //
    // So the completion stamp is withheld AND the phase is held open at
    // "lines". Leaving it "done" would make `shouldResumeSweep` answer false,
    // the every-15-minutes resume would exit with "nothing-in-progress", and a
    // pull that recovered at 03:00 could never be picked up — today's cards
    // would be lost to a pull outage that had already been fixed. Held at
    // "lines", the next continuation re-runs the line pass and stamps as soon
    // as the marker is fresh, with hours to spare before the 14:30 cards.
    const bankPull = await readBankPullFreshness(new Date());
    const bankPullStale = !bankPull.fresh;
    const decision = sweepCompletionDecision({ computedPhase, bankPullStale });
    const phase = decision.phase;
    // A CLEAN, COMPLETE cycle stamps the clock the cards cron reads. Anything
    // else leaves the previous stamp alone: yesterday's completion is still a
    // true statement about yesterday, and the cards cron compares it to TODAY.
    //
    // "Anything else" INCLUDES a run that left contended work behind. The stamp
    // is a claim that tonight's issue set is reconciled, and a component nobody
    // could reconcile makes that claim false.
    await writePhase(
        phase,
        decision.complete ? new Date().toISOString() : undefined,
        decision.blockedReason,
    );

    const result = {
        ok: totals.errors === 0,
        phase,
        // Why this cycle is not stamping complete, when that is the reason.
        // Named in the summary as well as the marker so a cron log answers the
        // question without a database read.
        ...(bankPullStale ? { reason: BANK_PULL_STALE_REASON } : {}),
        bankPull: { fresh: bankPull.fresh, lastSuccessAt: bankPull.lastSuccessAt },
        window: { start: windowStart, end: windowEnd },
        batches,
        openBatches,
        openIssueCursor: openCursor,
        openIssuesExhausted: openExhausted,
        targetMissing,
        replans,
        bankLines: linesSeen,
        undecided,
        // The share of `undecided` that was CONTENDED — no verdict because the
        // component kept moving. It is the part that blocks the completion
        // stamp and comes back on the next run.
        contended: openContended + lineContended,
        exhausted,
        // Work remains if EITHER pass has more to do — including a pass that
        // exhausted its pages but left a component unreconciled, and including a
        // cycle held open because the register it read was not current.
        moreToProcess: !exhausted || !openExhausted || openContended > 0 || lineContended > 0 || bankPullStale,
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
