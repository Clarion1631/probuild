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
 * EVIDENCE — the bank statement remains true north, canonical `BankLine` rows
 * are minted ONLY from STATEMENT observations, and linking an observation to a
 * canonical line is the separate, explicit reconcile step, never an
 * ingest-time side effect.
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
 */

export interface BankRegisterRowLike {
    date: string;
    qbType: string;
    qbTxnId: string | null;
    docNum: string | null;
    name: string | null;
    amountCents: number;
    /**
     * The GL's memo/description cell. The bank feed usually leaves the ORIGINAL
     * POS descriptor here — "LOWES #02516 POS DEB C#8516" — which is the only
     * place a QBO row carries the card tail. Without it every QBO-minted line
     * resolved to `office` and the crew was never asked (Codex round-4 item 7).
     */
    memo?: string | null;
}

export interface BankRegisterIngestLine {
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
    qbTxnId: string;
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
    // THE BANK FEED'S OWN TEXT, or QuickBooks' name when there is none. NOT a
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
    return { postedDate: row.date, amountCents: row.amountCents, rawDescriptor, checkNumber, qbTxnId: row.qbTxnId };
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

/** The content that makes two rows under one qbTxnId the same observation. */
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
    const ordered = [...lines].sort((a, b) =>
        (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1
            : a.qbTxnId < b.qbTxnId ? -1 : a.qbTxnId > b.qbTxnId ? 1 : 0));
    if (!from) return ordered;
    return ordered.filter(line =>
        line.postedDate > from.postedDate
        || (line.postedDate === from.postedDate && line.qbTxnId > from.qbTxnId));
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
    /** Reads the QBO GL for [startDate, endDate] and returns its rows. */
    fetchRows(startDate: string, endDate: string): Promise<{ rows: BankRegisterRowLike[]; stale: boolean }>;
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
    reconcile(account: string, deadlineAt?: number): Promise<{
        linked: number;
        proposed: number;
        /** Chunks whose transaction rolled back. Their links did NOT persist. */
        chunkErrors?: number;
        /** Links this invocation never attempted, because it hit its own cap. */
        remaining?: number;
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
    reconciled?: { linked: number; proposed: number; chunkErrors?: number; remaining?: number } | null;
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
    mintSkipped?: "stale-fetch" | "conflicts" | "ingest-failed" | "incomplete-window";
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
    // The window is PLANNED from the persisted high-water mark when the caller
    // keeps one; the fixed-days form is the fallback for tests and one-offs.
    const planned = dependencies.windowState
        ? planPullWindow(dependencies.windowState, new Date(nowMs))
        : { startDate: ymdDaysAgo(days - 1, nowMs), endDate: new Date(nowMs).toISOString().slice(0, 10), fullSweep: false, continues: false };
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
        rows: fetched.rows.length,
        observations: lines.length,
        skipped,
        collapsed,
        inserted: 0,
        existing: 0,
        ...(fetched.stale ? { error: "qbo-stale-cache" } : {}),
    };
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
    const pending = resumeAfter(lines, dependencies.windowState?.continueAfter);
    summary.resumedAfter = dependencies.windowState?.continueAfter ?? null;
    const batches = chunkLines(pending, BANK_REGISTER_CHUNK_SIZE);
    let batchIndex = 0;
    let lastPosted: BankRegisterIngestLine | null = null;
    for (const batch of batches) {
        if (elapsed() >= budgetMs) {
            summary.continues = true;
            // Truncated, not failed: it posted what it could and recorded where
            // to carry on. `ok` stays true; `complete` is what says the picture
            // is partial, and it is `complete` that gates minting and the
            // freshness stamp.
            summary.complete = false;
            summary.remainingBatches = batches.length - batchIndex;
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

    // Reconcile even after a partial ingest: whatever DID land is real
    // evidence, and linking it is what unblocks receipt matching. A reconcile
    // failure is reported, never thrown — the observations are already stored.
    try {
        // The absolute deadline, minus the checkpoint reserve, so the linker's
        // own batch loop stops in time for this run to record where it got to.
        const reconciled = await dependencies.reconcile(account, workDeadline());
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
    const mintIsSafe = summary.ok && summary.complete && !fetched.stale && conflicts.length === 0;
    if (dependencies.mintFromQbo && !mintIsSafe) {
        summary.minted = null;
        summary.mintSkipped = fetched.stale
            ? "stale-fetch"
            : conflicts.length > 0
                ? "conflicts"
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
    if (summary.continues && lastPosted) {
        summary.continueAfter = { postedDate: lastPosted.postedDate, qbTxnId: lastPosted.qbTxnId };
    }

    if (dependencies.saveWindowState && dependencies.windowState && summary.ok) {
        // NOT `summary.complete`. This asks the narrower question "did this run
        // ingest every batch of the window it fetched?", and a CAPPED window
        // that finished is exactly the case whose mark must advance — that
        // advance is how a backlog drains forward instead of re-planning the
        // same window forever. `summary.complete` is about the whole picture
        // and is deliberately false for a capped window.
        const windowFullyIngested = !summary.continues;
        // The mark still only moves when the window was fully ingested —
        // stepping it past rows this one never stored would lose them. And it
        // moves to the window's END DATE, not merely the newest row that
        // happened to come back (see advanceScanBoundary).
        const highWater = windowFullyIngested
            ? advanceScanBoundary(dependencies.windowState.highWater, endDate, lines)
            : dependencies.windowState.highWater;
        summary.highWater = highWater;
        try {
            await dependencies.saveWindowState({
                mintRemainingCursor: summary.minted?.remainingCursor ?? null,
                highWater,
                lastFullSweep: windowFullyIngested && planned.fullSweep
                    ? endDate
                    : dependencies.windowState.lastFullSweep,
                // Cleared on a finished window; set when we stopped part way.
                continueAfter: windowFullyIngested ? null : summary.continueAfter ?? dependencies.windowState.continueAfter ?? null,
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
