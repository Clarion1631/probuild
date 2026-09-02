/**
 * Pure routing decision for a freshly-read intake row
 * (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §4). No I/O: the caller does the
 * dedup lookups and hands the hits in, so the whole truth table is unit
 * testable (tests/receipt-intake-route-state.test.ts).
 */

export const RECEIPT_INTAKE_STATES = [
    "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING",
    "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT",
] as const;

export type ReceiptIntakeState = (typeof RECEIPT_INTAKE_STATES)[number];

export interface RouteInput {
    docType: string;
    /** cleanMoney output, e.g. "0.00" / "364.98". */
    amount: string;
    /** Integer cents for this row, used to compare against a strong-key owner. */
    totalCents: number | null;
    /** canonicalVendor() of this document — see the vendor-mismatch rule below. */
    canonicalVendor: string;
}

export interface DedupHits {
    /**
     * The row that already owns this document's strong key, if any. Discovered
     * by the partial unique index rejecting our claim — the database IS the
     * lock (pgbouncer forbids session advisory locks).
     */
    strong: { id: string; totalCents: number | null; canonicalVendor: string | null } | null;
    /** Another LIVE row carrying the same weak key. Always routes to a human. */
    weak: { id: string } | null;
}

export interface RouteDecision {
    state: ReceiptIntakeState;
    stateReason: string | null;
    duplicateOfId: string | null;
}

/**
 * First match wins. Order is the spec's, and it matters:
 *  - multi/non_receipt are triage answers about the FILE, decided before money.
 *  - a total that is zero OR NEGATIVE never books automatically. A $0.00 is
 *    almost always a misread (:531 — you don't get a $0 receipt or write a $0
 *    check); a negative total is a refund, which is a legitimate document that
 *    a human must place against the original purchase. Both are decided BEFORE
 *    any dedup key is claimed, so neither can quarantine the real receipt that
 *    arrives next.
 *  - no project means nobody can job-cost it yet; that is a queue, not a fault.
 *  - a strong hit at the SAME total is the same purchase arriving twice —
 *    UNLESS the two documents name different vendors. The v3.6 key is
 *    deliberately vendor-less (:1545–1557: one store's own formats spell its
 *    name three ways, and keying on the vendor put one purchase on two keys),
 *    and that rationale stands. But the cost of leaving the vendor out is that
 *    two UNRELATED vendors reusing an invoice number on one day for the same
 *    amount now collide, and auto-quarantining one of them would silently drop
 *    a real expense. So the vendor is not part of the KEY, but it is part of
 *    the CONFIRMATION: a mismatch downgrades to a human.
 *    A strong hit at a DIFFERENT total is ambiguous the other way (a misread
 *    total) and also goes to a human — never resolved on a guess.
 *  - a weak hit is only a POSSIBLE duplicate (two genuine same-day purchases
 *    from one vendor for the same amount do happen), so it always asks a
 *    human (:1591–1596).
 */
export function routeState(read: RouteInput, dedupHits: DedupHits, hasProject: boolean): RouteDecision {
    const docType = String(read.docType || "").toLowerCase();

    if (docType === "multi") {
        return { state: "NEEDS_REVIEW", stateReason: "multi-doc", duplicateOfId: null };
    }
    if (docType === "non_receipt") {
        return { state: "NON_RECEIPT", stateReason: null, duplicateOfId: null };
    }
    if (read.totalCents === null || read.totalCents <= 0 || read.amount === "0.00") {
        return { state: "NEEDS_REVIEW", stateReason: "refund-or-zero", duplicateOfId: null };
    }
    if (!hasProject) {
        return { state: "NEEDS_JOB", stateReason: null, duplicateOfId: null };
    }
    if (dedupHits.strong) {
        // A null owner total means a claim we cannot confirm the amount of —
        // read that as "can't confirm the totals match", never as a match.
        const sameTotal =
            dedupHits.strong.totalCents !== null &&
            read.totalCents !== null &&
            dedupHits.strong.totalCents === read.totalCents;
        if (sameTotal) {
            // An owner whose vendor we don't know is not a confirmed match
            // either — the same "can't confirm" reasoning as a null total.
            const sameVendor =
                !!dedupHits.strong.canonicalVendor &&
                !!read.canonicalVendor &&
                dedupHits.strong.canonicalVendor === read.canonicalVendor;
            if (!sameVendor) {
                return {
                    state: "NEEDS_REVIEW",
                    stateReason: `vendor-mismatch:${dedupHits.strong.id}`,
                    duplicateOfId: dedupHits.strong.id,
                };
            }
            return { state: "DUPLICATE", stateReason: null, duplicateOfId: dedupHits.strong.id };
        }
        return {
            state: "NEEDS_REVIEW",
            stateReason: `strong-dup-amount-mismatch:${dedupHits.strong.id}`,
            duplicateOfId: dedupHits.strong.id,
        };
    }
    if (dedupHits.weak) {
        return {
            state: "NEEDS_REVIEW",
            stateReason: `weak-dup:${dedupHits.weak.id}`,
            duplicateOfId: null,
        };
    }
    return { state: "READ", stateReason: null, duplicateOfId: null };
}

/**
 * Retry backoff for the booking step: attempts 1 gives 5m, 2 gives 15m,
 * 3 gives 1h, 4+ gives 6h. Exported here (rather than in book.ts) so the
 * schedule is testable without pulling QuickBooks into the test process.
 */
export const MAX_BOOK_ATTEMPTS = 20;

export function backoffMs(attempts: number): number {
    if (attempts <= 1) return 5 * 60_000;
    if (attempts === 2) return 15 * 60_000;
    if (attempts === 3) return 60 * 60_000;
    return 6 * 60 * 60_000;
}
