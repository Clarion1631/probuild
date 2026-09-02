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

/**
 * The pay-link fetch failed AFTER the invoice was linked, transiently.
 *
 * The invoice itself is correct and collectible; only the convenience link is
 * missing. `sweepPendingPayLinks` (src/lib/quickbooks-payments.ts, run by
 * POST /api/integrations/qbo-maintenance {"action":"sync-payment-options"})
 * is what finishes these — this marker is a work queue, not an error.
 */
export const PAYLINK_PENDING_MARKER = "paylink-pending";

/**
 * The two markers that mean "an invoice may exist in QuickBooks for this row
 * even though qbInvoiceId is null". Both appear as a bare marker (legacy rows)
 * or with a recovery identity appended (see composeCreateMarker), so a Prisma
 * `where` must match them by PREFIX -- `pendingCreateMarkerWhere()` builds it.
 */
export const PENDING_CREATE_MARKERS: readonly string[] = [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER];

/**
 * The identity a recovery needs to find the invoice a create may have made.
 *
 * It is captured in the MARKER, written before the POST, because both halves
 * are derived from mutable state: `docNumber` is the milestone's POSITION in
 * its invoice's schedule (delete an earlier milestone and every later one
 * renumbers), and `privateNote` embeds the project name and the milestone name
 * (rename either and it no longer matches). Recomputing at recovery time would
 * query QuickBooks for a document we never created, find nothing, and offer to
 * clear a row whose real invoice is sitting there collectible.
 */
export interface CreateIdentity {
    /** The QuickBooks DocNumber the create used. */
    docNumber: string;
    /** The exact PrivateNote the create wrote -- what proves an invoice is ours. */
    privateNote: string;
}

/** Separates the marker kind from its identity payload. */
const MARKER_KIND_SEP = ":";
/** Separates docNumber from privateNote. First occurrence wins -- a note may contain more. */
const MARKER_FIELD_SEP = "|";

/**
 * `create-in-flight:INV-00171-2|ProBuild INV-00171 - Rough-in - Mesplay`
 *
 * The identity rides in the qbSyncError column because this PR ships no schema
 * change and there is nowhere else durable to put it that is written in the
 * SAME CAS as the claim. It has to be one write: a marker without its identity
 * is a row we can block but never resolve.
 */
export function composeCreateMarker(
    kind: typeof CREATE_IN_FLIGHT_MARKER | typeof AMBIGUOUS_CREATE_MARKER,
    identity: CreateIdentity,
): string {
    // A docNumber containing the field separator would make the split
    // ambiguous. QuickBooks DocNumbers are ours to generate and never contain
    // one, so this is an invariant, not input validation.
    if (identity.docNumber.includes(MARKER_FIELD_SEP)) {
        throw new Error(`DocNumber must not contain "${MARKER_FIELD_SEP}": ${identity.docNumber}`);
    }
    return `${kind}${MARKER_KIND_SEP}${identity.docNumber}${MARKER_FIELD_SEP}${identity.privateNote}`;
}

/** Which pending-create marker is this, identity or not? `null` when it is neither. */
export function markerKind(qbSyncError: string | null | undefined): string | null {
    if (!qbSyncError) return null;
    for (const kind of PENDING_CREATE_MARKERS) {
        if (qbSyncError === kind || qbSyncError.startsWith(kind + MARKER_KIND_SEP)) return kind;
    }
    return null;
}

/**
 * The identity carried by a marker, or `null` for the legacy bare shape.
 *
 * `null` is NOT "no identity needed" -- it means we cannot know what to look
 * for, and the caller must refuse rather than guess (see the identity-unknown
 * refusal in qbo-ambiguous-create.ts).
 */
export function parseCreateMarker(
    qbSyncError: string | null | undefined,
): { kind: string; identity: CreateIdentity | null } | null {
    const kind = markerKind(qbSyncError);
    if (!kind) return null;
    const marker = qbSyncError as string;
    if (marker === kind) return { kind, identity: null };
    const payload = marker.slice(kind.length + MARKER_KIND_SEP.length);
    const sep = payload.indexOf(MARKER_FIELD_SEP);
    // A payload with no separator, an empty docNumber or an empty note is a
    // corrupt marker. Same handling as the legacy shape: refuse, don't guess.
    if (sep <= 0) return { kind, identity: null };
    const docNumber = payload.slice(0, sep);
    const privateNote = payload.slice(sep + MARKER_FIELD_SEP.length);
    if (!docNumber || !privateNote) return { kind, identity: null };
    return { kind, identity: { docNumber, privateNote } };
}

/**
 * Prisma `where` fragments matching any pending-create marker, identity or not.
 * Returns an array for use inside an `OR`.
 */
export function pendingCreateMarkerWhere(): Array<{ qbSyncError: string | { startsWith: string } }> {
    return PENDING_CREATE_MARKERS.flatMap((kind) => [
        { qbSyncError: kind },
        { qbSyncError: { startsWith: kind + MARKER_KIND_SEP } },
    ]);
}

/** Is this row blocked from sending because a previous attempt's outcome is unknown? */
export function isBlockedByAmbiguousCreate(
    row: { qbSyncError: string | null; updatedAt?: Date | null },
    now: number = Date.now(),
): boolean {
    // Both a fresh and a stale in-flight marker refuse the send: fresh means a
    // peer is mid-flight, stale means nobody is coming back and the outcome is
    // unknown. The age only decides what the operator is told.
    void now;
    return markerKind(row.qbSyncError) !== null;
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
    if (markerKind(row.qbSyncError) !== CREATE_IN_FLIGHT_MARKER) return false;
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
/**
 * The row is parked, but its marker does not say WHAT to look for -- a legacy
 * bare marker written before the identity was carried, or a corrupt one.
 *
 * Deliberately terminal for the automated path: the recovery cannot query
 * QuickBooks for the right document, so it must not be allowed to conclude
 * "there is none" and release the row. A human resolves these in QuickBooks
 * directly.
 */
export class QBIdentityUnknownError extends Error {
    name = "QBIdentityUnknownError";
    constructor(subject: string) {
        super(
            `"${subject}" is parked from an older release that did not record which QuickBooks document to look for. ` +
            `It cannot be resolved automatically -- find the invoice in QuickBooks by hand before doing anything else with this row.`,
        );
    }
}

export class QBResolveRequiredError extends Error {
    name = "QBResolveRequiredError";
    constructor(subject: string) {
        super(
            `"${subject}" may already have a QuickBooks invoice — a previous send ended without a confirmed result. ` +
            `Resolve it against QuickBooks first; changing or removing it now could abandon a live invoice.`,
        );
    }
}
