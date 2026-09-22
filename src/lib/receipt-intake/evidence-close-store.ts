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
 * 2. SUBTRACTIVE, on the write this call itself decides to make. The FIRST
 *    attempt at every apply is always `evaluateReviewIssue(..., [], ...)` —
 *    an empty reason set that can only ever reach `clear` or `noop`
 *    (`decideLifecycle` step 1); it cannot create an issue, cannot reopen
 *    one, and touches no cycle record, no cursor and no `chaserCompletedAt`.
 *    A version-conflict RETRY on that same write is the one documented
 *    exception — see FENCED below, blocker 1b, for what it can reach and why
 *    that is still correct rather than a hole in this property.
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
 * 5. FENCED, PER APPLY. `receiptEvidenceEpoch` and `bankLedgerEpoch` — the
 *    same two counters the sweep's own completion fence reads
 *    (receipt-evidence-lock.ts / bank-ledger-epoch.ts) — are read once before
 *    judging and again immediately before EACH lifecycle apply, not once for
 *    the whole batch: an epoch that moves between two applies withholds the
 *    second one (and everything still queued behind it), counted `stale`,
 *    without disturbing the first, which already committed under evidence
 *    that was still current when it ran. The CAS on an issue's own version
 *    catches a concurrent write to THAT row; it says nothing about whether
 *    the evidence or ledger a verdict was reasoned from is still what is on
 *    disk, which is what this second read is for.
 *
 *    THE EXACT RESIDUAL, stated honestly (Codex round 3): the read and the
 *    write are still two separate round trips, not one atomic operation. A
 *    write already IN FLIGHT when an epoch bumps can still land after that
 *    bump — the read confirmed freshness a moment before the write, not AT
 *    the write. Such a write is not wrong when it lands (the evidence it
 *    read was real at the time it read it), but it can be STALE by the time
 *    it commits. The next certified sweep re-judges the line from current
 *    data regardless and reopens it if the clear no longer holds, so a
 *    stale-landing write self-corrects within one nightly cycle rather than
 *    persisting silently — it is not left uncaught. Closing this gap for
 *    real needs an atomic version taken under the SAME writer locks the
 *    sweep uses. That is a documented follow-up, not done here, because
 *    taking that lock from the booking path changes its lock order and
 *    deserves its own review rather than riding in on this one.
 *
 *    THE VERSION-CONFLICT RETRY (blocker 1b) is what makes the per-apply
 *    read meaningful rather than decorative: `defaultApplyCodes` passes
 *    `recomputeCodes` — the SAME `recomputeCodesFor`, the SAME shared cache
 *    — into `evaluateReviewIssue`'s own retry option, so a lost CAS re-judges
 *    from current data instead of replaying the `[]` this call already
 *    decided on. A re-judge that comes back non-empty leaves the issue open:
 *    `decideLifecycle` can reach `touch`, `suppress` or `supersede` for it
 *    (never `create` — the row already exists), and `reopen` only in the
 *    narrow case where some OTHER writer cleared this exact row in the same
 *    window and the fresh re-judge disagrees with that clear. Every one of
 *    those is `decideLifecycle`'s own general-purpose, already-correct
 *    behavior — this module is not re-deriving it, only feeding it the truth
 *    instead of a stale snapshot.
 * 6. BOUNDED AND BEST EFFORT. One indexed candidate query, capped at
 *    `MAX_EVIDENCE_CLOSE_QUERY_ROWS` (50) raw rows; at most
 *    `MAX_EVIDENCE_CLOSE_CANDIDATES` (10) recomputes, capped AFTER the
 *    open-issue filter runs against all 50, never against the raw rows — a
 *    resolved (non-open) row costs one cheap Map lookup, never a recompute,
 *    so resolved rows cannot consume any of the ten-recompute budget as long
 *    as the window holds 50 candidates or fewer. A window with MORE than 50
 *    is the one accepted limitation: candidates past the 50th are never
 *    fetched at all, and this call simply cannot see them — truncation, not
 *    a repeat of the shadowing bug the two-cap split exists to fix. The
 *    caller's deadline is threaded through every phase — setup, judging,
 *    and immediately before each apply — and no new apply is ever started
 *    once it fires. Every failure, including one in the candidate query, the
 *    open-issue lookup, or an epoch read, is counted and swallowed. The
 *    money has already moved; a failed courtesy close must not disturb it,
 *    and the nightly sweep is still the backstop.
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
    /**
     * Resolves to whether the write was an actual CLEAR — never true for a
     * noop (see IDEMPOTENT). `recomputeCodes` is what a version-conflict
     * retry re-judges from — see FENCED, blocker 1b — and MUST be the same
     * `recompute(targetKey, cache, deadlineExceeded)` the judge phase used,
     * never a fresh one.
     */
    applyCodes?: (
        targetKey: string,
        codes: ReasonCode[],
        recomputeCodes: () => Promise<ReasonCode[]>,
    ) => Promise<boolean>;
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
 * A bounded classification for a caught error — the error's own NAME (e.g.
 * "PrismaClientKnownRequestError", "ComponentDeadlineExceededError"), never
 * its message. A message can echo query parameters or other unbounded text;
 * a name is one of a small, fixed set, so every warn line in this module
 * stays ids-only, the same way `judged` does (Codex round 3, should-fix 2).
 */
