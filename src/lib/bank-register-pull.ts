/**
 * Nightly QBO bank register → BankLineObservation pull.
 *
 * THE MISSING PIPE, now server-side. `scripts/post-qbo-register.mjs` proved
 * the shape on 2026-08-19 (prod held 51 STATEMENT observations and 0 QBO
 * ones, so reconcile had nothing to match and receipt-matching was starved of
 * its only input) — but it only ran when a human ran it from a laptop. This
 * module is that script's body, moved into the app so a cron can run it, and
 * the script is now a thin wrapper around it.
 *
 * WHAT THIS IS NOT: it does not create, edit, or void anything in QuickBooks.
 * QBO stays read-only (money-map rule 2). Observations are CORROBORATING
 * EVIDENCE, and linking an observation to a canonical line is the separate,
 * explicit reconcile step, never an ingest-time side effect.
 *
 * WHICH SOURCES MINT (Codex PR #443 gate round 38, finding 3 — this paragraph
 * predates the nightly mint and said statements were the only minter).
 * Canonical `BankLine` rows are minted from STATEMENT observations and, when
 * `BANK_LINE_MINT_FROM_QBO` is on, from QuickBooks GENERAL LEDGER postings that
 * QuickBooks says have cleared the bank. The statement is still the preferred
 * source and adopts a QBO-minted line when it arrives. It is also the ONLY
 * source for a charge the bank has cleared that QuickBooks has not posted —
 * pending, excluded or unmatched in "For Review" — because no QBO API returns
 * those rows at all. The pull narrows the statement-import gap to exactly that
 * set; it does not close it.
 *
 * The fetch goes through `fetchBankRegister`, which calls `qbFetch` — so this
 * inherits the shared QBO timeout/`QBTimeoutError` contract rather than
 * hand-rolling a fetch with its own (or no) deadline.
 *
 * IDEMPOTENCY. Observation identity is (source, account,
 * sourceDocumentId="QBO_REGISTER", sourceLineId=qbTxnId). Re-running over an
 * overlapping window inserts nothing. A qbTxnId that comes back with DIFFERENT
 * content (QBO edited an amount/date after we recorded it) is a 409 from the
 * ingest path — a real restatement a human must look at, never silently
 * overwritten.
 *
 * THE INTRA-WINDOW CURSOR (`continueAfter`) IS ONE-DIRECTIONAL, and the run
 * that finishes draining it has to account for that. It exists so a
 * budget-truncated run resumes past what it already posted instead of
 * replaying it — but a row QuickBooks backdates in LATER, behind that cursor,
 * was never in the fetch that set it, so blindly trusting the cursor forever
 * would drop it silently. `splitAtCursor` and the prefix-rescan block in
 * `runBankRegisterPull` close that: the run that finally drains `pending`
 * re-posts the PREFIX too, through this same idempotent ingest, before the
 * window may be marked complete.
 */

import { reconcileScanSince, type ReconcileAmbiguousGroup, type ReconcilePairedGroup } from "@/lib/bank-ledger";
import type { ClearedStatus } from "@/lib/register-types";

export interface BankRegisterRowLike {
    date: string;
    qbType: string;
    qbTxnId: string | null;
    docNum: string | null;
    name: string | null;
    amountCents: number;
    /**
     * The GL's memo/description cell. When QuickBooks posts a row it matched
     * from the bank, it usually leaves the ORIGINAL POS descriptor here —
     * "LOWES #02516 POS DEB C#8516" — which is the only place a posted QBO row
     * carries the card tail. Without it every QBO-minted line
     * resolved to `office` and the crew was never asked (Codex round-4 item 7).
     */
    memo?: string | null;
    /**
     * What QuickBooks says about this row's bank clearance. Optional so a
     * caller that cannot ask (a fixture, the standalone script) simply does not
     * claim to know; absent reads as "Unknown", which never mints.
     */
    clearedStatus?: ClearedStatus | null;
}

export interface BankRegisterIngestLine {
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
    qbTxnId: string;
    /**
     * Carried to the ingest so the observation can record it. It is MUTABLE
     * state, not identity: an uncleared row clears later, and that must be an
     * update rather than a restatement conflict — so it is deliberately absent
     * from `lineContent` below and from the ingest's content hash.
     */
    clearedStatus: ClearedStatus;
}

/** The one bank account this register describes. */
export const BANK_REGISTER_ACCOUNT = "WTB-0723";

/** The ingest route's own per-request line cap (MAX_LINES_PER_REQUEST there). */
export const BANK_REGISTER_CHUNK_SIZE = 500;

/** fetchBankRegister enforces this; the cron's 7-day window is far inside it. */
export const BANK_REGISTER_MAX_RANGE_DAYS = 92;

/** How far back the nightly pull looks. Overlapping windows are free (see idempotency above). */
export const BANK_REGISTER_PULL_DAYS = 7;

/**
 * A GL row → an ingest line. PURE.
 *
 * The descriptor is what reconcile normalizes into a payee, so it must carry
 * the counterparty NAME; the type is appended to keep otherwise-identical rows
 * distinguishable. Whitespace is collapsed for hash stability, exactly as the
 * daily CSV parser does (that bug cost a 409-stall once already).
 *
 * DOC NUMBER — DO NOT put it in the descriptor. Verified against live QBO
 * 2026-08-19: on this realm `doc_num` holds a GOOGLE DRIVE FILE ID
 * ("1sEISJBJaGRYpivooQJBR") stamped by the receipt-automation pipeline, not a
 * human document number — the real transaction id is a short integer ("6625")
 * carried on the txn_type cell. Splicing doc_num into rawDescriptor would put
 * an opaque per-file identifier into the payee text, so a receipt re-filed
 * under a new Drive id would look like a different payee and never reconcile.
 * It is used ONLY as a check number, and only when it looks like one.
 */
export function registerRowToIngestLine(row: BankRegisterRowLike): BankRegisterIngestLine | null {
    if (!row.qbTxnId) return null; // balance/summary rows carry no txn identity
    // THE POSTED ROW'S ORIGINAL DESCRIPTOR, or QuickBooks' name when there is none. NOT a
    // concatenation, and never the transaction type: no statement carries
    // " Expense" on the end, so appending it gave the same transaction two
    // identities and nothing ever reconciled. (Rows really are distinguishable
    // without it — `qbTxnId` is the observation's identity, not the text.)
    // The memo is also where `C#8516` lives, which is the only owner signal a
    // QBO row has.
    const rawDescriptor = ((row.memo ?? "").trim() || (row.name ?? "").trim()).replace(/\s+/g, " ").trim();
    if (rawDescriptor === "") return null; // nothing to normalize a payee from
    // Check number: only on check-type rows, only when doc_num is actually
    // numeric (a Drive file id is not), leading zeros stripped so "01027" and
    // "1027" are ONE identity — matching the daily CSV and monthly PDF parsers.
    const isCheckish = /check/i.test(row.qbType || "");
    const docNum = (row.docNum || "").trim();
    const checkNumber = isCheckish && /^\d+$/.test(docNum) ? String(Number(docNum)) : null;
    return {
        postedDate: row.date,
        amountCents: row.amountCents,
        rawDescriptor,
        checkNumber,
        qbTxnId: row.qbTxnId,
        clearedStatus: row.clearedStatus ?? "Unknown",
    };
}

export interface ConvertedRegisterRows {
    lines: BankRegisterIngestLine[];
    /** Rows with no transaction identity (balance/summary lines). */
    skipped: number;
    /** Repeat qbTxnIds with IDENTICAL content, collapsed to one observation. */
    collapsed: number;
    /**
     * Repeat qbTxnIds with DIFFERENT content. Two rows claiming the same
     * durable identity with different dates/amounts/descriptors cannot both be
     * right, and neither is posted.
     */
    conflicts: string[];
}

