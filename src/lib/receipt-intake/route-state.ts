/**
 * Pure routing decision for a freshly-read intake row
 * (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §4). No I/O: the caller does the
 * dedup lookups and hands the hits in, so the whole truth table is unit
 * testable (tests/receipt-intake-route-state.test.ts).
 */

export const RECEIPT_INTAKE_STATES = [
    // STAGING: the row exists but its file does not yet. Never claimable.
    "STAGING",
    "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING",
    "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT",
    /**
     * Terminal. The row arrived while RECEIPT_INTAKE_DRYRUN was on, so v1 (the
     * Apps Script) booked it and v2 never will. See the cutover sequence in
     * docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §7.
     */
    "SHADOW_DONE",
    /**
     * Terminal, and it needs a person.
     *
     * Pre-boundary, no evidence v1 booked it, and NOT a Drive row — so there is
     * no shared identity that would make a v2 booking idempotent against a
     * Purchase v1 may or may not have created. Booking it risks a duplicate;
     * retiring it risks losing a real expense. Neither is ours to guess, so it
     * surfaces on the Receipts tab with a "book anyway" action for whoever has
     * checked QuickBooks. NEVER auto-requeued.
     */
    "SHADOW_QUARANTINE",
] as const;

export type ReceiptIntakeState = (typeof RECEIPT_INTAKE_STATES)[number];

/** Mirrors DOC_TYPES in read.ts — the closed set STEP 1 of the prompt may return. */
const KNOWN_DOC_TYPES = new Set(["receipt", "check", "multi", "non_receipt"]);

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
    // Fail CLOSED on the classifier. A missing or unrecognised doc_type means
    // we do not know whether this is a purchase at all — a truncated response, a
    // schema change, or a prompt-injected document that suppressed the field
    // while supplying plausible amounts. Booking on that is unacceptable; a
    // human looks instead.
    if (!KNOWN_DOC_TYPES.has(docType)) {
        return { state: "NEEDS_REVIEW", stateReason: "unknown-doc-type", duplicateOfId: null };
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
 * The one dropped-tax-reading marker the reader appends to `stateReason` (see
 * worker.ts's `note()`), separate from every other value that column carries
 * (park reasons, weak-dup pointers, defer reasons). It must survive
 * transitions that otherwise clear or overwrite `stateReason` on the way to
 * BOOKED — an automatically booked receipt with a bad tax read must stay
 * distinguishable from one with no tax read at all.
 */
export const TAX_IMPLAUSIBLE_REASON = "tax-implausible";

/**
 * THE WARNING HAS ITS OWN COLUMN, because `stateReason` is not durable.
 *
 * Routing wrote the marker into `stateReason`, and everything downstream
 * then overwrote that column for its own reasons: a deferred booking
 * replaces it with "push-disabled" or "push-paused", a park with a park
 * reason. The BOOKED transition read the marker out of whatever the column
 * happened to hold at that moment, so any row that took the deferred path --
 * which is EVERY row during the disabled-push cutover -- reached BOOKED with
 * the evidence already erased. An automatically booked receipt with a bad tax
 * read became indistinguishable from one with a clean read.
 *
 * `taxWarning` is written once, by routing, and nothing else touches it.
 *
 * `stateReason` is still consulted as a FALLBACK, for rows that were already
 * mid-flight when the column was added: one sitting in BOOKING carrying the
 * marker in the old place must not lose it at deploy time.
 */
export function preservedTaxWarning(row: {
    taxWarning?: string | null;
    stateReason?: string | null;
}): string | null {
    if (row.taxWarning === TAX_IMPLAUSIBLE_REASON) return TAX_IMPLAUSIBLE_REASON;
    return (row.stateReason ?? "").split(";").includes(TAX_IMPLAUSIBLE_REASON)
        ? TAX_IMPLAUSIBLE_REASON
        : null;
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
