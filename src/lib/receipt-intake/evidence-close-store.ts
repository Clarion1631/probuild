/**
 * The evidence-driven close (spec Amendment 2, §A2.3): when a receipt books,
 * re-judge the missing-receipt requests that booking could possibly answer,
 * instead of waiting for a nightly sweep that a stream of bookings keeps
 * restarting.
 *
 * SIX PROPERTIES, and each one is a test in tests/receipt-evidence-close.test.ts:
 *
 * 1. NO SECOND MATCHER. Candidate GENERATION is wider than the matcher (see
 *    `candidateBankLineQuery`); the VERDICT is always `recomputeCodesFor`,
 *    which walks the true competing component and runs the same `satisfies()`.
 *    That walk still only ever runs for candidates THIS call's own query
 *    found: component siblings and pinned-pair bindings that sit outside this
 *    evidence's own amount+date window are the sweep's job to reach, through
 *    its own per-issue pass over every bank line. So the fast path is a
 *    SUBSET, never a superset, of what a full sweep cycle would close.
 * 2. SUBTRACTIVE ONLY. The single write is `evaluateReviewIssue(..., [], ...)`,
 *    and an empty reason set can only ever reach `clear` or `noop`
 *    (`decideLifecycle` step 1). It cannot create an issue, cannot reopen one,
 *    and touches no cycle record, no cursor and no `chaserCompletedAt` — so it
 *    can never make a chase card go out earlier or larger. That is what makes
 *    it safe to run outside a certified cycle: the fence exists to stop a card
 *    being SELECTED from an incompletely judged ledger, and this selects
 *    nothing.
 * 3. IDEMPOTENT. That write is the CAS'd lifecycle, which returns `noop` when
 *    the codes are unchanged — and only a genuine `clear` is ever counted in
 *    `cleared`; a `noop` (something else cleared the issue in the gap between
 *    this call's own open-issue read and its apply) counts for nothing. A
 *    second run over the same booking clears once either way.
 * 4. LENIENT. `strictCompleteness` is left at its default `false` — but
 *    leniency does not change WHICH verdicts clear. `recomputeCodesFor` never
 *    treats a component it could not fully verify as answered, under either
 *    setting, so strict and lenient reach the same empty-vs-not-empty verdict
 *    whenever strict would have returned one at all. What strict adds on top
 *    is two THROWS instead — on an oversized competing component, and on an
 *    active outreach hold — and this path must never throw (see BOUNDED
 *    below), so strict is simply incompatible with it. Freshness against a
 *    moving ledger is a separate concern; see FENCED.
 * 5. FENCED. `receiptEvidenceEpoch` and `bankLedgerEpoch` — the same two
 *    counters the sweep's own completion fence reads (receipt-evidence-lock.ts
 *    / bank-ledger-epoch.ts) — are read once before judging and again right
 *    before applying. If either moved, every remaining clear is withheld and
 *    counted `stale` instead of written: the CAS on an issue's own version
 *    catches a concurrent write to THAT row, but says nothing about whether
 *    the evidence or ledger a verdict was reasoned from is still what is on
 *    disk. Self-correcting either way — a clear that lands stale is simply
 *    never written, and the next certified sweep re-judges the line from
 *    current data and reopens it if it is genuinely still owed.
 * 6. BOUNDED AND BEST EFFORT. One indexed candidate query
 *    (MAX_EVIDENCE_CLOSE_QUERY_ROWS rows), at most MAX_EVIDENCE_CLOSE_CANDIDATES
 *    recomputes — capped AFTER the open-issue filter, not before, so a run of
 *    already-resolved lines cannot shadow a genuine open one sitting behind
 *    them — the caller's deadline threaded into each one, and every failure
 *    counted and swallowed, including a failure in the candidate query, the
 *    open-issue lookup, or the epoch read itself. The money has already
 *    moved; a failed courtesy close must not disturb it, and the nightly
 *    sweep is still the backstop.
 *
 * Injection over mocking throughout: the `deps` bag is the same seam
 * `receipt-request-cards/route.ts:390,415` uses, and it is what lets every test
 * run with no database and without `mock.module`, which CI's Node 20 cannot do.
 */
