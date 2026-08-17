import type { ReceiptJourney } from "@/lib/automation-events";

/**
 * Find the receipt-provenance journey (intake → read → dedupe → push →
 * synced) behind one register row, for the row drill-down's timeline block
 * (Unified Money Register plan §3/§5 step 9).
 *
 * `receiptJourneys()` (automation-events.ts) groups events by the receipt's
 * own identity, independent of any particular register row — this is the
 * glue that answers "which journey, if any, is THIS row's receipt". Kept
 * pure and separate from `register-merge.ts` (which computes the row's
 * receipt/job-cost/amount edges) so neither module has to know about the
 * other's data shape; this only reads their already-computed outputs.
 *
 * Two match paths, in order:
 * 1. `journey.qbPurchaseId === row.qbTxnId` — the same typed-column
 *    correlation `register-merge.ts`'s `computeReceiptEdge` uses for a
 *    "pass". Confirmed unless the journey itself was only ever grouped via
 *    the docNumber-prefix fallback (`keyConfirmed: false` — see that
 *    field's doc comment on `ReceiptJourney`).
 * 2. Falls back to `journey.docNumber === row.docNum` — QuickBooks's
 *    DocNumber field on the posted Purchase is set to the receipt's Drive
 *    fileId's 21-char prefix at booking time, so this is the same
 *    collision-prone correlation `qbo-receipt-push.ts:477` documents: two
 *    different Drive files can share a prefix, and the bare docNumber
 *    string is deliberately kept in ONE bucket per string by
 *    `receiptJourneys()`, so a hit here can never be presented as
 *    confirmed — regardless of that journey's own `keyConfirmed` value,
 *    because the ambiguity here is in THIS match step (a different receipt
 *    could legitimately own the same docNumber), not just in how that one
 *    journey was internally grouped.
 */
export interface ReceiptJourneyMatch {
    journey: ReceiptJourney;
    /** True when this match is only a "possible prefix collision" — never
     * present the journey as confirmed provenance for this row when true. */
    unconfirmed: boolean;
}

/** Pre-indexed journeys, keyed the way `receiptJourneysForKeys`
 * (automation-events.ts) builds them — O(1) lookups instead of a `.find()`
 * scan of every journey per register row (N2: that scan ran R × J times on
 * the page that carries the money register). */
export interface ReceiptJourneyIndex {
    byQbPurchaseId: Map<string, ReceiptJourney>;
    byDocNumber: Map<string, ReceiptJourney>;
    /** True when `receiptJourneysForKeys`'s underlying event query hit its
     * hard cap — this index may be missing journeys/events for some of the
     * keys it was asked about. The caller (page.tsx) surfaces this as the
     * same degraded-data warning style used elsewhere on the page, rather
     * than letting a drill-down look complete when it might not be. */
    truncated: boolean;
}

export function matchReceiptJourney(
    row: { qbTxnId: string | null; docNum: string | null },
    journeys: ReceiptJourneyIndex,
): ReceiptJourneyMatch | null {
    if (row.qbTxnId) {
        const direct = journeys.byQbPurchaseId.get(row.qbTxnId);
        if (direct) return { journey: direct, unconfirmed: !direct.keyConfirmed };
    }
    if (row.docNum) {
        const byPrefix = journeys.byDocNumber.get(row.docNum);
        if (byPrefix) return { journey: byPrefix, unconfirmed: true };
    }
    return null;
}