function errorCategory(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
}

/**
 * THE ONLY WRITE THIS MODULE MAKES, and it refuses to be anything but a clear
 * — on the FIRST attempt. See FENCED (blocker 1b) in the module header for
 * what a version-conflict retry can reach and why.
 *
 * `displayDetails` is null on purpose: the lifecycle's `clear` branch writes
 * `clearedAt`, the acknowledgement columns and the version, and never touches
 * the details blob — exactly as the sweep's own close does
 * (`applyReceiptRequestPlan`'s `evaluate(targetKey, [], null)`).
 *
 * `recomputeCodes` is handed straight to `evaluateReviewIssue`'s own retry
 * option — never invoked here directly. It is what lets a lost CAS re-judge
 * from current data instead of blindly reapplying the `[]` this call already
 * decided on moments ago.
 *
 * Returns whether the lifecycle's OWN decision was `clear` — false for `noop`
 * (something else already cleared this issue since the open-issue read) and
 * false for whatever a non-empty retry re-judge reached instead, so a caller
 * never counts a write that did not actually happen (see IDEMPOTENT in the
 * module header).
 */
async function defaultApplyCodes(
    targetKey: string,
    codes: ReasonCode[],
    recomputeCodes: () => Promise<ReasonCode[]>,
): Promise<boolean> {
    // Structural already (the caller only reaches here on an empty verdict);
    // asserted anyway, because "subtractive" is the property that lets this
    // path run without a certified cycle.
    if (codes.length > 0) throw new Error("evidence-close may only clear an issue, never open one");
    const { decision } = await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, codes, null, {
        // Delivery is the per-owner digest, never the per-issue drainer — the
        // same choice the sweep makes for every receipt-request write.
        episodeStatus: "SUPPRESSED",
        recomputeCodes,
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
    // swallowed like every other failure here, never thrown. The deadline is
    // also checked BETWEEN these reads (Codex round 3, blocker 1c): none of
    // them is free, and starting the next one after the invocation's own
    // budget is gone would only spend a round trip on nothing.
    let lines: Array<{ id: string }>;
    let open: Map<string, string>;
    let epochBefore: EpochSnapshot;
    try {
        lines = await findLines(query);
        if (lines.length === 0) return result;
        if (deadlineExceeded()) {
            console.warn("[receipt-intake/evidence-close] out of budget during setup; leaving the rest to the sweep");
            return result;
        }
        open = await openIssueKeys(lines.map(line => line.id));
        if (deadlineExceeded()) {
            console.warn("[receipt-intake/evidence-close] out of budget during setup; leaving the rest to the sweep");
            return result;
        }
        // READ ONCE BEFORE JUDGING — see FENCED in the module header.
        epochBefore = await readEpochs();
    } catch (error) {
        result.errors++;
        console.warn("[receipt-intake/evidence-close] setup failed", errorCategory(error));
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
            console.warn("[receipt-intake/evidence-close] candidate failed", line.id, errorCategory(error));
            // The clock is not going to come back. Retrying the next candidate
            // would only spend another round trip to throw the same way.
            if (isComponentDeadlineExceeded(error)) break;
        }
    }

    // THE SINGLE END-OF-CALL SUMMARY of everything judged and left open —
    // logged ONCE here, not repeated by the caller (route.ts's own summary
    // carries only a count — see closeRequestsSatisfiedByEvidence's call
    // site). Right after judging, independent of whatever the freshness
    // checks or the apply loop below decide: this reports what the JUDGE
    // saw, not what got written. Ids only — never a descriptor, amount or
    // payee — so it is safe to log verbatim. Wrapped: a logging failure must
    // not be how this "never throws" module throws.
    if (result.judged.length > 0) {
        try {
            console.warn("[receipt-intake/evidence-close] judged, not cleared",
                JSON.stringify({ judged: result.judged }));
        } catch {
            // Never let a logging failure escape — see the module header.
        }
    }

    if (toClear.length === 0) return result;

    // AFTER JUDGING, BEFORE APPLYING (Codex round 3, blocker 1c): the judge
    // loop above can spend real time — each recompute is a full competing-
    // component walk — so check once more before starting the write phase,
    // rather than letting it fall through into the first apply's own reads.
    if (deadlineExceeded()) {
        console.warn("[receipt-intake/evidence-close] out of budget after judging; leaving the applies to the sweep");
        return result;
    }

    // APPLY, one candidate at a time, each with its OWN fresh epoch read
    // (Codex round 3 blocker: the batch-level read-then-apply was still
    // read-read, not atomic — see FENCED for the exact residual that remains
    // even with this). `epochBefore` stays the single reference point for
    // every apply, not a rolling "since the last one": each is measured
    // against what judging actually saw.
    for (let i = 0; i < toClear.length; i++) {
        if (deadlineExceeded()) {
            console.warn("[receipt-intake/evidence-close] out of budget before an apply; leaving the rest to the sweep");
            break;
        }

        let epochNow: EpochSnapshot;
        try {
            epochNow = await readEpochs();
        } catch (error) {
            result.errors++;
            console.warn("[receipt-intake/evidence-close] freshness re-check failed", errorCategory(error));
            break;
        }
        if (epochNow.evidence !== epochBefore.evidence || epochNow.ledger !== epochBefore.ledger) {
            // THIS candidate and everything still queued behind it — none of
            // it was judged against evidence that is still current.
            result.stale += toClear.length - i;
            console.warn("[receipt-intake/evidence-close] evidence or ledger moved before an apply; leaving the rest to the next certified sweep");
            break;
        }

        const targetKey = toClear[i];
        try {
            // A version conflict on the write itself means someone else
            // committed to THIS row between the read just above and the
            // write about to happen. `recomputeCodes` lets the lifecycle's
            // own retry re-judge from current data — the SAME recompute, the
            // SAME cache — instead of replaying the `[]` this call already
            // decided on (see FENCED, blocker 1b, for what a non-empty
            // re-judge can reach and why that is correct).
            const cleared = await applyCodes(targetKey, [], () => recompute(targetKey, cache, deadlineExceeded));
            // Only a genuine `clear` is counted — a `noop` (something else
            // cleared it first) is not this call's doing (see IDEMPOTENT).
            if (cleared) result.cleared.push(targetKey);
        } catch (error) {
            result.errors++;
            console.warn("[receipt-intake/evidence-close] clear failed", targetKey, errorCategory(error));
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
