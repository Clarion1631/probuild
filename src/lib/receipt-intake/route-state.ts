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
 * Pull the tax-implausible marker back out of a `stateReason`, discarding
 * anything else it may currently hold (a defer reason like "push-paused" must
 * NOT ride along into BOOKED — only this one warning is meant to survive).
 */
export function preservedTaxWarning(stateReason: string | null | undefined): string | null {
    return (stateReason ?? "").split(";").includes(TAX_IMPLAUSIBLE_REASON) ? TAX_IMPLAUSIBLE_REASON : null;
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

/**
 * Which parked rows the Receipts tab's "Retry now" may resend, and where each
 * goes back to. PURE, so the rule is one testable statement rather than a
 * condition duplicated between the button and the action.
 *
 * The list is deliberately CLOSED. Most NEEDS_REVIEW reasons are verdicts about
 * the DOCUMENT — `multi-doc`, `no-estimate`, `weak-dup:<id>`,
 * `strong-dup-amount-mismatch:<id>`, `refund-or-zero` — and retrying one of
 * those just parks it again with the same reason while spending an attempt and
 * a QuickBooks round trip. Only reasons that describe a TRANSIENT FAILURE of
 * something other than the document are retryable.
 *
 * Where a row resumes matters as much as whether it may:
 *   - `ai-unavailable` and `file-missing` failed BEFORE the read, so they go
 *     back to RECEIVED and get read again. Sending them to BOOKING would book a
 *     row whose vendor/total were never extracted.
 *   - `qbo-timeout` / `qbo-5xx` / `max-retries` failed at the SEND, with the
 *     read already done, so they resume at BOOKING.
 */
export type RetryTarget = "RECEIVED" | "BOOKING";

const RETRYABLE_REASONS: Array<{ test: RegExp; target: RetryTarget }> = [
    // Gemini was down. The document was never read, so re-read it.
    { test: /^ai-unavailable$/, target: "RECEIVED" },
    // The upload never landed in the bucket; a human has since re-uploaded it.
    { test: /^file-missing$/, target: "RECEIVED" },
    // Transport-class QuickBooks failures, and the row that exhausted its
    // budget of them. The read is done; resume at the send.
    { test: /^qbo-timeout$/, target: "BOOKING" },
    { test: /^qbo-5xx$/, target: "BOOKING" },
    { test: /^qbo-fault:(?:429|5\d\d|timeout)$/i, target: "BOOKING" },
    { test: /^max-retries$/, target: "BOOKING" },
];

/**
 * Where a manual retry should send this row, or null when it may not be
 * retried at all. A BOOKING row is always retryable — it is mid-flight, not
 * parked on a verdict.
 */
export function retryTargetFor(state: string, stateReason: string | null): RetryTarget | null {
    if (state === "BOOKING") return "BOOKING";
    if (state !== "NEEDS_REVIEW") return null;
    const reason = (stateReason ?? "").trim();
    if (!reason) return null;
    return RETRYABLE_REASONS.find(rule => rule.test.test(reason))?.target ?? null;
}

// ── Whether a parked row still PROVES a receipt exists ──────────────────────

/**
 * Park reasons that mean THE DOCUMENT ITSELF could not be verified.
 *
 * Named here rather than spelled out at each site so the writer (book.ts, which
 * parks the row) and the reader (the missing-receipt chaser, which counts
 * intakes as evidence) cannot drift apart. If they drift the failure is silent
 * and one-directional: the chaser closes a chase on the strength of a receipt
 * whose bytes are GONE, and nobody is ever asked for it again.
 *
 * Everything else book.ts parks — `no-estimate`, `refund-or-zero`,
 * `invalid-date`, a QBO fault — is about the row's METADATA. The document is
 * still in the bucket, still verified, and still proves the purchase has a
 * receipt; it just cannot be booked yet. Those rows remain evidence.
 */
export const NO_ARTIFACT_PARK_REASONS = {
    /** An affirmative 404 from storage: the object is not there. */
    bytesMissing: "receipt-bytes-missing",
    /** The bytes no longer hash to what was verified at intake. */
    contentChanged: "content-changed",
} as const;

export const NO_ARTIFACT_STATE_REASONS: ReadonlySet<string> = new Set(Object.values(NO_ARTIFACT_PARK_REASONS));

/**
 * True when this row still stands behind a durable, verified receipt document.
 *
 * The chaser may only treat an intake as evidence when this holds: "a row
 * exists" is not the same claim as "a receipt exists", and the two states above
 * are exactly the cases where the row outlived its document.
 */
export function intakeArtifactIsVerified(stateReason: string | null | undefined): boolean {
    return !(typeof stateReason === "string" && NO_ARTIFACT_STATE_REASONS.has(stateReason));
}
