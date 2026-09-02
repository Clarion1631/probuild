/**
 * The `qbSyncError` vocabulary for QuickBooks invoice creates, and the rules
 * that read it.
 *
 * Pure — no Prisma, no fetch, no session — for two reasons. It is the ONE
 * definition of "this row may already have an invoice in QuickBooks", which
 * money guards across billing-core, progress-billing and actions all have to
 * agree on; and a client component can import it without dragging the database
 * into the browser bundle.
 *
 * `quickbooks-payments.ts` re-exports everything here, so existing imports are
 * unchanged.
 */

/**
 * Parked on a row whose QuickBooks invoice create ended with an UNKNOWN outcome
 * — a timeout, or a transport failure after the request went out.
 *
 * The request may well have created a real, collectible invoice. Re-sending
 * blindly would bill the client twice, so the row is marked and every send path
 * refuses until a human has looked in QuickBooks (see qbo-ambiguous-create.ts).
 */
export const AMBIGUOUS_CREATE_MARKER = "ambiguous-create";

/**
 * Set on the row BEFORE the create POST goes out, and replaced by the link
 * write on success.
 *
 * A process killed between the POST and the link write left no trace at all:
 * the next send saw a clean row and created a second invoice. The marker is
 * written first precisely so a crash is still visible afterwards.
 */
export const CREATE_IN_FLIGHT_MARKER = "create-in-flight";

/**
 * Left over from a send that never came back. Beyond this age we stop assuming
 * a peer is still working and treat it as an unknown outcome — the same
 * fail-closed handling as an observed timeout.
 */
export const CREATE_IN_FLIGHT_STALE_MS = 5 * 60_000;

/** Pay-link fetch failed AFTER the invoice was linked; the sweep retries it. */
export const PAYLINK_PENDING_MARKER = "paylink-pending";

/**
 * The two markers that mean "an invoice may exist in QuickBooks for this row
 * even though qbInvoiceId is null". Exported as an array so a Prisma `where`
 * can filter on the same list the predicates use.
 */
export const PENDING_CREATE_MARKERS: readonly string[] = [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER];

/** Is this row blocked from sending because a previous attempt's outcome is unknown? */
export function isBlockedByAmbiguousCreate(
    row: { qbSyncError: string | null; updatedAt?: Date | null },
    now: number = Date.now(),
): boolean {
    if (row.qbSyncError === AMBIGUOUS_CREATE_MARKER) return true;
    if (row.qbSyncError !== CREATE_IN_FLIGHT_MARKER) return false;
    // Both a fresh and a stale in-flight marker refuse the send: fresh means a
    // peer is mid-flight, stale means nobody is coming back and the outcome is
    // unknown. The age only decides what the operator is told.
    void now;
    return true;
}

/**
 * A send that never came back — treated exactly like an observed timeout.
 *
 * NOTE: neither PaymentSchedule nor ProgressBilling carries an `updatedAt`
 * column today, so a caller passing a real row supplies no timestamp and every
 * in-flight marker reads as stale. That is the fail-closed direction (it only
 * ever says "unknown outcome", never "a peer is still working"), and it only
 * affects what the operator is TOLD — `isBlockedByAmbiguousCreate` refuses
 * either way.
 */
export function isStaleInFlight(
    row: { qbSyncError: string | null; updatedAt?: Date | null },
    now: number = Date.now(),
): boolean {
    if (row.qbSyncError !== CREATE_IN_FLIGHT_MARKER) return false;
    const at = row.updatedAt ? row.updatedAt.getTime() : 0;
    return now - at > CREATE_IN_FLIGHT_STALE_MS;
}

/**
 * The predicate EVERY money guard must use instead of a bare `qbInvoiceId`
 * check.
 *
 * A parked row has `qbInvoiceId === null` and may still have a real,
 * collectible invoice in QuickBooks. Guards that only looked at the id happily
 * let such a row be repriced, deleted, re-split or swept into a progress
 * billing — each of which abandons or contradicts an invoice the client can
 * still pay.
 */
export function isQboInvoiceLinkedOrPending(row: { qbInvoiceId: string | null; qbSyncError: string | null }): boolean {
    return !!row.qbInvoiceId || isBlockedByAmbiguousCreate(row);
}

/**
 * The row state an operator was shown, used as the optimistic-concurrency token
 * on the resolve action.
 *
 * NEITHER table carries `updatedAt` and this PR ships no schema change, so the
 * token is the pair of fields the decision actually depends on. A row someone
 * else already resolved no longer matches; the resolve write's CAS pins the
 * same two fields again, so a race that slips past the check still cannot
 * write.
 */
export function ambiguousCreateFingerprint(row: { qbSyncError: string | null; qbInvoiceId: string | null }): string {
    return `${row.qbSyncError ?? ""}|${row.qbInvoiceId ?? ""}`;
}

/**
 * Refusal raised when a money mutation is blocked until a human has resolved an
 * ambiguous QuickBooks create. Typed so a caller can offer the resolver instead
 * of string-matching a message.
 */
export class QBResolveRequiredError extends Error {
    name = "QBResolveRequiredError";
    constructor(subject: string) {
        super(
            `"${subject}" may already have a QuickBooks invoice — a previous send ended without a confirmed result. ` +
            `Resolve it against QuickBooks first; changing or removing it now could abandon a live invoice.`,
        );
    }
}
