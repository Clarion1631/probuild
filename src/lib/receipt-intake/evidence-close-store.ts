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
 * 2. SUBTRACTIVE, STRICTLY (round 4). Every apply is always
 *    `evaluateReviewIssue(..., [], ...)` — an empty reason set that can only
 *    ever reach `clear` or `noop` (`decideLifecycle` step 1); it cannot
 *    create an issue, cannot reopen one, and touches no cycle record, no
 *    cursor and no `chaserCompletedAt`. There is no exception to this any
 *    more; an earlier version of this module had one, and removing it is
 *    what fixed round-3 blockers 1 and 2. A lost lifecycle CAS on this
 *    module's own write is never retried at all any more, not even once
 *    internally — see the ROW-LEVEL CAS paragraph under FENCED.
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
 * 5. FENCED, PER APPLY, AND LATCHED (round 4). `receiptEvidenceEpoch` and
 *    `bankLedgerEpoch` — the same two counters the sweep's own completion
 *    fence reads (receipt-evidence-lock.ts / bank-ledger-epoch.ts) — are read
 *    once before judging and again immediately before EACH lifecycle apply,
 *    not once for the whole batch: an epoch that moves between two applies
 *    withholds the second one (and everything still queued behind it),
 *    counted `stale`, without disturbing the first, which already committed
 *    under evidence that was still current when it ran. `deadlineExceeded()`
 *    is checked AGAIN right after that same re-read, with no `await` between
 *    the check and starting the apply, so a cancellation or deadline that
 *    lands during the epoch re-read's own round trip cannot slip a new apply
 *    out past it. Once the worker's timer wins its race against this whole
 *    call (see `closeRequestsSatisfiedByBooking` in worker.ts), that SAME
 *    predicate answers `true` for the rest of this call too, from that
 *    instant on — not only once the elapsed-time arithmetic would separately
 *    agree.
 *
 *    THE RESIDUAL ABOVE IS CLOSED (cheap-sweep-restart-spec.md §14.10, the
 *    #525 follow-up). The read and the write used to be two separate round
 *    trips — a fence read, then a write that could still land after the
 *    epoch it checked against had moved. They are now ONE transaction:
 *    `clearOneAtomically` takes the evidence lock, re-reads both epochs
 *    UNDER it, and only then judges and (on a genuine `clear`) bumps the
 *    evidence epoch — all inside the same commit. An apply that starts stale
 *    sees that the instant it takes the lock, and returns `stale` having
 *    written nothing; nothing can pass a freshness check and then land late
 *    the way it could before.
 *
 *    THE LOCK ORDER (§14.0), so this cannot deadlock against any other
 *    writer that takes these same locks: the evidence advisory lock, then
 *    the ledger epoch's row lock, then exactly ONE ReviewIssue row (through
 *    `evaluateReviewIssue`'s own write) and its episodes, then the evidence
 *    epoch's own bump — E → L → one I → its P → EV. Every holder of the
 *    evidence lock takes it FIRST, so any two holders — including two
 *    concurrent calls into this module — are fully serialized before either
 *    ever reaches an issue row. The one writer that can still interleave
 *    with this one, because it never takes the evidence lock at all, is card
 *    history (`receipt-card-history.ts:76-113`), which locks several issue
 *    rows in card-item order. Holding exactly ONE issue row here, never two,
 *    is what keeps that safe: this transaction can wait ON card history, but
 *    it never holds something card history is waiting FOR while it is ALSO
 *    waiting on card history itself, so no cycle is possible. `SET LOCAL
 *    lock_timeout` still bounds an ordinary wait, and Postgres deadlock
 *    detection remains the backstop. `SET LOCAL
 *    idle_in_transaction_session_timeout` covers the one case a
 *    `lock_timeout` cannot: #525's own close can outlive the race timer that
 *    started it, so a client that has gone quiet still releases every lock
 *    it holds rather than blocking every other writer until its connection
 *    eventually times out on its own. Every abort remains a safe drop (see
 *    BOUNDED): nothing here has written anything by the time any of these
 *    can fire.
 *
 *    THE ROW-LEVEL CAS is a separate, narrower concern from the epoch fence
 *    above: it catches a concurrent write to THIS ONE issue row, between
 *    `evaluateReviewIssue`'s own read and write, not a stale evidence
 *    snapshot. Left to itself, `evaluateReviewIssue` retries a lost CAS
 *    internally — re-reading and re-deciding — for up to five attempts in
 *    total (review-alert-lifecycle.ts, unmodified by this module); with no
 *    `recomputeCodes` handed to it (round 4, blocker 1), any such retry could
 *    only ever reapply the SAME already-decided `[]`. THE FIRST lost CAS on
 *    this module's one write is never given that chance at all:
 *    `courtesyClient` (below) wraps the client `evaluateReviewIssue` is
 *    handed so that the underlying `updateMany` reporting `{count: 0}`
 *    throws a `CourtesyCasConflict` immediately, from inside the wrapped
 *    call itself, before `evaluateReviewIssue`'s own retry loop ever sees it.
 *    `CourtesyCasConflict` is deliberately NOT an `instanceof` the
 *    lifecycle's own module-private `VersionConflict`, so the loop's `catch
 *    (error) { if (error instanceof VersionConflict) continue; throw error;
 *    }` cannot recognise it as one — it propagates straight out, uncaught, on
 *    the very first attempt, whether or not a second attempt would
 *    eventually have won the race. This module recognises that specific
 *    error and counts it as a `conflict`, never as `errors` and never as
 *    `cleared` (`EvidenceCloseResult.conflicts`), and does nothing further
 *    for that issue — exactly like a stale epoch, it is left for the nightly
 *    sweep, which carries no such reluctance to retry. An earlier version of
 *    this module instead let the lifecycle retry and tried to re-judge on
 *    it, using the SAME cache-backed `recomputeCodesFor` the judge phase had
 *    already populated — which handed back the cache's STALE verdict, not a
 *    fresh one, so the "re-judge" was fake (blocker 1) and could also have
 *    overwritten a richer `displayDetails` with `null` on whatever
 *    non-empty action it reached instead (blocker 2). Neither can happen
 *    once no retry ever runs at all.
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
 *    immediately after every epoch re-read, and immediately before every
 *    apply — and no new apply is ever started once it fires, whether it
 *    fired by elapsed time or by the worker's cancel latch (see FENCED).
 *    Every failure, including one in the candidate query, the open-issue
 *    lookup, or an epoch read, is counted and swallowed; a lost lifecycle
 *    CAS on this module's one write is terminal on the first attempt and
 *    counted separately as a `conflict` rather than an `error`, because
 *    contention is not a bug. The money has already moved; a failed courtesy
 *    close must not disturb it, and the nightly sweep is still the backstop.
 *
 * Injection over mocking throughout: the `deps` bag is the same seam
 * `receipt-request-cards/route.ts:390,415` uses, and it is what lets every test
 * run with no database and without `mock.module`, which CI's Node 20 cannot do.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import {
    decimalStringToCents,
    isComponentDeadlineExceeded,
    RECEIPT_REQUEST_TARGET_TYPE,
} from "@/lib/receipt-requests";
import { evaluateReviewIssue, type ReviewIssueLifecycleClient } from "@/lib/review-alert-lifecycle";
import type { ReasonCode } from "@/lib/review-alert-reasons";
// THE FRESHNESS FENCE'S readers (see FENCED in the module header) — the SAME
// functions the sweep's own completion fence and receipt-on-demand-store.ts
// already read these settings through. Never a second key.
//
// `clearOneAtomically` (§14.10, the #525 follow-up) also takes the evidence
// lock and bumps its epoch now: the read-only judge phase above still only
// ever OBSERVES the counters, but the atomic apply phase below is itself one
// of this module's writers, inside its own transaction, under the §14.0
// lock order (see the module header).
import { lockReceiptEvidence, readReceiptEvidenceEpoch, bumpReceiptEvidenceEpoch } from "@/lib/receipt-evidence-lock";
import { lockBankLedgerEpoch, readBankLedgerEpoch } from "@/lib/bank-ledger-epoch";
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

