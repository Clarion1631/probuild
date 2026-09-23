/**
 * Candidate selection for the evidence-driven close (spec Amendment 2, §A2.3).
 *
 * PURE, NO I/O. Everything here only PROPOSES bank lines to re-judge;
 * `recomputeCodesFor` is the only thing that decides anything. Nothing in this
 * module compares an amount, a date or a payee to reach an outcome — the one
 * arithmetic it does is inverting the sweep's own evidence window so a booking
 * can ask "which charges could I possibly answer?", which is the same question
 * the sweep asks from the other end.
 *
 * Why this exists: every native booking bumps `receiptEvidenceEpoch`, which the
 * nightly sweep reads as a stale cycle and restarts its open-issue pass from
 * the first issue. On a day with a booking every few minutes it never reaches
 * issue 81 of 109, so a charge whose receipt is already booked keeps being
 * chased for hours. Judging the affected charges the moment the evidence lands
 * removes the starvation instead of racing it.
 */
import { RECEIPT_REVIEW_WINDOW_DAYS } from "@/lib/receipt-requests";

/** What a just-booked receipt knows about itself. All days are company-local. */
export interface BookedEvidence {
    /** The booked amount in cents, POSITIVE. Spend lines carry the negative. */
    totalCents: number;
    /** The document's own date, `YYYY-MM-DD`. Null when it was never readable. */
    txnDate: string | null;
    /** The day the booking committed — the anchor when `txnDate` is null. */
    bookedOn: string;
}

/** The bank lines one booking may propose for re-judgement. */
export interface CandidateBankLineQuery {
    /** Always negative: a purchase leaves the account. */
    amountCents: number;
    /** Inclusive lower bound on `BankLine.postedDate`, `YYYY-MM-DD`. */
    fromYmd: string;
    /** Inclusive upper bound on `BankLine.postedDate`, `YYYY-MM-DD`. */
    toYmd: string;
}

/**
 * The most candidates one booking may examine — i.e. recompute — in one call.
 *
 * A cap is not optional here for the same reason `recomputeCodesFor` caps its
 * component walk: a run of identical charges (a fuel card at the same pump, a
 * subscription) is real data, and one booking must not be able to spend a whole
 * worker invocation on it. Whatever this misses the nightly sweep still owns.
 *
 * Applied AFTER the open-issue filter, never before (Codex round 2, blocker
 * 2d): most of a window like that is usually already resolved, and capping
 * the RAW candidate list first let the first ten already-answered lines
 * permanently shadow a genuine open one sitting right behind them — this call
 * runs once per booking, so there is no next page to reach it on. See
 * `MAX_EVIDENCE_CLOSE_QUERY_ROWS` for the wider, earlier bound this relies on.
 *
 * Lowered from 25 to 10 (round 2): the courtesy close is now one of several
 * things competing for a booking's own capped budget (see worker.ts's
 * `CLOSE_REQUESTS_MAX_BUDGET_MS`), and ten component walks is already most of
 * that.
 */
export const MAX_EVIDENCE_CLOSE_CANDIDATES = 10;

/**
 * How many raw rows the candidate query itself may return, BEFORE the
 * open-issue filter runs. Wider than `MAX_EVIDENCE_CLOSE_CANDIDATES` on
 * purpose, so that filter has real lines to choose from instead of
 * truncating the exact same way the bug described on that constant did, one
 * step earlier. Still bounded: the query is already narrowed to one exact
 * amount over the evidence window, and this stops a genuinely pathological
 * run of same-amount postings from turning a cheap, indexed SELECT into an
 * unbounded one.
 */
export const MAX_EVIDENCE_CLOSE_QUERY_ROWS = MAX_EVIDENCE_CLOSE_CANDIDATES * 5;

const DAY_MS = 86_400_000;

function shiftDay(ymd: string, days: number): string | null {
    const at = Date.parse(`${ymd}T00:00:00Z`);
    if (!Number.isFinite(at)) return null;
    return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The candidate selectors for a booking, or null when the evidence cannot
 * select anything at all.
 *
 * DELIBERATELY WIDER THAN `satisfies()`, and the width is the INVERSE of the
 * sweep's own window rather than a number invented here. `recomputeCodesFor`
 * judges a line posted on day D against evidence in
 * `[D - lookbackDays, D + RECEIPT_REVIEW_WINDOW_DAYS]`, so evidence on day E is
 * capable of answering exactly the lines posted in
 * `[E - RECEIPT_REVIEW_WINDOW_DAYS, E + lookbackDays]`. Anything narrower (the
 * ±2-day match slop, say) would silently drop charges the judge would have
 * closed; anything the judge then refuses stays open, which costs one query and
 * nothing else.
 *
 * `lookbackDays` is passed in rather than recomputed, so the sweep's
 * `EVIDENCE_LOOKBACK_DAYS` stays the single source of truth for the width and a
 * policy change there cannot leave a second copy behind.
 *
 * THE AMOUNT IS NEGATED EXACTLY ONCE, here. `Expense.amount` is a positive
 * spend and `BankLine.amountCents` is negative for the same purchase; doing it
 * anywhere else as well is how a sign flip becomes two.
 */
export function candidateBankLineQuery(
    evidence: BookedEvidence,
    lookbackDays: number,
): CandidateBankLineQuery | null {
    if (!Number.isSafeInteger(evidence.totalCents) || evidence.totalCents <= 0) return null;
    if (!Number.isFinite(lookbackDays) || lookbackDays < 0) return null;
    // The document's own date when it has one; the booking day is the fallback,
    // exactly as `dedupKeys` falls back to the row's arrival day.
    const anchor = evidence.txnDate ?? evidence.bookedOn;
    const fromYmd = shiftDay(anchor, -RECEIPT_REVIEW_WINDOW_DAYS);
    const toYmd = shiftDay(anchor, Math.floor(lookbackDays));
    if (!fromYmd || !toYmd) return null;
    return { amountCents: -evidence.totalCents, fromYmd, toYmd };
}
