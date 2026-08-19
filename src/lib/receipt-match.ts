/**
 * Receipt-completeness matcher (Phase 1, step 2 of
 * docs/plans/PROFIT-LOOP-PLAN.md — "the Marge engine").
 *
 * Decides, for each canonical BankLine still at POSTED, whether its
 * reconciled QBO observation leads to a ProBuild Expense carrying receipt
 * evidence (a non-empty receiptUrl). If yes, it PROPOSES advancing the line
 * to EVIDENCE_FOUND with that receiptUrl copied over; if not, the line is
 * reported on the `unmatched` list (the daily missing-receipt list), tagged
 * with a reason and the card rail extracted from rawDescriptor so the cron
 * can render a per-person list (…8516 = CJ, …6098 = Richard).
 *
 * PURE, like reconcileObservations in src/lib/bank-ledger.ts: no Prisma, no
 * I/O — the caller (the receipt-match route) queries and passes plain
 * arrays, then persists the proposals itself. Same house rules:
 *   - exact-match joins only (bankLineId, then qbPurchaseId), never
 *     amount/date/rails heuristics;
 *   - ambiguity is NEVER resolved by input order or by guessing — an
 *     ambiguous group produces no proposal and is surfaced explicitly;
 *   - amounts are never read for matching and never present in a proposal —
 *     BankLine.amountCents is immutable and this module cannot touch it.
 */

// ── Input shapes (plain rows, caller-queried) ────────────────────────────

export interface ReceiptMatchBankLine {
    id: string;
    /** BankLine.state — only "POSTED" lines are considered; anything else is skipped (already advanced, or EXCEPTION). */
    state: string;
    /** YYYY-MM-DD — passed through to `unmatched` for human rendering only, never used to match. */
    postedDate: string;
    /** Signed cents — passed through to `unmatched` for human rendering only, never used to match and never proposed for change. */
    amountCents: number;
    rawDescriptor: string;
}

export interface ReceiptMatchObservation {
    id: string;
    /** BankLineObservation.source — only "QBO_REGISTER" rows participate. */
    source: string;
    /** Reconciliation link; null = not yet reconciled, so it cannot vouch for any line. */
    bankLineId: string | null;
    /** BankLineObservation.sourceLineId — for QBO_REGISTER this is the QBO transaction id, joined to Expense.qbPurchaseId. */
    sourceLineId: string;
}

export interface ReceiptMatchExpense {
    id: string;
    /** Expense.qbPurchaseId — the QBO purchase this expense mirrors; null rows can never be joined and are ignored. */
    qbPurchaseId: string | null;
    /** Expense.receiptUrl — non-empty (after trim) counts as receipt evidence. */
    receiptUrl: string | null;
}

// ── Card rail extraction ─────────────────────────────────────────────────

export type CardRail = "CJ" | "Richard" | "check" | "other";

/**
 * Maps a raw WTB descriptor to the person/rail responsible for its receipt:
 * card ref "C#8516" (with or without a space after C#) → CJ, "C#6098" →
 * Richard, a "CHECK PAID" line → check, anything else → other. Card refs
 * take precedence over "CHECK PAID" text; a descriptor somehow carrying
 * BOTH card refs identifies nobody unambiguously and maps to "other"
 * rather than guessing by pattern order.
 */
export function extractCardRail(rawDescriptor: string): CardRail {
    const s = (rawDescriptor ?? "").toUpperCase();
    const isCj = /\bC#\s*8516\b/.test(s);
    const isRichard = /\bC#\s*6098\b/.test(s);
    if (isCj && isRichard) return "other";
    if (isCj) return "CJ";
    if (isRichard) return "Richard";
    if (/\bCHECK PAID\b/.test(s)) return "check";
    return "other";
}

// ── Output shapes ────────────────────────────────────────────────────────

/** A persistable state advance: copy receiptUrl onto the BankLine and move POSTED → EVIDENCE_FOUND. Deliberately carries NO amount fields. */
export interface ReceiptMatchProposal {
    bankLineId: string;
    receiptUrl: string;
    newState: "EVIDENCE_FOUND";
}

export type ReceiptUnmatchedReason =
    /** No reconciled QBO_REGISTER observation points at this line. */
    | "no_qbo_link"
    /** A QBO link exists but no joined expense carries a non-empty receiptUrl. */
    | "qbo_link_no_receipt"
    /** The QBO link(s) resolve to MORE THAN ONE distinct receiptUrl — no single receipt can be proposed without guessing, so a human resolves it. */
    | "ambiguous_receipt_evidence";

/** One row of the daily missing-receipt list — enough for the cron to render "who owes which receipt" without re-querying. */
export interface ReceiptUnmatchedLine {
    bankLineId: string;
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    cardRail: CardRail;
    reason: ReceiptUnmatchedReason;
}