import { prisma } from "@/lib/prisma";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import {
    decimalStringToCents,
    isComponentDeadlineExceeded,
    RECEIPT_REQUEST_TARGET_TYPE,
} from "@/lib/receipt-requests";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import type { ReasonCode } from "@/lib/review-alert-reasons";
// THE FRESHNESS FENCE'S two readers (see FENCED in the module header) — the
// SAME functions the sweep's own completion fence and
// receipt-on-demand-store.ts already read these settings through. Never a
// second key, and never the LOCK or BUMP half of either module: this call
// only ever observes the counters, it must not contend for the sweep's own
// advisory lock or perturb the very thing it is fencing against.
import { readReceiptEvidenceEpoch } from "@/lib/receipt-evidence-lock";
import { readBankLedgerEpoch } from "@/lib/bank-ledger-epoch";
// The sweep's own judge and the sweep's own window width — imported rather than
// re-derived, so there is exactly one of each. `receipt-on-demand-store.ts:16`
// already imports from this route module, so a lib depending on it is an
// established shape. Nothing in `worker.ts` imports this file: the worker sees
// only an optional dependency, wired by the cron route.
import { EVIDENCE_LOOKBACK_DAYS, recomputeCodesFor } from "@/app/api/cron/receipt-requests/route";
import {
    candidateBankLineQuery,
    MAX_EVIDENCE_CLOSE_CANDIDATES,
    MAX_EVIDENCE_CLOSE_QUERY_ROWS,
    type BookedEvidence,
    type CandidateBankLineQuery,
} from "./evidence-close";

/** One instant's reading of both source-evidence counters — see FENCED above. */
export interface EpochSnapshot {
    evidence: string;
    ledger: string;
}

export interface EvidenceCloseDeps {
    findLines?: (query: CandidateBankLineQuery) => Promise<Array<{ id: string }>>;
    /** Which of those lines have an OPEN missing-receipt issue right now,
     *  mapped to that issue's OWN id — not just its targetKey — so a judged
     *  candidate can be logged with something pasteable into a row lookup. */
    openIssueKeys?: (ids: string[]) => Promise<Map<string, string>>;
    recompute?: (
        targetKey: string,
        cache?: Map<string, ReasonCode[]>,
        deadlineExceeded?: () => boolean,
    ) => Promise<ReasonCode[]>;
    /** Resolves to whether the write was an actual CLEAR — never true for a noop (see IDEMPOTENT). */
    applyCodes?: (targetKey: string, codes: ReasonCode[]) => Promise<boolean>;
    /** The CALLER's absolute clock — the worker invocation's, not a fresh one. */
    deadlineExceeded?: () => boolean;
    /** Overridable only so the window is testable; production uses the sweep's. */
    lookbackDays?: number;
    /**
     * Read {evidence, ledger} once — see FENCED above. Injected so the fence
     * is testable without a database; production reads the same settings the
     * sweep and receipt-on-demand-store.ts do.
     */
    readEpochs?: () => Promise<EpochSnapshot>;
}

/**
 * A candidate the judge looked at and left OPEN — ids only, never a
 * descriptor, amount or payee, so this is safe to log verbatim.
 */
export interface JudgedCandidate {
    lineId: string;
    issueId: string;
    codes: ReasonCode[];
}

export interface EvidenceCloseResult {
    /** Candidates considered, open issue or not. */
    examined: number;
    /** Target keys whose issue this call cleared. */
    cleared: string[];
    /** Candidates whose verdict or write threw. Never a verdict. */
    errors: number;
    /**
     * Clears withheld because `receiptEvidenceEpoch` or `bankLedgerEpoch`
     * moved between judging and applying (see FENCED). Zero lifecycle writes
     * happened for these — nothing is lost, only deferred: the next certified
     * sweep re-judges the line from current data and reopens it if it is
     * genuinely still owed.
     */
    stale: number;
    /**
     * Candidates the judge looked at and left OPEN (a non-empty verdict) —
     * the one place a case that stays open is explained without a database
     * query. Bounded by the same cap as everything else here
     * (MAX_EVIDENCE_CLOSE_CANDIDATES): every openExamined candidate lands in
     * either this or `toClear`, never both.
     */
    judged: JudgedCandidate[];
}

async function defaultFindLines(query: CandidateBankLineQuery): Promise<Array<{ id: string }>> {
    return prisma.bankLine.findMany({
        where: {
            amountCents: query.amountCents,
            // `BankLine.postedDate` is `@db.Date` — calendar bounds, inclusive
            // at both ends, read the same way the sweep reads them.
            postedDate: {
                gte: new Date(`${query.fromYmd}T00:00:00Z`),
                lte: new Date(`${query.toYmd}T00:00:00Z`),
            },
        },
        // WIDER than MAX_EVIDENCE_CLOSE_CANDIDATES on purpose (see
        // MAX_EVIDENCE_CLOSE_QUERY_ROWS): the cap that bounds actual WORK —
        // recomputes — is applied in closeRequestsSatisfiedBy, AFTER the
        // open-issue filter runs, not here against the raw rows.
        take: MAX_EVIDENCE_CLOSE_QUERY_ROWS,
        orderBy: [{ postedDate: "asc" }, { id: "asc" }],
        select: { id: true },
    });
}