/**
 * What `clearOneAtomically` (§14.10) hands its transaction: the raw SQL
 * escape hatches the lock and epoch reads need, plus the two models
 * `evaluateReviewIssue` writes through `flatten`. Narrow on purpose — the
 * same discipline `EvidenceWriteClient` in receipt-evidence-lock.ts follows.
 */
export type CourtesyTx = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw" | "reviewIssue" | "reviewAlertEpisode">;

/** One candidate's atomic clear attempt — see `clearOneAtomically`. */
export type ClearOneOutcome =
    | { kind: "cleared"; evidenceAfter: string }
    | { kind: "noop" }
    | { kind: "conflict" }
    | { kind: "stale" }
    | { kind: "error" };

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
     * The transaction `clearOneAtomically` (§14.10) runs its lock, its
     * freshness re-read and its one write inside. Injected so tests can
     * exercise the real production `clearOneAtomically` — including
     * `courtesyClient`'s CAS-conflict wrapper — against an in-memory fake
     * transaction, rather than reimplementing the apply step themselves.
     * Defaults to `prisma.$transaction` at the production timeout.
     */
    transaction?: <T>(fn: (tx: CourtesyTx) => Promise<T>) => Promise<T>;
    /**
     * One candidate's atomic clear attempt. Defaults to `clearOneAtomically`
     * bound to `transaction` above. Overridable directly so a caller can hand
     * back canned outcomes without any transaction machinery at all.
     */
    clearOne?: (targetKey: string, expected: EpochSnapshot) => Promise<ClearOneOutcome>;
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
    /** Candidates whose verdict or write threw — a real failure, not contention.
     *  Never a verdict. */
    errors: number;
    /**
     * Applies withheld because the lifecycle lost the CAS on this issue row,
     * on this module's one and only write attempt — never retried (see
     * FENCED). Contention, not a bug — distinct from `errors` so a log line
     * never conflates the two. Zero lifecycle writes happened for these; left
     * to the nightly sweep, exactly like `stale`.
     */
    conflicts: number;
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
 * A bounded classification for a caught error — mapped from a small fixed
 * set of known error classes, never the error's own name or message (Codex
 * round 4, #3). An earlier version of this function returned `error.name`
 * verbatim, on the claim that "a name is one of a small, fixed set" — it is
 * not: `name` is a plain mutable string property, and nothing stops a
 * dependency from setting it to text that echoes a vendor or account
 * reference. Every warn line in this module that classifies a caught error
 * through this function logs only that category (plus, at most, the
 * candidate's own id), the same way `judged` stays ids-only.
 */
function errorCategory(error: unknown): "timeout" | "db" | "other" {
    if (isComponentDeadlineExceeded(error)) return "timeout";
    if (
        error instanceof Prisma.PrismaClientKnownRequestError ||
        error instanceof Prisma.PrismaClientUnknownRequestError ||
        error instanceof Prisma.PrismaClientRustPanicError ||
        error instanceof Prisma.PrismaClientInitializationError ||
        error instanceof Prisma.PrismaClientValidationError
    ) return "db";
    return "other";
}

/**
 * Thrown from inside `courtesyClient`'s wrapped `updateMany`, the instant the
 * underlying write reports a lost CAS (`{count: 0}`) — see the module
 * header's ROW-LEVEL CAS paragraph for why this exists as its own class
 * rather than reusing anything from review-alert-lifecycle.ts: it must NOT be
 * an `instanceof` that module's module-private `VersionConflict`, so
 * `evaluateReviewIssue`'s own retry loop cannot recognise and swallow it.
 * Bucketed into `EvidenceCloseResult.conflicts`, apart from `errors`, so the
 * two are never confused in a log line.
 */
class CourtesyCasConflict extends Error {}

/**
 * Wraps a lifecycle client so THIS module's one write can never be retried by
 * `evaluateReviewIssue` itself — see `CourtesyCasConflict` and the module
 * header's ROW-LEVEL CAS paragraph. Every call other than the write
 * (`reviewIssue.updateMany`) passes straight through to the real client
 * unchanged; `$transaction` re-wraps whatever transactional client the real
 * `$transaction` hands back, so the same interception reaches the write
 * wherever it actually runs.
 */
function courtesyClient(client: ReviewIssueLifecycleClient): ReviewIssueLifecycleClient {
    return {
        reviewIssue: {
            findUnique: args => client.reviewIssue.findUnique(args),
            create: args => client.reviewIssue.create(args),
            updateMany: async args => {
                const result = await client.reviewIssue.updateMany(args);
                if (result.count === 0) throw new CourtesyCasConflict();
                return result;
            },
        },
        reviewAlertEpisode: {
            create: args => client.reviewAlertEpisode.create(args),
            updateMany: args => client.reviewAlertEpisode.updateMany(args),
        },
        $transaction: fn => client.$transaction(tx => fn(courtesyClient(tx))),
    };
}

/**
 * THE SWEEP'S OWN FLATTENING SHIM (route.ts's component transaction,
 * `:1785-1796`), copied here for the same reason: `evaluateReviewIssue` asks
 * its client for a transaction, and handing it `tx` itself would try to nest
 * one, which Prisma's interactive client cannot do. This makes the
 * lifecycle's own `$transaction` call return the SAME `tx`, so any writes it
 * makes through that path join the one transaction `clearOneAtomically`
 * already opened, rather than opening a nested one Prisma cannot give it.
 */
function flatten(tx: CourtesyTx): ReviewIssueLifecycleClient {
    const flattened: {
        reviewIssue: CourtesyTx["reviewIssue"];
        reviewAlertEpisode: CourtesyTx["reviewAlertEpisode"];
        $transaction: <T>(fn: (inner: unknown) => Promise<T>) => Promise<T>;
    } = {
        reviewIssue: tx.reviewIssue,
        reviewAlertEpisode: tx.reviewAlertEpisode,
        $transaction: async fn => fn(flattened),
    };
    return flattened as unknown as ReviewIssueLifecycleClient;
}

/** Production's `transaction` for `clearOneAtomically`: see `EvidenceCloseDeps.transaction`. */
async function defaultTransaction<T>(fn: (tx: CourtesyTx) => Promise<T>): Promise<T> {
    return prisma.$transaction(fn, { timeout: 6_000, maxWait: 1_000 });
}

/**
 * ONE COURTESY CLEAR, FULLY ATOMIC (cheap-sweep-restart-spec.md §14.10, the
 * #525 follow-up). See "THE RESIDUAL ABOVE IS CLOSED" and "THE LOCK ORDER"
 * in the module header for the race this closes and why it cannot deadlock.
 *
 * It refuses to be anything but a clear — on its one and only lifecycle-write
 * attempt (see `courtesyClient` and the module header's ROW-LEVEL CAS
 * paragraph for why there is never a second one). See SUBTRACTIVE and FENCED
 * in the module header for why no recompute callback is handed to
 * `evaluateReviewIssue` (round 4) — unchanged by this transaction becoming
 * atomic.
 *
 * `displayDetails` is null on purpose: the lifecycle's `clear` branch writes
 * `clearedAt`, the acknowledgement columns and the version, and never touches
 * the details blob — exactly as the sweep's own close does
 * (`applyReceiptRequestPlan`'s `evaluate(targetKey, [], null)`), so a
 * courtesy clear leaves the row identical to a sweep clear either way.
 *
 * NEVER THROWS. A stale read returns `stale` having written nothing; a lost
 * lifecycle CAS is caught as `CourtesyCasConflict` (the transaction has
 * already rolled back) and returns `conflict`; anything else is caught,
 * categorised and returned as `error` — never `errors` counted from a
 * genuine `clear`, and never a `clear` counted from a `noop` (something else
 * already cleared this issue since the open-issue read — see IDEMPOTENT in
 * the module header).
 */
async function clearOneAtomically(
    targetKey: string,
    expected: EpochSnapshot,
    transaction: <T>(fn: (tx: CourtesyTx) => Promise<T>) => Promise<T>,
): Promise<ClearOneOutcome> {
    try {
        return await transaction(async tx => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '4s'`;
            await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '10s'`;
            await lockReceiptEvidence(tx);
            const evidence = await readReceiptEvidenceEpoch(tx);
            const ledger = await lockBankLedgerEpoch(tx);
            if (evidence !== expected.evidence || ledger !== expected.ledger) return { kind: "stale" };
            const { decision } = await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, [], null, {
                client: courtesyClient(flatten(tx)),
                // Delivery is the per-owner digest, never the per-issue drainer — the
                // same choice the sweep makes for every receipt-request write.
                episodeStatus: "SUPPRESSED",
            });
            if (decision.action !== "clear") return { kind: "noop" };
            await bumpReceiptEvidenceEpoch(tx);
            return { kind: "cleared", evidenceAfter: await readReceiptEvidenceEpoch(tx) };
        });
    } catch (error) {
        if (error instanceof CourtesyCasConflict) return { kind: "conflict" };
        console.warn("[receipt-intake/evidence-close] clear failed", targetKey, errorCategory(error));
        return { kind: "error" };
    }
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
    const result: EvidenceCloseResult = { examined: 0, cleared: [], errors: 0, conflicts: 0, stale: 0, judged: [] };
    const deadlineExceeded = deps.deadlineExceeded ?? (() => false);
    const query = candidateBankLineQuery(evidence, deps.lookbackDays ?? EVIDENCE_LOOKBACK_DAYS);
    if (!query || deadlineExceeded()) return result;

    const findLines = deps.findLines ?? defaultFindLines;
    const openIssueKeys = deps.openIssueKeys ?? defaultOpenIssueKeys;
    const readEpochs = deps.readEpochs ?? defaultReadEpochs;
    const recompute = deps.recompute ?? recomputeCodesFor;
    const transaction = deps.transaction ?? defaultTransaction;
    const clearOne = deps.clearOne ??
        ((targetKey: string, expected: EpochSnapshot) => clearOneAtomically(targetKey, expected, transaction));

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

    // APPLY, one candidate at a time, each through its OWN ATOMIC transaction
    // now (§14.10, the #525 follow-up — see "THE RESIDUAL ABOVE IS CLOSED" in
    // the module header). Sorted so concurrent calls that share a target
    // reach for issue rows in the same order. `expected` starts at
    // `epochBefore`, the single reference point judging actually saw, and
    // then tracks forward only the EVIDENCE half across a run of clears in
    // the same call — each cleared target's own bump is the next target's own
    // baseline, exactly like the epoch this module's own write just moved.
    // The LEDGER half never moves under this module's write, so it stays
    // pinned to `epochBefore` throughout.
    const targets = [...toClear].sort();
    let expected: EpochSnapshot = epochBefore;
    for (let i = 0; i < targets.length; i++) {
        if (deadlineExceeded()) {
            console.warn("[receipt-intake/evidence-close] out of budget before an apply; leaving the rest to the sweep");
            break;
        }

        const target = targets[i];
        const outcome = await clearOne(target, expected);
        if (outcome.kind === "cleared") {
            // Only a genuine `clear` is counted — a `noop` (something else
            // cleared it first) is not this call's doing (see IDEMPOTENT).
            result.cleared.push(target);
            expected = { evidence: outcome.evidenceAfter, ledger: expected.ledger };
        } else if (outcome.kind === "noop") {
            // Nothing to count and nothing to log — see IDEMPOTENT.
        } else if (outcome.kind === "conflict") {
            // A version conflict on the write itself — someone else committed
            // to THIS row between the transaction's own read and its write —
            // is terminal on the first attempt (round 4, blocker 1):
            // `courtesyClient` stops `evaluateReviewIssue`'s own retry loop
            // from ever running a second one (see the module header's
            // ROW-LEVEL CAS paragraph). Contention, not a bug: the next
            // candidate is still tried.
            result.conflicts++;
            console.warn("[receipt-intake/evidence-close] lost the lifecycle CAS; leaving it to the sweep", target);
        } else if (outcome.kind === "stale") {
            // THIS candidate and everything still queued behind it — none of
            // it was judged against evidence that is still current.
            result.stale += targets.length - i;
            console.warn("[receipt-intake/evidence-close] evidence or ledger moved before an apply; leaving the rest to the next certified sweep");
            break;
        } else {
            // clearOneAtomically already logged the category — see its own
            // header. A real failure, not contention, so this stops the
            // batch exactly like the deadline and stale checks above do.
            result.errors++;
            break;
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
