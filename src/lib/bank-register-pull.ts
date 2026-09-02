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
    const parts: string[] = [];
    if (row.name && row.name.trim()) parts.push(row.name.trim());
    // MEMO BEFORE TYPE. The bank feed usually parks the original POS descriptor
    // here, and that is where `C#8516` lives — the only owner signal a QBO row
    // has. `identityPayee` strips the trailing type word from both sides, so
    // adding the memo does not break identity; dropping it lost the owner.
    if (row.memo && row.memo.trim()) parts.push(row.memo.trim());
    if (row.qbType && row.qbType.trim()) parts.push(row.qbType.trim());
    const rawDescriptor = parts.join(" ").replace(/\s+/g, " ").trim();
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
    /** Runs the reconcile step for the account. Errors here never fail the pull. */
    reconcile(account: string): Promise<{ linked: number; proposed: number } | null>;
    /**
     * Mints canonical BankLines from still-unlinked QBO observations
     * (Justin decision 3). Optional and OFF by default: the caller only
     * supplies it when `BANK_LINE_MINT_FROM_QBO === "true"`. Runs after
     * reconcile, so anything the statement already covers is linked and no
     * longer a mint candidate.
     */
    mintFromQbo?(account: string): Promise<{ minted: number; skipped: Record<string, number> } | null>;
    now?(): number;
    account?: string;
    days?: number;
}

export interface BankRegisterPullSummary {
    ok: boolean;
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
    reconciled?: { linked: number; proposed: number } | null;
    minted?: { minted: number; skipped: Record<string, number> } | null;
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
    const endDate = new Date(nowMs).toISOString().slice(0, 10);
    const startDate = ymdDaysAgo(days - 1, nowMs);

    const fetched = await dependencies.fetchRows(startDate, endDate);
    const { lines, skipped, collapsed, conflicts } = convertRegisterRows(fetched.rows);

    const summary: BankRegisterPullSummary = {
        ok: true,
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
    };
    // Divergent repeats inside the fetch are already a conflict, and the run is
    // already failed — but the NON-conflicting lines still post. They are good
    // evidence, the ingest is idempotent, and holding a whole night's register
    // hostage to one restated transaction would starve the matcher for a reason
    // that has nothing to do with the other rows.
    if (conflicts.length > 0) {
        summary.ok = false;
        summary.error = "qbo-duplicate-conflict";
        summary.conflictQbTxnIds = [...conflicts];
    }
    if (lines.length === 0) return summary;

    for (const batch of chunkLines(lines, BANK_REGISTER_CHUNK_SIZE)) {
        const { status, body } = await dependencies.ingest(account, batch);
        if (status === 200 && body?.ok) {
            summary.inserted += body.inserted ?? 0;
            summary.existing += body.existing ?? 0;
            continue;
        }
        summary.ok = false;
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
        summary.reconciled = await dependencies.reconcile(account);
    } catch (error) {
        summary.reconciled = null;
        // A reconcile failure is not cosmetic: unlinked observations are what
        // starve the matcher, which is the entire reason this cron exists.
        // Swallowing it returned 200 and nothing was ever paged.
        summary.ok = false;
        summary.error = summary.error ?? "reconcile-failed";
        console.error("[bank-register-pull] reconcile failed", error instanceof Error ? error.message : "UnknownError");
    }

    // Minting runs AFTER reconcile, never before: an observation the statement
    // already covers gets linked first and is then no longer a mint candidate,
    // which is what keeps one transaction on one canonical line.
    if (dependencies.mintFromQbo) {
        try {
            summary.minted = await dependencies.mintFromQbo(account);
        } catch (error) {
            summary.minted = null;
            summary.ok = false;
            summary.error = summary.error ?? "mint-failed";
            console.error("[bank-register-pull] mint failed", error instanceof Error ? error.message : "UnknownError");
        }
    }

    return summary;
}