/** A line not considered at all because its state is already past POSTED (or EXCEPTION) — reported, not silently dropped, mirroring reconcileObservations' visibility rule. */
export interface ReceiptSkippedLine {
    bankLineId: string;
    state: string;
}

export interface ReceiptMatchResult {
    proposals: ReceiptMatchProposal[];
    unmatched: ReceiptUnmatchedLine[];
    skipped: ReceiptSkippedLine[];
}

// ── The matcher ──────────────────────────────────────────────────────────

/**
 * For every POSTED BankLine, follows the exact-id join chain
 * BankLine.id ← observation.bankLineId (QBO_REGISTER only) →
 * observation.sourceLineId = expense.qbPurchaseId → expense.receiptUrl:
 *
 *   - exactly ONE distinct non-empty receiptUrl reachable → proposal
 *     { bankLineId, receiptUrl, newState: "EVIDENCE_FOUND" };
 *   - no reconciled QBO observation → unmatched, reason "no_qbo_link";
 *   - observation(s) but zero non-empty receiptUrls → unmatched, reason
 *     "qbo_link_no_receipt";
 *   - more than one DISTINCT non-empty receiptUrl (duplicate expense rows,
 *     or a line that somehow accumulated two QBO observations despite the
 *     DB's partial unique index) → unmatched, reason
 *     "ambiguous_receipt_evidence" — never a guess by input order.
 *
 * Lines whose state is not "POSTED" are never proposed for advancement (the
 * state machine only moves forward under this matcher) and are returned in
 * `skipped`. Non-QBO_REGISTER observations, unreconciled observations
 * (bankLineId null), and expenses without a qbPurchaseId are ignored.
 * receiptUrls are compared and emitted trimmed; whitespace-only is the same
 * as absent.
 */
export function matchReceipts(
    bankLines: ReceiptMatchBankLine[],
    observations: ReceiptMatchObservation[],
    expenses: ReceiptMatchExpense[],
): ReceiptMatchResult {
    // Expense.qbPurchaseId → set of distinct non-empty (trimmed) receiptUrls.
    const receiptUrlsByQbPurchaseId = new Map<string, Set<string>>();
    for (const expense of expenses) {
        if (expense.qbPurchaseId === null) continue;
        const url = (expense.receiptUrl ?? "").trim();
        if (url === "") continue;
        const urls = receiptUrlsByQbPurchaseId.get(expense.qbPurchaseId);
        if (urls) urls.add(url);
        else receiptUrlsByQbPurchaseId.set(expense.qbPurchaseId, new Set([url]));
    }

    // BankLine.id → the QBO transaction ids of its reconciled observations.
    const qboTxnIdsByBankLineId = new Map<string, string[]>();
    for (const obs of observations) {
        if (obs.source !== "QBO_REGISTER") continue;
        if (obs.bankLineId === null) continue;
        const ids = qboTxnIdsByBankLineId.get(obs.bankLineId);
        if (ids) ids.push(obs.sourceLineId);
        else qboTxnIdsByBankLineId.set(obs.bankLineId, [obs.sourceLineId]);
    }

    const proposals: ReceiptMatchProposal[] = [];
    const unmatched: ReceiptUnmatchedLine[] = [];
    const skipped: ReceiptSkippedLine[] = [];

    for (const line of bankLines) {
        if (line.state !== "POSTED") {
            skipped.push({ bankLineId: line.id, state: line.state });
            continue;
        }

        const report = (reason: ReceiptUnmatchedReason) => {
            unmatched.push({
                bankLineId: line.id,
                postedDate: line.postedDate,
                amountCents: line.amountCents,
                rawDescriptor: line.rawDescriptor,
                cardRail: extractCardRail(line.rawDescriptor),
                reason,
            });
        };

        const qboTxnIds = qboTxnIdsByBankLineId.get(line.id);
        if (!qboTxnIds || qboTxnIds.length === 0) {
            report("no_qbo_link");
            continue;
        }

        const candidateUrls = new Set<string>();
        for (const qbTxnId of qboTxnIds) {
            const urls = receiptUrlsByQbPurchaseId.get(qbTxnId);
            if (urls) for (const url of urls) candidateUrls.add(url);
        }

        if (candidateUrls.size === 0) {
            report("qbo_link_no_receipt");
        } else if (candidateUrls.size === 1) {
            proposals.push({
                bankLineId: line.id,
                receiptUrl: candidateUrls.values().next().value as string,
                newState: "EVIDENCE_FOUND",
            });
        } else {
            report("ambiguous_receipt_evidence");
        }
    }

    return { proposals, unmatched, skipped };
}