/**
 * The content that makes two rows under one qbTxnId the same observation.
 *
 * `clearedStatus` is NOT part of it. It is a fact about the row's lifecycle,
 * not about which transaction the row is, and hashing it would turn the
 * ordinary uncleared-then-cleared transition into a duplicate conflict.
 */
function lineContent(line: BankRegisterIngestLine): string {
    return JSON.stringify([line.postedDate, line.amountCents, line.rawDescriptor, line.checkNumber]);
}

/**
 * Convert a whole register fetch into ingest lines. PURE.
 *
 * A qbTxnId must appear at most once per request — the ingest route's own
 * duplicate check 409s the whole batch otherwise. QBO can emit the same txn
 * twice in a GL when it has multiple account-affecting splits.
 *
 * CONTENT-COMPARED, not first-wins. Identical repeats really are the same
 * observation and collapse to one. DIVERGENT repeats are a different animal:
 * picking the first is a guess, and it is the guess that hides a QuickBooks
 * restatement — exactly the thing the ingest route's 409 contract exists to
 * surface. Those ids are dropped from the payload (they cannot be represented
 * as one observation) and reported in `conflicts`, which the cron turns into a
 * 500 so the platform flags it for a human.
 */
export function convertRegisterRows(rows: readonly BankRegisterRowLike[]): ConvertedRegisterRows {
    const byTxnId = new Map<string, { line: BankRegisterIngestLine; content: string }>();
    const conflicts = new Set<string>();
    let skipped = 0;
    let collapsed = 0;
    for (const row of rows) {
        const line = registerRowToIngestLine(row);
        if (!line) { skipped++; continue; }
        const content = lineContent(line);
        const prior = byTxnId.get(line.qbTxnId);
        if (!prior) { byTxnId.set(line.qbTxnId, { line, content }); continue; }
        if (prior.content === content) { collapsed++; continue; }
        conflicts.add(line.qbTxnId);
    }
    // A conflicting id is posted by nobody: not the first sighting, not the
    // second. Half of a contradiction is still a guess.
    for (const qbTxnId of conflicts) byTxnId.delete(qbTxnId);
    return {
        lines: [...byTxnId.values()].map(entry => entry.line),
        skipped,
        collapsed,
        conflicts: [...conflicts].sort(),
    };
}

