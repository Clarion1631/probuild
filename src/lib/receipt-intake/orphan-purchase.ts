/**
 * Resolving an ORPHANED QuickBooks Purchase — the one thing in this pipeline
 * that a human genuinely has to go and look at.
 *
 * There are two shapes of orphan, and until now only the first was resolvable:
 *
 *   KNOWN ID — the send returned a Purchase id and THEN the row was voided.
 *     `postVoidQbPurchaseId` holds it, the queue links straight to it, and
 *     "mark resolved" records that somebody voided it in QuickBooks.
 *   UNKNOWN ID — the send went out and we never got an answer (a timeout, a
 *     5xx). `sendAttempted` is true, the row keeps its strong dedup key, and
 *     NOBODY KNOWS whether a Purchase exists. That row was a dead end: the key
 *     stayed held forever, so a corrected re-send of the same receipt bounced
 *     as a duplicate with nothing on screen explaining why.
 *
 * The second one has exactly two honest answers, and this module is the rules
 * for both. Neither is guessable by the system — QBO is read-only from here and
 * a Purchase created by a request whose response we lost carries no marker we
 * can search on reliably — so both are AUDITED: who said so, and why.
 *
 * PURE. The verification I/O is injected, so the amount rule is testable
 * without QuickBooks.
 */

/** What QBO returned for a purchase id, reduced to what the decision needs. */
export interface QboPurchaseFacts {
    id: string;
    /** POSITIVE cents. A Purchase's TotalAmt is a magnitude. */
    totalCents: number | null;
    /**
     * The Purchase's PrivateNote. Every Purchase this pipeline creates carries
     * `[gtr-file:<fileId>]` there (qbo-receipt-push.ts) — it is the only thing
     * that ties a Purchase back to the exact document that produced it.
     */
    privateNote: string | null;
}

/** `[gtr-file:<fileId>]` — the marker qbo-receipt-push writes into PrivateNote. */
export function gtrFileMarker(fileId: string): string {
    return `[gtr-file:${fileId}]`;
}

/** The fileId a Purchase's PrivateNote claims, or null when it carries no marker. */
export function markedFileId(privateNote: string | null): string | null {
    const match = /\[gtr-file:([^\]]+)\]/.exec(privateNote ?? "");
    return match ? match[1] : null;
}

export type OrphanClaimVerdict =
    | { ok: true; purchaseId: string }
    | {
        ok: false;
        reason: "not-found" | "amount-mismatch" | "marker-missing" | "marker-mismatch" | "unreadable" | "invalid-id";
        detail?: string;
    };

/** QBO ids are digits in this realm; anything else is a paste error, not a lookup. */
export function isQboPurchaseId(value: unknown): value is string {
    return typeof value === "string" && /^\d{1,20}$/.test(value.trim());
}

/**
 * Decide whether a manually located Purchase really is this receipt's.
 *
 * THE AMOUNT MUST MATCH, EXACTLY. The operator is reading a list in the
 * QuickBooks UI and typing an id into a different window; a transposed digit
 * lands on somebody else's purchase, and recording it would attach this
 * receipt's history to that one and free a dedup key it has no business
 * freeing. Cents, not dollars, and no tolerance: two purchases that differ by a
 * cent are two purchases.
 */
export function verifyOrphanClaim(
    facts: QboPurchaseFacts | null,
    expectedTotalCents: number | null,
    expectedFileId: string | null,
): OrphanClaimVerdict {
    if (facts === null) return { ok: false, reason: "not-found" };
    if (facts.totalCents === null) {
        return { ok: false, reason: "unreadable", detail: "QuickBooks returned no amount for that purchase" };
    }
    if (expectedTotalCents === null) {
        // We do not know what this receipt was for, so we cannot check the one
        // thing that makes the claim safe. Refuse rather than accept on trust.
        return { ok: false, reason: "unreadable", detail: "This receipt has no amount to check against" };
    }
    if (facts.totalCents !== expectedTotalCents) {
        return {
            ok: false,
            reason: "amount-mismatch",
            detail: `That purchase is ${(facts.totalCents / 100).toFixed(2)}; this receipt is ${(expectedTotalCents / 100).toFixed(2)}`,
        };
    }

    // THE MARKER, and this is the check that actually identifies the document.
    //
    // An amount match is weak on its own: this business posts several purchases
    // for the same amount to the same vendor in a week, and the operator is
    // typing an id read off a different screen. Every Purchase this pipeline
    // creates carries `[gtr-file:<fileId>]` in its PrivateNote, so a Purchase
    // that is genuinely THIS receipt's says so in its own note. One that says
    // nothing was not created by us; one that names a different file belongs to
    // a different receipt, and recording it would attach this receipt's history
    // to that one and mis-report both.
    if (!expectedFileId) {
        return { ok: false, reason: "unreadable", detail: "This receipt has no file identity to check against" };
    }
    const marked = markedFileId(facts.privateNote);
    if (marked === null) {
        return {
            ok: false,
            reason: "marker-missing",
            detail: "That purchase carries no ProBuild file marker, so it was not created for this receipt",
        };
    }
    if (marked !== expectedFileId) {
        return {
            ok: false,
            reason: "marker-mismatch",
            detail: "That purchase belongs to a different receipt (its file marker names another document)",
        };
    }
    return { ok: true, purchaseId: facts.id };
}

/** Audit kinds, so a human can find both decisions later. */
export const ORPHAN_AUDIT_KIND = "receipt-orphan-resolution";
export const ORPHAN_RESOLUTIONS = {
    /** An operator located the Purchase in QBO and we verified its amount. */
    located: "purchase-located",
    /** An operator checked and there is no Purchase. The dedup key is freed. */
    noPurchase: "no-purchase-exists",
} as const;