async function defaultOpenIssueKeys(ids: string[]): Promise<Map<string, string>> {
    const rows = await prisma.reviewIssue.findMany({
        where: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: { in: ids }, clearedAt: null },
        // `id` alongside `targetKey`, in the SAME query — not a second round
        // trip — so a judged candidate can be logged with the issue's own id.
        select: { targetKey: true, id: true },
    });
    return new Map(rows.map(row => [row.targetKey, row.id]));
}

/**
 * THE ONLY WRITE THIS MODULE MAKES, and it refuses to be anything but a clear.
 *
 * `displayDetails` is null on purpose: the lifecycle's `clear` branch writes
 * `clearedAt`, the acknowledgement columns and the version, and never touches
 * the details blob — exactly as the sweep's own close does
 * (`applyReceiptRequestPlan`'s `evaluate(targetKey, [], null)`).
 *
 * Returns whether the lifecycle's OWN decision was `clear` — false for `noop`
 * (something else already cleared this issue since the open-issue read), so
 * a caller never counts a write that did not actually happen (see IDEMPOTENT
 * in the module header).
 */
async function defaultApplyCodes(targetKey: string, codes: ReasonCode[]): Promise<boolean> {
    // Structural already (the caller only reaches here on an empty verdict);
    // asserted anyway, because "subtractive" is the property that lets this
    // path run without a certified cycle.
    if (codes.length > 0) throw new Error("evidence-close may only clear an issue, never open one");
    const { decision } = await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, codes, null, {
        // Delivery is the per-owner digest, never the per-issue drainer — the
        // same choice the sweep makes for every receipt-request write.
        episodeStatus: "SUPPRESSED",
    });
    return decision.action === "clear";
}

/**
 * Production's `readEpochs` (see FENCED in the module header): the same two
 * counters, read through the same functions the sweep's own completion fence
 * and receipt-on-demand-store.ts already use. Read-only — never the lock,
 * never the bump — so this fence cannot itself contend for the sweep's
 * advisory lock or perturb the counters it is comparing against.
 */
async function defaultReadEpochs(): Promise<EpochSnapshot> {
    const [evidence, ledger] = await Promise.all([
        readReceiptEvidenceEpoch(prisma),
        readBankLedgerEpoch(prisma),
    ]);
    return { evidence, ledger };
}

/**
 * Re-judge every missing-receipt request this booking could answer, and close
 * the ones the judge now says are answered.
 *
 * Never throws: a caller on the money path is told what happened through the
 * counts, not through control flow.
 */