export function chunkLines<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/** UTC-only date math — no local timezone can shift a posting date. */
export function ymdDaysAgo(days: number, nowMs: number = Date.now()): string {
    return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

/** Strict YYYY-MM-DD with a true calendar round-trip ("2026-02-30" must fail). */
export function isYmd(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const t = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}


/**
 * THE register window: 60 calendar days, inclusive of today and of the oldest
 * day. ONE definition, used by the deep sweep, the missing-receipt chaser and
 * QBO minting.
 *
 * They used to carry three numbers (60 / 60 / 45) and two different notions of
 * "60 days ago". Minting reaching back less far than the chaser is the one that
 * bites: the chaser opens a chase for a 50-day-old charge, the mint pass cannot
 * see the observation that would have given it a canonical line, and the chase
 * can never close by itself. A boundary that three subsystems have to agree on
 * belongs in one place.
 */
export const REGISTER_WINDOW_DAYS = 60;

/**
 * The OLDEST calendar day inside the window, YYYY-MM-DD (UTC).
 *
 * Day-based, not instant-based. `Date.now() - 60 * 86_400_000` is a time of
 * day, and `postedDate` is a `@db.Date` stored at UTC midnight — so a
 * mid-morning run silently excluded the whole of its own oldest day, and the
 * boundary moved every time the cron fired.
 */
export function registerWindowStartYmd(now: Date, days: number = REGISTER_WINDOW_DAYS): string {
    const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    return new Date(today - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** The same boundary as a Date at UTC midnight — what a `gte` on a DATE column wants. */
export function registerWindowStart(now: Date, days: number = REGISTER_WINDOW_DAYS): Date {
    return new Date(`${registerWindowStartYmd(now, days)}T00:00:00Z`);
}

/** Overlap re-pulled on every run, so an edit near the boundary is not missed. */
export const PULL_OVERLAP_DAYS = 3;
/** The most one run will ask QBO for. Bigger windows time out; this one continues. */
export const PULL_MAX_WINDOW_DAYS = 60;
/** The periodic deep sweep, to catch entries BACKDATED behind the high-water mark. */
export const PULL_FULL_SWEEP_DAYS = REGISTER_WINDOW_DAYS;

export interface PullWindowState {
    /** Latest TxnDate we have successfully pulled, YYYY-MM-DD, or null. */
    highWater: string | null;
    /** When the last full 60-day sweep ran, YYYY-MM-DD, or null. */
    lastFullSweep: string | null;
    /**
     * WHERE INSIDE THE WINDOW the last run stopped: the TxnDate and qbTxnId of
     * the last observation it actually posted.
     *
     * The high-water mark only moves for a COMPLETE run, which is right — but
     * it meant a run that ran out of budget half way recorded nothing at all,
     * so the next one re-fetched the same window, re-posted the same first
     * batches, and ran out of budget at the same place. A big backlog could
     * never drain. This is the resume point that makes progress monotonic.
     */
    continueAfter?: { postedDate: string; qbTxnId: string } | null;
    /**
     * Where a TRUNCATED mint stopped, when one did.
     *
     * Diagnostic rather than a resume point in the strict sense: minting
     * re-plans from the unlinked observations every batch, so a line already
     * minted is linked and no longer a candidate, and the next run continues by
     * construction. What this buys is the ability to SEE a backlog that is not
     * draining — a cursor that never moves across runs is a stuck mint, and
     * without it that looks exactly like a quiet week.
     */
    mintRemainingCursor?: string | null;
    /**
     * A window that INGESTED cleanly but could not be certified, and that a
     * continuation should re-run (Codex PR #443 gate round 34, finding 2).
     *
     * The case this exists for is the failed clearance probe. QuickBooks serves
     * the register and errors on the clearance report, so every row reads
     * "Unknown": the rows land, `ok` stays true, and `complete` goes false —
     * which correctly withholds the freshness stamp and holds minting back. But
     * nothing was PARKED. `continueAfter` is only written by a budget-truncated
     * ingest, and this run was not truncated, so it was CLEARED as a finished
     * window — and `pullContinuationPending` (the only thing the 15-minute
     * resume pass looks at) answered "nothing in progress" every time. The
     * 02:00 failure sat until 02:00 the next night while the 13:00 chaser found
     * an uncertified register and held every owner's cards.
     *
     * Carries the window's own BOUNDS because the high-water mark legitimately
     * advances over a fully-ingested window: re-planning from the mark would ask
     * QuickBooks about a NARROWER span than the one whose clearance is unknown.
     * `attempts` is what stops a dead report endpoint spinning through all 44
     * continuation slots — see PROBE_RETRY_LIMIT.
     */
    retryPending?: PullRetryPending | null;
    /**
     * THE DAYS WHOSE CLEARANCE NOBODY EVER ANSWERED, carried until a run
     * actually reads them again (Codex PR #443 gate round 35, finding 1).
     *
     * `retryPending` is the SHORT-TERM half of this: it schedules up to
     * PROBE_RETRY_LIMIT re-runs and is then dropped, on purpose, so a dead
     * report endpoint stops burning continuation slots. Dropping it used to end
     * the story — and that was the hole. The failed run had already advanced
     * the high-water mark (it ingested its whole window, so `windowFullyIngested`
     * was true), so the NEXT nightly run planned the ordinary 3-day overlap,
     * found a healthy probe, and stamped `bankRegisterPullLastSuccess` over a
     * stretch of observations that never got a clearance answer and were never
     * offered to the mint. The register read "current" while a week of it was
     * uncertified.
     *
     * So the bounds outlive the retry. Two rules hang off them and both are
     * load-bearing: the next run EXTENDS its window back to cover them (see
     * `extendWindowForUncertified`), and the freshness stamp is withheld while
     * they exist at all (see the route). They are cleared only by a run that
     * actually re-read them with a working probe.
     */
    uncertifiedBounds?: PullUncertifiedBounds | null;
    /** When the oldest still-outstanding uncertified window first failed (ISO). */
    uncertifiedSince?: string | null;
    /**
     * LINKS THE LAST RECONCILE COULD NOT GET TO (Codex PR #443 gate round 36,
     * finding 1).
     *
     * A reconcile that hits its own cap or this run's deadline reports
     * `remaining > 0`, and the run correctly refuses to call the picture
     * complete — but that refusal lived only in the response body. The saved
     * state said "finished": `continueAfter` is cleared by a window that was
     * fully ingested (which this one was), so `pullContinuationPending`
     * answered no and every 15-minute slot exited with
     * `nothing-in-progress`. A backlog of hundreds of links then drained one
     * NIGHT at a time while the freshness stamp — and with it the day's cards —
     * waited on it.
     *
     * A COUNT, not a cursor: the linker re-plans from the still-unlinked
     * observations every run, so a link it made is no longer a candidate and
     * the next run continues by construction. What was missing was the
     * knowledge that there IS a next run's worth of work.
     */
    reconcileRemaining?: number | null;
    /**
     * THIS RUN LEFT THE PICTURE PARTIAL, AND ANOTHER RUN CAN ADVANCE IT
     * (round-36 gate, finding 1).
     *
     * The specific markers each answer "where do I pick up": the resume point,
     * the mint cursor, the reconcile backlog, the retry window. None of them
     * answers the plainer question the continuation pass actually asks — "is
     * there more of today's register to read" — and the case that fell through
     * all of them is the window the PLANNER capped: it ingested everything it
     * asked for, so nothing was parked, the mark advanced correctly, and the
     * days behind it waited for the next NIGHT.
     *
     * So a run records whether it finished the picture. `complete` is exactly
     * that judgement, already made and already reported.
     *
     * GATED ON A WORKING CLEARANCE PROBE, deliberately. A dead QuickBooks report
     * endpoint also leaves `complete: false`, and it is the one incompleteness
     * that repeating cannot fix — `retryPending` gives it PROBE_RETRY_LIMIT
     * attempts and then stops on purpose, so that a dead endpoint cannot burn
     * all 44 continuation slots every day. Recording it here as ordinary
     * unfinished work would undo that.
     */
    continuationPending?: boolean;
    /**
     * THE FRESHNESS STAMP A RUN OWED AND COULD NOT WRITE (round-36 gate,
     * finding 4).
     *
     * The stamp is the last write of a fully successful run, and its failure
     * used to be logged and nothing else: the run answered 200 with
     * `ok: true`, so the platform surfaced nothing, while the clock the chaser
     * reads had not moved. Thirty-six hours later `bank-pull-stale` fired for a
     * pull that had been working perfectly the whole time.
     *
     * Set by the route when the stamp write itself fails, so a continuation
     * comes back for it; cleared by the first run that either stamps or finds
     * the stamp no longer warranted.
     */
    stampPending?: boolean;
}

/**
 * A contiguous span of dates whose clearance status is unknown.
 *
 * ONE span, not a set of them: a hole in the middle is deliberately not
 * representable, and `mergeUncertifiedBounds` unions rather than tracking
 * fragments. Re-reading a few days that were already certified costs one
 * idempotent fetch; forgetting a day that was not is a permanently wrong ledger.
 */
export interface PullUncertifiedBounds {
    startDate: string;
    endDate: string;
}

export interface PullRetryPending {
    startDate: string;
    endDate: string;
    /** Why the window needs re-running. Today only `cleared-probe-failed`. */
    reason: string;
    /** How many runs have now failed on this same window. */
    attempts: number;
}

/**
 * How many times one window may be re-run for a failed clearance probe before
 * the retry is abandoned.
 *
 * The continuation cron fires every 15 minutes from 02:00, so six attempts is
 * about ninety minutes of trying — long enough to ride out a QuickBooks report
 * outage, short enough that a permanently dead endpoint stops re-asking and
 * lets `bank-pull-stale` be the signal instead. Abandoning does NOT stamp the
 * freshness clock: the window is still uncertified, it is simply no longer
 * being retried.
 */
export const PROBE_RETRY_LIMIT = 6;

const DAY_MS = 86_400_000;

/** Shift a YYYY-MM-DD by whole days, staying in UTC. */
function shiftYmd(ymd: string, days: number): string {
    return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days spanned by [from, to] inclusive. */
function spanDays(from: string, to: string): number {
    return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * Widen the outstanding uncertified span to include a window that just failed
 * its probe.
 *
 * A UNION, so the result may swallow days in between that WERE certified. That
 * is the safe direction: those days get re-fetched through an idempotent ingest
 * and re-probed, which costs one query. The other direction — tracking
 * fragments and getting the bookkeeping wrong — loses a day nobody read.
 */
export function mergeUncertifiedBounds(
    existing: PullUncertifiedBounds | null | undefined,
    window: { startDate: string; endDate: string },
): PullUncertifiedBounds {
    if (!existing) return { startDate: window.startDate, endDate: window.endDate };
    return {
        startDate: existing.startDate < window.startDate ? existing.startDate : window.startDate,
        endDate: existing.endDate > window.endDate ? existing.endDate : window.endDate,
    };
}

/**
 * Remove the part of the uncertified span that a run has now re-read WITH a
 * working clearance probe.
 *
 * Only a prefix or a suffix can be subtracted, because the result has to stay
 * one contiguous span. A covered range strictly INSIDE the bounds would leave a
 * hole, and a shape that cannot hold a hole must not pretend it did — so that
 * case subtracts nothing. Conservative on purpose: over-reporting the
 * uncertified span delays a stamp, under-reporting it certifies days nobody
 * read, and only one of those is recoverable.
 */
export function subtractCertifiedWindow(
    bounds: PullUncertifiedBounds | null | undefined,
    covered: { startDate: string; endDate: string },
): PullUncertifiedBounds | null {
    if (!bounds) return null;
    if (covered.startDate <= bounds.startDate && covered.endDate >= bounds.endDate) return null;
    if (covered.startDate <= bounds.startDate && covered.endDate >= bounds.startDate) {
        return { startDate: shiftYmd(covered.endDate, 1), endDate: bounds.endDate };
    }
    if (covered.endDate >= bounds.endDate && covered.startDate <= bounds.endDate) {
        return { startDate: bounds.startDate, endDate: shiftYmd(covered.startDate, -1) };
    }
    return { startDate: bounds.startDate, endDate: bounds.endDate };
}

/**
 * PULL THE PLANNED WINDOW BACK OVER ANYTHING STILL UNCERTIFIED, before this run
 * is allowed to certify anything (round-35 gate, finding 1).
 *
 * Gating the high-water mark on the probe already means the ordinary planner
 * usually re-covers a failed window on its own. USUALLY is not an invariant:
 * a deep sweep that failed starts 60 days back while the mark sits days later,
 * so the sweep the next night — one day newer at both ends — misses the oldest
 * day of the span it is supposed to be re-reading. This closes that by asking
 * for the union outright.
 *
 * Too wide for one ask is not an error: it takes the OLDEST slice and sets
 * `continues`, which keeps `complete` false (so nothing is stamped) while the
 * high-water mark advances over the slice that WAS read. The span then drains
 * forward exactly the way a capped planner window does.
 */
export function extendWindowForUncertified(
    window: PullWindow,
    bounds: PullUncertifiedBounds | null | undefined,
): PullWindow {
    if (!bounds) return window;
    if (bounds.startDate >= window.startDate && bounds.endDate <= window.endDate) return window;
    const startDate = bounds.startDate < window.startDate ? bounds.startDate : window.startDate;
    const endDate = bounds.endDate > window.endDate ? bounds.endDate : window.endDate;
    if (spanDays(startDate, endDate) <= PULL_MAX_WINDOW_DAYS) {
        return { ...window, startDate, endDate };
    }
    return {
        startDate,
        endDate: shiftYmd(startDate, PULL_MAX_WINDOW_DAYS - 1),
        // NOT a deep sweep any more: this window was chosen to chase an
        // uncertified span, and stamping `lastFullSweep` from it would claim a
        // sweep that only covered part of its range.
        fullSweep: false,
        continues: true,
    };
}

export interface PullWindow {
    startDate: string;
    endDate: string;
    /** True when this run is the weekly deep sweep. */
    fullSweep: boolean;
    /** True when the window was capped and more history remains behind it. */
    continues: boolean;
}

/**
 * Decide what to ask QuickBooks for.
 *
 * A FIXED "last 7 days" window is wrong in both directions. It re-derives the
 * same week every night (so a backlog behind it is never reached), and it
 * silently misses anything QuickBooks records with an OLDER TxnDate after the
 * fact — a backdated expense, a re-entered check. So:
 *
 *  - normally, from (high-water − 3 days) to today. The overlap re-pulls the
 *    boundary, because an entry edited on the day we last stopped would
 *    otherwise fall in the seam.
 *  - capped at 60 days per run. A wider ask times out at QBO, and the cap sets
 *    `continues` so the next invocation picks up where this one stopped rather
 *    than starting over.
 *  - once a week, a full 60-day sweep regardless of the high-water mark. That
 *    is the only thing that finds a BACKDATED entry, which by definition sits
 *    behind a mark that has already moved past it.
 */
export function planPullWindow(state: PullWindowState, now: Date): PullWindow {
    const today = new Date(now).toISOString().slice(0, 10);
    const dayMs = 86_400_000;
    const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00Z`);

    const sweepDue = state.lastFullSweep === null
        || todayMs - Date.parse(`${state.lastFullSweep}T00:00:00Z`) >= 7 * dayMs;
    if (sweepDue) {
        return {
            startDate: ymd(todayMs - (PULL_FULL_SWEEP_DAYS - 1) * dayMs),
            endDate: today,
            fullSweep: true,
            continues: false,
        };
    }

    const fromMark = state.highWater === null
        ? todayMs - (PULL_MAX_WINDOW_DAYS - 1) * dayMs
        : Date.parse(`${state.highWater}T00:00:00Z`) - PULL_OVERLAP_DAYS * dayMs;
    const startMs = Math.min(fromMark, todayMs);
    const spanDays = Math.floor((todayMs - startMs) / dayMs) + 1;
    if (spanDays > PULL_MAX_WINDOW_DAYS) {
        // Too much history for one ask: take the OLDEST slice first, so the
        // backlog drains forward and the high-water mark advances each run.
        return {
            startDate: ymd(startMs),
            endDate: ymd(startMs + (PULL_MAX_WINDOW_DAYS - 1) * dayMs),
            fullSweep: false,
            continues: true,
        };
    }
    return { startDate: ymd(startMs), endDate: today, fullSweep: false, continues: false };
}

/** The newest TxnDate in a converted batch — the new high-water mark. */
/**
 * Split a fetched window into the PREFIX at/before a saved cursor and the
 * PENDING suffix after it, in the one total order the cursor is recorded in
 * (postedDate, qbTxnId).
 *
 * The split is what makes the prefix rescan in `runBankRegisterPull` possible:
 * `pending` is exactly what `resumeAfter` used to return (and still does — it
 * is now a thin wrapper over this), and `prefix` is everything that split
 * discarded, silently assumed already posted. That assumption is only true for
 * what the run that SET the cursor actually saw. A row QuickBooks inserts
 * LATER with a postedDate/qbTxnId at or before the cursor — a genuine
 * backdate, arriving after the cursor was already written — was never in that
 * run's fetch, so `resumeAfter` alone would discard it forever: the cursor
 * never moves backwards, so every future run repeats the same silent drop.
 */
export function splitAtCursor(
    lines: readonly BankRegisterIngestLine[],
    from: { postedDate: string; qbTxnId: string } | null | undefined,
): { prefix: BankRegisterIngestLine[]; pending: BankRegisterIngestLine[] } {
    const ordered = [...lines].sort((a, b) =>
        (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1
            : a.qbTxnId < b.qbTxnId ? -1 : a.qbTxnId > b.qbTxnId ? 1 : 0));
    if (!from) return { prefix: [], pending: ordered };
    const idx = ordered.findIndex(line =>
        line.postedDate > from.postedDate
        || (line.postedDate === from.postedDate && line.qbTxnId > from.qbTxnId));
    if (idx === -1) return { prefix: ordered, pending: [] };
    return { prefix: ordered.slice(0, idx), pending: ordered.slice(idx) };
}

/**
 * Drop everything up to and including the continuation point.
 *
 * Ordered by (postedDate, qbTxnId) — the same total order the resume point is
 * recorded in, so "after" is unambiguous even when a dozen transactions share a
 * date. Re-posting is harmless (the ingest is idempotent), but re-posting the
 * same prefix every run is what stopped the backlog draining.
 */
export function resumeAfter(
    lines: readonly BankRegisterIngestLine[],
    from: { postedDate: string; qbTxnId: string } | null | undefined,
): BankRegisterIngestLine[] {
    return splitAtCursor(lines, from).pending;
}

export function highWaterOf(lines: readonly BankRegisterIngestLine[], previous: string | null): string | null {
    let best = previous;
    for (const line of lines) {
        if (best === null || line.postedDate > best) best = line.postedDate;
    }
    return best;
}

/**
 * The boundary is WHAT WE SCANNED, not what came back.
 *
 * Deriving it from the returned transactions alone deadlocks the planner the
 * moment a window is empty. A mark from January plus a 60-day cap asks QBO for
 * January–February; if that stretch holds no transactions at all — a quiet
 * period, or a range whose entries were later deleted — nothing comes back, the
 * mark does not move, and the NEXT run plans exactly the same window. The pull
 * never reaches the present, and the register silently stops updating while
 * every run reports success.
 *
 * A completed fetch over [start, end] is proof about the whole range, including
 * the parts of it that were empty. So the boundary advances to `scannedThrough`
 * (the window's end) as well as past any row we actually stored, and never
 * moves backwards.
 */
export function advanceScanBoundary(
    previous: string | null,
    scannedThrough: string,
    lines: readonly BankRegisterIngestLine[],
): string {
    const fromRows = highWaterOf(lines, previous);
    if (fromRows === null) return scannedThrough;
    return scannedThrough > fromRows ? scannedThrough : fromRows;
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface BankRegisterIngestResult {
    status: number;
    body: { ok?: boolean; inserted?: number; existing?: number; reason?: string; qbTxnId?: string } | null;
}

export interface BankRegisterPullDependencies {
    /**
     * Reads the QBO GL for [startDate, endDate] and returns its rows.
     *
     * `clearedProbeOk: false` means the CLEARANCE JOIN failed — the register
     * came back but QuickBooks never said which of its rows had cleared, so
     * every row's `clearedStatus` is "Unknown". The rows are still worth
     * ingesting (clearedStatus is not identity), but nothing clearance-gated
     * could run over them, so this run is NOT proof the register is current.
     * `undefined` means the caller does not report it, which is treated as OK.
     */
    fetchRows(startDate: string, endDate: string): Promise<{ rows: BankRegisterRowLike[]; stale: boolean; clearedProbeOk?: boolean }>;
    /** Posts one batch through the bank-ledger ingest path (source QBO_REGISTER). */
    ingest(account: string, lines: BankRegisterIngestLine[]): Promise<BankRegisterIngestResult>;
    /**
     * Runs the reconcile step for the account. Errors here never fail the pull.
     *
     * `deadlineAt` is an ABSOLUTE epoch-ms deadline, already reduced by
     * `CHECKPOINT_RESERVE_MS`. Reconcile's own batch loop checks it and stops
     * cleanly, reporting the links it did not attempt in `remaining` — a
     * relative budget could not survive being handed across a module boundary,
     * and without one the linker happily ran past the invocation's wall clock
     * and the platform killed the run before the checkpoint was written.
     */
    reconcile(account: string, deadlineAt?: number, scope?: {
        /** Oldest postedDate the scan may read (YYYY-MM-DD). */
        since: string;
        /** The window this run pulled — ambiguity inside it is this run's to answer for. */
        window: { startDate: string; endDate: string };
    }): Promise<{
        linked: number;
        proposed: number;
        /** Chunks whose transaction rolled back. Their links did NOT persist. */
        chunkErrors?: number;
        /** Links this invocation never attempted, because it hit its own cap. */
        remaining?: number;
        /**
         * Same-identity groups reconcile refused to guess a pairing for
         * (Codex round-31 gate, finding 2), RESTRICTED to this run's window
         * (round-33 gate, finding 2). Surfaced here rather than discarded, so
         * a group reconcile could not resolve is visible instead of the run
         * reporting "done" over it — resolution stays manual, this only makes
         * the backlog seen.
         */
        ambiguous?: ReconcileAmbiguousGroup[];
        /**
         * The same thing, from BEFORE this run's window. Watched, reported —
         * and deliberately not a blocker. An unresolved duplicate from two
         * months ago used to hold the freshness stamp down forever, which
         * silently switched every owner's chase cards off (round-33 gate).
         */
        ambiguousStale?: ReconcileAmbiguousGroup[];
        /** Equal-cardinality groups paired deterministically by sorted order, recorded for audit. */
        pairedByOrder?: ReconcilePairedGroup[];
    } | null>;
    /**
     * Mints canonical BankLines from still-unlinked QBO observations
     * (Justin decision 3). Optional and OFF by default: the caller only
     * supplies it when `BANK_LINE_MINT_FROM_QBO === "true"`. Runs after
     * reconcile, so anything the statement already covers is linked and no
     * longer a mint candidate.
     */
    mintFromQbo?(account: string, deadlineAt?: number): Promise<{
        minted: number;
        skipped: Record<string, number>;
        /** False when the mint stopped on its batch cap or the deadline. */
        complete?: boolean;
        /** Where it stopped, when it stopped early. */
        remainingCursor?: string | null;
    } | null>;
    now?(): number;
    /** Wall clock, injectable so the absolute deadline is testable. Defaults to Date.now. */
    clock?(): number;
    account?: string;
    days?: number;
    /** The persisted window state; omitted, the caller gets the legacy fixed window. */
    windowState?: PullWindowState;
    /** Persists the advanced high-water mark and sweep date. Errors fail the run. */
    saveWindowState?(next: PullWindowState): Promise<void>;
    /** Outer wall-clock budget for the whole pull. */
    budgetMs?: number;
    /** Monotonic clock, injectable so the budget is testable. */
    elapsedMs?(): number;
}

/**
 * Held back from the deadline handed to reconcile and mint, so the run still
 * owns enough of its wall clock to write the checkpoint. A run that spends its
 * last millisecond linking rows and is then killed mid-write is the failure
 * this reserve exists to prevent: the work committed, the resume point did not.
 */
export const CHECKPOINT_RESERVE_MS = 5_000;

export interface BankRegisterPullSummary {
    /**
     * Nothing FAILED. A budget-truncated run is still `ok` — it did what it
     * could, correctly.
     */
    ok: boolean;
    /**
     * Everything this run set out to do actually happened: the whole window
     * was fetched and ingested, no history remains behind the window, and
     * reconcile attempted every link it planned.
     *
     * SEPARATE FROM `ok` on purpose. Folding the two together forced a choice
     * between two wrong answers: call a truncated run a failure (and page a
     * human at 2am for a backlog that is draining normally), or call it a
     * success (and let it MINT canonical ledger rows from a window it only
     * half read, and stamp the freshness clock the health check trusts).
     * `ok` decides the HTTP status; `complete` decides whether this run's
     * picture is whole enough to act on.
     */
    complete: boolean;
    account: string;
    startDate: string;
    endDate: string;
    /** True when QBO didn't answer and a cached fetch was served. */
    stale: boolean;
    /**
     * Did the CLEARANCE PROBE answer? (Codex PR #443 gate round 33, finding 1.)
     *
     * `fetchBankRegister` deliberately lets the clearance join fail on its own —
     * the register is still the register without it. What is NOT still true is
     * that this run saw enough to act: every row comes back `Unknown`, so
     * minting (which requires Cleared/Reconciled) can do nothing and the uncleared
     * count is meaningless. A run in that state used to be reported as a complete
     * pull and stamped the freshness clock, telling the health check and the
     * chaser that the register was current while the one thing the register is
     * FOR could not run.
     */
    clearedProbeOk: boolean;
    /**
     * WHY this run is not a complete, actable pull, when the cause is not a
     * failure. Distinct from `error`, which means something went wrong.
     */
    reason?: string;
    rows: number;
    observations: number;
    skipped: number;
    collapsed: number;
    inserted: number;
    existing: number;
    /** Set when a batch came back non-OK; later batches are not attempted. */
    error?: string;
    /**
     * Every qbTxnId this run refused to post: divergent repeats inside the
     * fetch, plus the id the ingest route 409'd on, if any. A non-empty list
     * makes the cron answer 500 — it is a QuickBooks restatement, and a human
     * has to look. Batches that already committed stay committed; re-running is
     * a no-op for them.
     */
    conflictQbTxnIds?: string[];
    reconciled?: {
        linked: number;
        proposed: number;
        chunkErrors?: number;
        remaining?: number;
        ambiguous?: ReconcileAmbiguousGroup[];
        ambiguousStale?: ReconcileAmbiguousGroup[];
        pairedByOrder?: ReconcilePairedGroup[];
    } | null;
    /** The point this run resumed FROM, when it resumed. */
    resumedAfter?: { postedDate: string; qbTxnId: string } | null;
    /** The point the NEXT run should resume from, when this one stopped early. */
    continueAfter?: { postedDate: string; qbTxnId: string } | null;
    /** True when the run stopped on its own budget with work left behind. */
    continues?: boolean;
    /** Batches not attempted this invocation — the durable continuation point. */
    remainingBatches?: number;
    /** This run's window, and whether it was the weekly deep sweep. */
    fullSweep?: boolean;
    highWater?: string | null;
    /** Why minting was held back this run, when it was. */
    mintSkipped?: "stale-fetch" | "conflicts" | "ingest-failed" | "incomplete-window" | "cleared-probe-failed";
    /**
     * The window this run parked for a continuation to re-run, or null when it
     * parked none (and cleared any it inherited). Reported so a failed probe is
     * visible as SCHEDULED work rather than as a run that merely said `complete:
     * false` and left nothing behind.
     */
    retryPending?: PullRetryPending | null;
    /**
     * The days whose clearance is STILL unknown once this run is done, as they
     * were persisted — null when there are none.
     *
     * The route reads this and nothing else to decide whether it may stamp
     * `bankRegisterPullLastSuccess`: a narrow, healthy, complete window over
     * three days is not evidence about the week behind it that never got a
     * clearance answer (round-35 gate, finding 1).
     */
    uncertified?: PullUncertifiedBounds | null;
    /** When the outstanding uncertified span first went unanswered (ISO). */
    uncertifiedSince?: string | null;
    minted?: {
        minted: number;
        skipped: Record<string, number>;
        complete?: boolean;
        remainingCursor?: string | null;
    } | null;
}

/**
 * The nightly pull, with every I/O edge injected so the whole thing —
 * including the "run it twice, insert nothing the second time" promise — is
 * testable without QuickBooks or a database.
 *
 * A 409 (QuickBooks restated a transaction we already recorded) STOPS the run:
 * later batches are not attempted while a restatement is unresolved, exactly
 * as the script did. That is a human's decision, not a retry.
 */
export async function runBankRegisterPull(
    dependencies: BankRegisterPullDependencies,
): Promise<BankRegisterPullSummary> {
    const account = dependencies.account ?? BANK_REGISTER_ACCOUNT;
    const nowMs = dependencies.now ? dependencies.now() : Date.now();
    const days = dependencies.days ?? BANK_REGISTER_PULL_DAYS;
    /**
     * A PARKED RETRY WINDOW OUTRANKS THE PLANNER.
     *
     * Its bounds are the ones whose clearance is still unknown, and the
     * high-water mark has already moved past them (the ingest DID finish), so
     * `planPullWindow` would ask QuickBooks about a narrower span and leave the
     * uncertified part uncertified forever. Re-running the same bounds re-runs
     * the probe and the clearance-dependent mint over exactly the rows that
     * needed them.
     *
     * A due deep sweep is deferred, not lost: `lastFullSweep` is untouched while
     * a retry is outstanding, so the sweep plans on the first run after the
     * retry clears — at most PROBE_RETRY_LIMIT invocations later.
     */
    const retryWindow = dependencies.windowState?.retryPending ?? null;
    // The window is PLANNED from the persisted high-water mark when the caller
    // keeps one; the fixed-days form is the fallback for tests and one-offs.
    const plannedBase: PullWindow = retryWindow
        ? { startDate: retryWindow.startDate, endDate: retryWindow.endDate, fullSweep: false, continues: false }
        : dependencies.windowState
            ? planPullWindow(dependencies.windowState, new Date(nowMs))
            : { startDate: ymdDaysAgo(days - 1, nowMs), endDate: new Date(nowMs).toISOString().slice(0, 10), fullSweep: false, continues: false };
    /**
     * AND WHATEVER IT PLANNED, IT MUST COVER EVERY DAY STILL UNCERTIFIED.
     *
     * The retry marker expires after PROBE_RETRY_LIMIT attempts; the bounds do
     * not. Without this the run after an exhausted retry asked for the ordinary
     * 3-day overlap, got a clean probe over it, and stamped the freshness clock
     * — certifying a register whose older half had never been read with a
     * working clearance report (round-35 gate, finding 1).
     */
    const planned = extendWindowForUncertified(plannedBase, dependencies.windowState?.uncertifiedBounds);
    const { startDate, endDate } = planned;
    const elapsed = dependencies.elapsedMs ?? (() => 0);
    const budgetMs = dependencies.budgetMs ?? Number.POSITIVE_INFINITY;
    const clock = dependencies.clock ?? (() => Date.now());
    /**
     * The ABSOLUTE instant reconcile and mint must be finished by, minus the
     * checkpoint reserve. Read fresh each time: the fetch and the ingest have
     * already spent part of the budget by the time reconcile starts, and
     * handing it the budget it had at the top of the run would be handing it
     * time that no longer exists.
     */
    const workDeadline = (): number | undefined => (
        Number.isFinite(budgetMs)
            ? clock() + (budgetMs - elapsed()) - CHECKPOINT_RESERVE_MS
            : undefined
    );

    const fetched = await dependencies.fetchRows(startDate, endDate);
    // A caller that does not report the probe is treated as OK; only an
    // explicit `false` is a failed probe. Nothing else may make this false —
    // "we did not ask" and "we asked and could not get an answer" are the same
    // shape of unknown, and inventing the second from the first would hold the
    // stamp down for every caller that predates the field.
    const clearedProbeOk = fetched.clearedProbeOk !== false;
    const { lines, skipped, collapsed, conflicts } = convertRegisterRows(fetched.rows);

    // A STALE fetch is QuickBooks not answering: the rows are a cached copy from
    // an earlier run, so "we pulled the register" is not true of this one. It
    // used to be a display flag only, and a night where QBO was down reported
    // success.
    const summary: BankRegisterPullSummary = {
        ok: !fetched.stale,
        // Assumed whole until something proves otherwise, below.
        complete: !fetched.stale,
        account,
        startDate,
        endDate,
        stale: fetched.stale,
        clearedProbeOk,
        rows: fetched.rows.length,
        observations: lines.length,
        skipped,
        collapsed,
        inserted: 0,
        existing: 0,
        ...(fetched.stale ? { error: "qbo-stale-cache" } : {}),
    };
    // A FAILED CLEARANCE PROBE IS NOT A FAILED PULL, and it is not a complete
    // one either. The rows land (clearedStatus is deliberately outside the
    // identity hash, so storing them as "Unknown" cannot restate anything and
    // the next good probe refreshes them), reconcile still links what it can —
    // and nothing certifies the register as current. `complete: false` is what
    // withholds the freshness stamp, holds minting back, and lets the chaser's
    // own freshness gate hold today's cards until a run with a real clearance
    // answer replaces this one.
    if (!clearedProbeOk) {
        summary.complete = false;
        summary.reason = "cleared-probe-failed";
    }
    // Divergent repeats inside the fetch are already a conflict, and the run is
    // already failed — but the NON-conflicting lines still post. They are good
    // evidence, the ingest is idempotent, and holding a whole night's register
    // hostage to one restated transaction would starve the matcher for a reason
    // that has nothing to do with the other rows.
    if (conflicts.length > 0) {
        summary.ok = false;
        summary.complete = false;
        summary.error = "qbo-duplicate-conflict";
        summary.conflictQbTxnIds = [...conflicts];
    }
    summary.fullSweep = planned.fullSweep;
    // A CAPPED window is not an incomplete RUN, but it is an incomplete
    // PICTURE: history remains behind it, and minting from a partial backlog
    // creates canonical rows whose statement counterpart is in the part we have
    // not read yet.
    if (planned.continues) summary.complete = false;
    // NOTE: no early return on an empty fetch. Reconciliation still has to run —
    // yesterday's observations may be waiting for a canonical line that only
    // arrived today, and skipping the backlog because TONIGHT'S register was
    // empty is how those sat unlinked indefinitely.
    // ── OUTER WALL-CLOCK BUDGET ──────────────────────────────────────────────
    // The fetch already happened; ingest, reconcile and mint all still have to
    // fit. Being killed by the platform mid-ingest wrote no high-water mark at
    // all, so the next run re-fetched the same window and died at the same
    // point. Now the run stops on its own terms, records how far it got, and
    // says so.
    // RESUME INSIDE THE WINDOW. Ordered, and past whatever the last run
    // finished, so a budget-limited run makes real progress every time instead
    // of re-posting its own first batches.
    const cursor = dependencies.windowState?.continueAfter;
    const { prefix, pending } = splitAtCursor(lines, cursor);
    summary.resumedAfter = cursor ?? null;
    const batches = chunkLines(pending, BANK_REGISTER_CHUNK_SIZE);
    let batchIndex = 0;
    let lastPosted: BankRegisterIngestLine | null = null;
    // Whether THIS loop — the pending rows after the cursor — was cut short by
    // the budget. Kept separate from `summary.continues`, which the prefix
    // rescan below can also set: only a truncation HERE means there is more
    // pending work to resume, and only then should the cursor advance.
    let pendingTruncated = false;
    for (const batch of batches) {
        if (elapsed() >= budgetMs) {
            summary.continues = true;
            // Truncated, not failed: it posted what it could and recorded where
            // to carry on. `ok` stays true; `complete` is what says the picture
            // is partial, and it is `complete` that gates minting and the
            // freshness stamp.
            summary.complete = false;
            summary.remainingBatches = batches.length - batchIndex;
            pendingTruncated = true;
            break;
        }
        batchIndex++;
        const { status, body } = await dependencies.ingest(account, batch);
        if (status === 200 && body?.ok) {
            summary.inserted += body.inserted ?? 0;
            summary.existing += body.existing ?? 0;
            lastPosted = batch[batch.length - 1] ?? lastPosted;
            continue;
        }
        summary.ok = false;
        summary.complete = false;
        summary.error = body?.reason ?? `http-${status}`;
        if (body?.qbTxnId) {
            summary.conflictQbTxnIds = [...new Set([...(summary.conflictQbTxnIds ?? []), body.qbTxnId])];
        }
        break;
    }

    // RESCAN THE PREFIX ON THE FINISHING RUN, before this window is ever
    // allowed to look complete.
    //
    // `pending` only ever covers rows strictly AFTER the saved cursor —
    // everything at or before it was assumed already posted by whichever run
    // set that cursor. That assumption holds for what THAT run actually saw at
    // its own fetch time, but not for a row QuickBooks records LATER with an
    // older postedDate/qbTxnId (a genuine backdate): `resumeAfter`/`splitAtCursor`
    // would silently discard it on every run from now on, because the cursor
    // never moves backwards to let it back in.
    //
    // So the run that finishes draining `pending` — and ONLY that run, and only
    // when there was a cursor to begin with — re-posts the PREFIX too, through
    // the same idempotent ingest (upsert keyed by qbTxnId). A row already
    // stored comes back `existing` and costs nothing; a row that genuinely
    // never posted is caught here, on the one run positioned to see it before
    // the window is stamped complete and the cursor is cleared. A restated row
    // (same qbTxnId, different content) 409s exactly like any other conflict —
    // reconciled by a human, never silently skipped.
    if (summary.ok && !pendingTruncated && cursor && prefix.length > 0) {
        const prefixBatches = chunkLines(prefix, BANK_REGISTER_CHUNK_SIZE);
        for (const batch of prefixBatches) {
            if (elapsed() >= budgetMs) {
                // BUDGET RAN OUT DURING THE RESCAN ITSELF. Deliberately does NOT
                // touch `summary.continueAfter` — leaving it unset falls back to
                // the unchanged original cursor below, so the window is neither
                // marked complete nor advanced, and the next run repeats the
                // rescan rather than certifying a prefix only half re-verified.
                summary.continues = true;
                summary.complete = false;
                break;
            }
            const { status, body } = await dependencies.ingest(account, batch);
            if (status === 200 && body?.ok) {
                summary.inserted += body.inserted ?? 0;
                summary.existing += body.existing ?? 0;
                continue;
            }
            summary.ok = false;
            summary.complete = false;
            summary.error = body?.reason ?? `http-${status}`;
            if (body?.qbTxnId) {
                summary.conflictQbTxnIds = [...new Set([...(summary.conflictQbTxnIds ?? []), body.qbTxnId])];
            }
            break;
        }
    }

    // Reconcile even after a partial ingest: whatever DID land is real
    // evidence, and linking it is what unblocks receipt matching. A reconcile
    // failure is reported, never thrown — the observations are already stored.
    try {
        // The absolute deadline, minus the checkpoint reserve, so the linker's
        // own batch loop stops in time for this run to record where it got to.
        // THE SCAN'S BOUND AND THIS RUN'S OWN WINDOW, both handed down (Codex
        // round-33 gate, finding 2). Reconcile used to read the whole table and
        // report every duplicate group it found as this run's problem, so one
        // unresolvable pair from any month past could withhold the stamp — and
        // the cards — permanently.
        const reconciled = await dependencies.reconcile(account, workDeadline(), {
            since: reconcileScanSince(startDate, new Date(nowMs)),
            window: { startDate, endDate },
        });
        summary.reconciled = reconciled;
        // A ROLLED-BACK CHUNK IS A FAILURE; LINKS NOT ATTEMPTED ARE MERELY
        // INCOMPLETE. Both leave observations unlinked, which starves the
        // matcher — but only one of them is something going wrong. `remaining`
        // is the linker hitting its own cap or this run's deadline, which is
        // the system working as designed and draining over several passes;
        // paging a human for it trains them to ignore the page.
        if (reconciled && (reconciled.chunkErrors ?? 0) > 0) {
            summary.ok = false;
            summary.complete = false;
            summary.error = summary.error ?? "reconcile-chunk-errors";
        } else if (reconciled && (reconciled.remaining ?? 0) > 0) {
            summary.complete = false;
            summary.error = summary.error ?? "reconcile-incomplete";
        }
    } catch (error) {
        summary.reconciled = null;
        // A reconcile failure is not cosmetic: unlinked observations are what
        // starve the matcher, which is the entire reason this cron exists.
        // Swallowing it returned 200 and nothing was ever paged.
        summary.ok = false;
        summary.complete = false;
        summary.error = summary.error ?? "reconcile-failed";
        console.error("[bank-register-pull] reconcile failed", error instanceof Error ? error.message : "UnknownError");
    }

    // MINTING NEEDS A CLEAN, FRESH PULL — reconciliation does not.
    //
    // Minting CREATES canonical ledger rows from what this run believes it saw.
    // A stale cache is last run's data; a divergent repeat or an ingest conflict
    // means QuickBooks restated something we hold. Minting on any of those
    // writes a permanent row from a picture we already know is wrong, and
    // `amountCents` is immutable by trigger, so only a human can undo it.
    // Reconciliation just LINKS rows that already exist, so it always runs.
    // AND IT NEEDS A COMPLETE ONE. A budget-truncated run has ingested only
    // part of its window, so an observation whose canonical line is in the part
    // it never read looks unmatched — and minting turns that into a permanent
    // duplicate BankLine that only a human can unpick.
    // AND IT NEEDS A CLEARANCE ANSWER. Minting is gated on QuickBooks having
    // said a row cleared; with the probe down every row reads "Unknown", so a
    // mint pass could only ever skip everything — and reporting that as a
    // finished mint is how the run came to look complete (round-33 gate).
    const mintIsSafe = summary.ok && summary.complete && !fetched.stale && clearedProbeOk && conflicts.length === 0;
    if (dependencies.mintFromQbo && !mintIsSafe) {
        summary.minted = null;
        summary.mintSkipped = fetched.stale
            ? "stale-fetch"
            : conflicts.length > 0
                ? "conflicts"
                : !clearedProbeOk
                    ? "cleared-probe-failed"
                    : summary.ok
                        ? "incomplete-window"
                        : "ingest-failed";
    }
    if (dependencies.mintFromQbo && mintIsSafe) {
        try {
            summary.minted = await dependencies.mintFromQbo(account, workDeadline());
            // A TRUNCATED MINT IS NOT A COMPLETE RUN. It is not a failure
            // either — the batch cap and the deadline are the system working —
            // but a backlog of unminted observations is exactly the state the
            // freshness stamp must not certify as current.
            if (summary.minted && summary.minted.complete === false) {
                summary.complete = false;
                summary.error = summary.error ?? "mint-incomplete";
            }
        } catch (error) {
            summary.minted = null;
            summary.ok = false;
            summary.complete = false;
            summary.error = summary.error ?? "mint-failed";
            console.error("[bank-register-pull] mint failed", error instanceof Error ? error.message : "UnknownError");
        }
    }

    // THE HIGH-WATER MARK MOVES ONLY ON A CLEAN, COMPLETE RUN. Advancing it
    // after a partial or conflicted pull would step the next run's window past
    // rows this one never actually stored.
    // A run that stopped early records WHERE, so the next one carries on.
    //
    // GATED ON `pendingTruncated`, not the broader `summary.continues` — the
    // prefix rescan above can also set `continues` when ITS budget runs out,
    // and `lastPosted` there is stale (the last row of `pending`, not of the
    // rescan). Advancing the cursor to it would mark part of the prefix
    // re-verified that never actually was. Leaving `continueAfter` unset in
    // that case falls through to the unchanged original cursor below.
    if (pendingTruncated && lastPosted) {
        summary.continueAfter = { postedDate: lastPosted.postedDate, qbTxnId: lastPosted.qbTxnId };
    }

    /**
     * PARK THE WINDOW WHEN IT INGESTED BUT COULD NOT BE CERTIFIED.
     *
     * `clearedProbeOk === false` is the retryable incompleteness: the rows are
     * stored and idempotent, and the only thing missing is an answer QuickBooks
     * may well give in fifteen minutes. Parking it is what makes
     * `pullContinuationPending` true, which is the only thing the resume pass
     * looks at — without it a probe failure at 02:00 was invisible to every one
     * of the day's continuation slots.
     *
     * `attempts` only carries forward for the SAME bounds; a different window
     * failing is a new problem and starts its own count. Past the limit the
     * marker is dropped rather than re-parked: the window stays uncertified (the
     * stamp is withheld either way) and `bank-pull-stale` becomes the signal,
     * instead of a dead report endpoint burning all 44 slots every day.
     */
    let retryPending: PullRetryPending | null = null;
    if (!clearedProbeOk) {
        const sameWindow = retryWindow !== null
            && retryWindow.startDate === startDate
            && retryWindow.endDate === endDate;
        const attempts = (sameWindow ? retryWindow.attempts : 0) + 1;
        if (attempts > PROBE_RETRY_LIMIT) {
            summary.reason = "probe-retries-exhausted";
        } else {
            retryPending = { startDate, endDate, reason: "cleared-probe-failed", attempts };
        }
    }
    summary.retryPending = retryPending;

    /**
     * THE DURABLE HALF: WHICH DAYS ARE STILL UNCERTIFIED.
     *
     * `retryPending` schedules the next attempt and is deliberately dropped
     * once the attempts run out. These bounds are the OBLIGATION underneath it
     * and are never dropped on a clock — only a run that re-reads them with a
     * working probe may clear them.
     *
     * A window is subtracted only when this run both READ all of it
     * (`!summary.continues`) and got a real clearance answer over it. A
     * truncated run read part of its window, and part is not an answer about
     * the whole.
     */
    const inheritedBounds = dependencies.windowState?.uncertifiedBounds ?? null;
    const inheritedSince = dependencies.windowState?.uncertifiedSince ?? null;
    let uncertifiedBounds: PullUncertifiedBounds | null = inheritedBounds;
    let uncertifiedSince: string | null = inheritedSince;
    if (!clearedProbeOk) {
        uncertifiedBounds = mergeUncertifiedBounds(inheritedBounds, { startDate, endDate });
        // The clock starts at the FIRST failure and keeps running: an operator
        // needs to know how long the hole has been open, not when the most
        // recent attempt at it failed.
        uncertifiedSince = inheritedSince ?? new Date(nowMs).toISOString();
    } else if (summary.ok && !summary.continues) {
        uncertifiedBounds = subtractCertifiedWindow(inheritedBounds, { startDate, endDate });
    }
    if (uncertifiedBounds === null) uncertifiedSince = null;
    summary.uncertified = uncertifiedBounds;
    summary.uncertifiedSince = uncertifiedSince;

    if (dependencies.saveWindowState && dependencies.windowState && summary.ok) {
        // NOT `summary.complete`. This asks the narrower question "did this run
        // ingest every batch of the window it fetched?", and a CAPPED window
        // that finished is exactly the case whose mark must advance — that
        // advance is how a backlog drains forward instead of re-planning the
        // same window forever. `summary.complete` is about the whole picture
        // and is deliberately false for a capped window.
        const windowFullyIngested = !summary.continues;
        /**
         * AND IT MUST ALSO BE CERTIFIED (round-35 gate, finding 1).
         *
         * A failed clearance probe ingests its whole window, so
         * `windowFullyIngested` is true and the mark used to advance straight
         * over it. That is what made the hole permanent: the next run planned
         * from the advanced mark, asked about a NARROWER span, got a healthy
         * probe, and stamped success — while the days behind it had never been
         * read with a working clearance report and were never offered to the
         * mint. An uncertified window is not a swept window.
         */
        const windowSwept = windowFullyIngested && clearedProbeOk;
        // The mark still only moves when the window was fully ingested —
        // stepping it past rows this one never stored would lose them. And it
        // moves to the window's END DATE, not merely the newest row that
        // happened to come back (see advanceScanBoundary).
        const highWater = windowSwept
            ? advanceScanBoundary(dependencies.windowState.highWater, endDate, lines)
            : dependencies.windowState.highWater;
        summary.highWater = highWater;
        try {
            await dependencies.saveWindowState({
                mintRemainingCursor: summary.minted?.remainingCursor ?? null,
                // THE RECONCILE BACKLOG, WRITTEN DOWN (round-36 gate, finding 1).
                // `complete` already said this run left links undone; this is the
                // half that survives the response and gives the continuation
                // something to see. Null when there is nothing outstanding, so a
                // drained backlog stops waking the resume pass.
                reconcileRemaining: (summary.reconciled?.remaining ?? 0) > 0
                    ? summary.reconciled?.remaining ?? null
                    : null,
                // AND THE PLAIN FACT THAT THIS RUN DID NOT FINISH. Written on
                // every save, so the flag can never outlive the state it
                // describes; false the moment a run completes the picture.
                continuationPending: !summary.complete && clearedProbeOk,
                // CARRIED, NEVER CLEARED HERE (round-37 gate, finding 2). An
                // owed freshness stamp is discharged by the write that commits
                // the marker, in that write's own transaction; a save that
                // omitted this field would silently drop the obligation on any
                // run that did not happen to stamp — which is every run held
                // back by ambiguity, and every continuation of one.
                stampPending: dependencies.windowState.stampPending === true,
                highWater,
                // Same rule: a sweep nobody could certify is not a sweep that
                // happened, and recording it would push the next one a week out.
                lastFullSweep: windowSwept && planned.fullSweep
                    ? endDate
                    : dependencies.windowState.lastFullSweep,
                // Cleared on a finished window; set when we stopped part way.
                continueAfter: windowFullyIngested ? null : summary.continueAfter ?? dependencies.windowState.continueAfter ?? null,
                // Written on EVERY save, so a recovered probe clears the marker
                // rather than leaving the resume pass re-running a window that
                // is now certified — the same "latches nothing" rule the blocked
                // reason follows.
                retryPending,
                // The obligation that outlives the retry schedule. Written on
                // every save, so a run that genuinely re-read the span clears
                // it and a run that did not carries it forward untouched.
                uncertifiedBounds,
                uncertifiedSince,
            });
        } catch (error) {
            // Same reasoning as the sweep's cursor: work committed, the
            // checkpoint did not, so the run must not report success.
            summary.ok = false;
            summary.complete = false;
            summary.error = summary.error ?? "window-state-write-failed";
            console.error("[bank-register-pull] window state write failed", error instanceof Error ? error.message : "UnknownError");
        }
    } else if (planned.continues) {
        summary.continues = true;
    }

    return summary;
}