export async function closeRequestsSatisfiedBy(
    evidence: BookedEvidence,
    deps: EvidenceCloseDeps = {},
): Promise<EvidenceCloseResult> {
    const result: EvidenceCloseResult = { examined: 0, cleared: [], errors: 0, stale: 0, judged: [] };
    const deadlineExceeded = deps.deadlineExceeded ?? (() => false);
    const query = candidateBankLineQuery(evidence, deps.lookbackDays ?? EVIDENCE_LOOKBACK_DAYS);
    if (!query || deadlineExceeded()) return result;

    const findLines = deps.findLines ?? defaultFindLines;
    const openIssueKeys = deps.openIssueKeys ?? defaultOpenIssueKeys;
    const readEpochs = deps.readEpochs ?? defaultReadEpochs;
    const recompute = deps.recompute ?? recomputeCodesFor;
    const applyCodes = deps.applyCodes ?? defaultApplyCodes;

    // SETUP: the candidate query, the open-issue lookup, and the freshness
    // snapshot every verdict below will be measured against (see FENCED). A
    // failure in any of the three is a READ, not a verdict — counted and
    // swallowed like every other failure here, never thrown.
    let lines: Array<{ id: string }>;
    let open: Map<string, string>;
    let epochBefore: EpochSnapshot;
    try {
        lines = await findLines(query);
        if (lines.length === 0) return result;
        open = await openIssueKeys(lines.map(line => line.id));
        // READ ONCE BEFORE JUDGING — see FENCED in the module header.
        epochBefore = await readEpochs();
    } catch (error) {
        result.errors++;
        console.warn("[receipt-intake/evidence-close] setup failed",
            error instanceof Error ? error.message : "UnknownError");
        return result;
    }

    // ONE cache for the call: a recompute writes every member of the competing
    // component it walked, so same-amount siblings become map reads instead of
    // a second identical traversal. Scoped to this booking, never shared across
    // bookings — a verdict computed before another booking landed is stale.
    const cache = new Map<string, ReasonCode[]>();
    const toClear: string[] = [];
    // The cap (MAX_EVIDENCE_CLOSE_CANDIDATES) is measured against THIS, not
    // against `result.examined` — see that constant's own comment on why it
    // has to be counted after the open-issue filter, not before.
    let openExamined = 0;

    for (const line of lines) {
        if (openExamined >= MAX_EVIDENCE_CLOSE_CANDIDATES) break;
        if (deadlineExceeded()) {
            console.warn("[receipt-intake/evidence-close] out of budget; leaving the rest to the sweep");
            break;
        }
        result.examined++;
        // A line with no OPEN issue has nothing to subtract. Skipping it here
        // rather than after the recompute is also what keeps this path from
        // being able to reopen a cleared one.
        if (!open.has(line.id)) continue;
        openExamined++;
        try {
            const codes = await recompute(line.id, cache, deadlineExceeded);
            // STILL OWED. There is no force-close: a non-empty verdict leaves
            // the issue exactly as it was — but it is RECORDED, ids only, so a
            // case that stays open is explained without a database query
            // (production case, 2026-09-21: the planner said "close" for
            // ARCO $93.09, the sweep judged it and left it open with no error,
            // and nobody could see why).
            if (codes.length > 0) {
                result.judged.push({ lineId: line.id, issueId: open.get(line.id)!, codes });
                continue;
            }
            toClear.push(line.id);
        } catch (error) {
            result.errors++;
            console.warn("[receipt-intake/evidence-close] candidate failed", line.id,
                error instanceof Error ? error.message : "UnknownError");
            // The clock is not going to come back. Retrying the next candidate
            // would only spend another round trip to throw the same way.
            if (isComponentDeadlineExceeded(error)) break;
        }
    }

    // THE SINGLE END-OF-CALL SUMMARY of everything judged and left open —
    // logged once, right after judging, independent of whatever the
    // freshness check or the apply loop below decide: this reports what the
    // JUDGE saw, not what got written. Ids only — never a descriptor, amount
    // or payee — so it is safe to log verbatim. Wrapped: a logging failure
    // must not be how this "never throws" module throws.
    if (result.judged.length > 0) {
        try {
            console.warn("[receipt-intake/evidence-close] judged, not cleared",
                JSON.stringify({ judged: result.judged }));
        } catch {
            // Never let a logging failure escape — see the module header.
        }
    }

    if (toClear.length === 0) return result;

    // READ AGAIN, RIGHT BEFORE APPLYING — see FENCED. Evidence or the ledger
    // moving under us since `epochBefore` means the verdicts above may already
    // be wrong, and the CAS on each issue's own version cannot see that: it
    // only fences the issue row, not the evidence or ledger a verdict was
    // reasoned from. Every remaining clear is withheld rather than written on
    // a stale read. Self-correcting either way: the next certified sweep
    // re-judges the line from current data and reopens it if it is genuinely
    // still owed.
    let epochAfter: EpochSnapshot;
    try {
        epochAfter = await readEpochs();
    } catch (error) {
        result.errors++;
        console.warn("[receipt-intake/evidence-close] freshness re-check failed",
            error instanceof Error ? error.message : "UnknownError");
        return result;
    }
    if (epochAfter.evidence !== epochBefore.evidence || epochAfter.ledger !== epochBefore.ledger) {
        result.stale += toClear.length;
        console.warn("[receipt-intake/evidence-close] evidence or ledger moved since judging; leaving the clears to the next certified sweep");
        return result;
    }

    for (const targetKey of toClear) {
        try {
            const cleared = await applyCodes(targetKey, []);
            // Only a genuine `clear` is counted — a `noop` (something else
            // cleared it first) is not this call's doing (see IDEMPOTENT).
            if (cleared) result.cleared.push(targetKey);
        } catch (error) {
            result.errors++;
            console.warn("[receipt-intake/evidence-close] clear failed", targetKey,
                error instanceof Error ? error.message : "UnknownError");
        }
    }

    return result;
}

/**
 * What the booking that just committed knows about itself, read back off the
 * Expense it produced.
 *
 * The EXPENSE is the source, not the intake row: it carries the amount that was
 * actually booked, which is the figure the bank charge will match. Null when
 * there is nothing usable to propose candidates from — a vanished row, a
 * non-positive amount — and the caller then does nothing at all.
 */
export async function loadBookedEvidence(expenseId: string): Promise<BookedEvidence | null> {
    const row = await prisma.expense.findUnique({
        where: { id: expenseId },
        select: { amount: true, date: true },
    });
    if (!row) return null;
    const totalCents = decimalStringToCents(row.amount.toString());
    if (totalCents === null || totalCents <= 0) return null;
    // COMPANY-LOCAL DAYS, like every other date in this pipeline: `Expense.date`
    // is a TIMESTAMP, so its calendar day is the company's, never UTC's.
    const zone = await resolveCompanyTimeZone();
    return {
        totalCents,
        txnDate: row.date ? dayKeyInTimeZone(row.date, zone) : null,
        bookedOn: dayKeyInTimeZone(new Date(), zone),
    };
}
