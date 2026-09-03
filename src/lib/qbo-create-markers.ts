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
 * The pay-link fetch has now failed enough times that nobody should keep
 * waiting for it.
 *
 * `paylink-pending` used to be cleared whether or not a link came back: a null
 * answer wrote `qbSyncError: null` and counted the row as "noLink", so an
 * invoice with NO payable URL left the repair queue and health went green. The
 * client had a bill they could not pay and nothing said so anywhere.
 *
 * The marker is now only cleared when a non-empty link was actually persisted.
 * A null answer keeps it and increments an attempt counter; past
 * PAYLINK_MAX_ATTEMPTS it becomes THIS, which is durable, counted by
 * pipeline-health as a standing queue and named in the digest. It is a real
 * state, not the absence of one.
 */
export const PAYLINK_MISSING_MARKER = "paylink-missing";

/**
 * How many times the sweep asks QuickBooks for a link before calling it missing.
 *
 * The sweep runs hourly, so this is roughly five hours of a transient failure
 * before a human is told — long enough to ride out an Intuit blip, short enough
 * that a client is not sitting on an unpayable invoice for a day.
 */
export const PAYLINK_MAX_ATTEMPTS = 5;

/**
 * How long an operator note may be. Long enough for a real explanation, short
 * enough that it can never be the reason an audit row loses its other fields.
 *
 * Lives in this module because BOTH ends need it: the server action that
 * refuses an over-long note, and the client form that collects it. This is the
 * one module the invoice editor can import.
 */
export const RESOLVE_REASON_MAX_LEN = 500;

/** Bare `paylink-pending`, or `paylink-pending:<attempts>`. */
export function isPayLinkPending(marker: string | null | undefined): boolean {
    if (!marker) return false;
    return marker === PAYLINK_PENDING_MARKER
        || marker.startsWith(PAYLINK_PENDING_MARKER + MARKER_KIND_SEP);
}

/** How many fetches have already come back empty. A bare marker means none. */
export function payLinkAttempts(marker: string | null | undefined): number {
    if (!isPayLinkPending(marker)) return 0;
    const at = (marker as string).indexOf(MARKER_KIND_SEP);
    if (at === -1) return 0;
    const n = Number.parseInt((marker as string).slice(at + 1), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Every shape a still-waiting row can carry, for a Prisma `OR`. */
export function payLinkPendingWhere(): Array<{ qbSyncError: string | { startsWith: string } }> {
    return [
        { qbSyncError: PAYLINK_PENDING_MARKER },
        { qbSyncError: { startsWith: PAYLINK_PENDING_MARKER + MARKER_KIND_SEP } },
    ];
}

/**
 * THE decision both pay-link writers make. One helper, so the sweep and the
 * progress-billing stage path cannot disagree about what a null link means.
 *
 * `link` is only present when there is something worth persisting; the caller
 * must never write an empty string over a real URL.
 */
export function nextPayLinkState(
    currentMarker: string | null | undefined,
    payLink: string | null | undefined,
): { marker: string | null; link?: string; exhausted: boolean } {
    const link = (payLink ?? "").trim();
    if (link) return { marker: null, link, exhausted: false };
    const attempts = payLinkAttempts(currentMarker) + 1;
    if (attempts >= PAYLINK_MAX_ATTEMPTS) {
        return { marker: PAYLINK_MISSING_MARKER, exhausted: true };
    }
    return { marker: `${PAYLINK_PENDING_MARKER}${MARKER_KIND_SEP}${attempts}`, exhausted: false };
}

/**
 * The two markers that mean "an invoice may exist in QuickBooks for this row
 * even though qbInvoiceId is null". Both appear as a bare marker (legacy rows)
 * or with a recovery identity appended (see composeCreateMarker), so a Prisma
 * `where` must match them by PREFIX -- `pendingCreateMarkerWhere()` builds it.
 */
export const PENDING_CREATE_MARKERS: readonly string[] = [CREATE_IN_FLIGHT_MARKER, AMBIGUOUS_CREATE_MARKER];

/**
 * A human asked for this row's QuickBooks invoice to be DELETED, and the
 * delete has not been confirmed yet.
 *
 * Break-QB-Link used to clear the local link first and then attempt the remote
 * delete on an unbounded clock. That order is backwards: the moment the link
 * is gone the milestone is freely re-sendable, so a re-send racing a delete
 * that had not landed yet (or had been killed by the platform ceiling) could
 * leave the client with TWO collectible invoices. The link now survives until
 * the delete is confirmed, and this marker is what records the intent in the
 * meantime.
 *
 * SETTLEMENT DOES NOT CANCEL THE INTENT — it RECORDS ITSELF ALONGSIDE IT.
 *
 * The first cut had the settle paths clear this marker, on the reasoning that
 * money beats cleanup. That opened a worse hole than it closed. Break-QB-Link
 * writes the marker, performs the IRREVERSIBLE remote delete, and only then
 * unlinks; a settle landing in that window cleared the marker and set Paid, so
 * the post-delete unlink CAS lost on BOTH counts and the row was left Paid,
 * still linked to an invoice that no longer exists, carrying no marker at all —
 * invisible to the sweep that exists to find exactly that.
 *
 * So a settle leaves the intent in place and promotes it to
 * PENDING_DELETION_SETTLED_MARKER in the same transaction. The row stays
 * selectable by `sweepPendingDeletions`, whose Paid branch probes rather than
 * deletes and reaches a terminal state either way. Break-QB-Link, when its
 * post-delete unlink loses, writes PAID_PENDING_DELETION_FLAG itself rather
 * than walking away, so the outcome does not depend on the sweep getting there.
 *
 * Neither marker ever blocks the settle: both are written by a SEPARATE
 * statement inside the settle transaction, never as a clause on the settle
 * claim, so recording real money is never conditional on a cleanup flag.
 *
 * Deliberately NOT one of PENDING_CREATE_MARKERS. Those mean "an invoice may
 * exist even though qbInvoiceId is null"; this row still HAS its qbInvoiceId,
 * and that is what stops a second create. Listing it there would also offer it
 * to the ambiguous-create resolver, which would helpfully adopt the very
 * invoice somebody is trying to remove.
 */
export const PENDING_DELETION_MARKER = "pending-deletion";

/**
 * The row was SETTLED while a deletion was pending.
 *
 * Still a deletion intent (`isPendingDeletion` matches it, and the sweep
 * selects it), but one that can no longer be finished the ordinary way: the
 * unlink refuses a Paid row, and a paid QuickBooks invoice must never be
 * deleted. It exists so the sweep can tell 'nobody has settled this' from
 * 'somebody did, mid-delete', and so the row is never left unmarked.
 */
export const PENDING_DELETION_SETTLED_MARKER = "pending-deletion:settled";

/**
 * A deletion the sweep has CLAIMED and is about to perform remotely.
 *
 * The prefix of `pending-deletion:claimed:<token>`. Round 49: the sweep read a
 * row's `status` once, at page time, and then decided whether to delete from
 * that stale snapshot. A settlement committing in between — a manual Record
 * Payment, a Stripe webhook — left the sweep deleting the QuickBooks invoice
 * for a milestone that had just been PAID, and the post-delete unlink then lost
 * its compare-and-set and left a paid row pointing at a destroyed invoice.
 *
 * The claim is what makes the decision and the deletion one atomic story: it is
 * taken under the same money locks a settle takes, pinned to `status: Pending`
 * and to the marker the row was observed carrying, so a settle that got there
 * first makes the claim fail and no remote call happens at all. A settle that
 * arrives AFTER the claim cancels it (promoting to the settled marker), and the
 * sweep re-checks the claim immediately before the irreversible call.
 */
export const PENDING_DELETION_CLAIMED_PREFIX = "pending-deletion:claimed:";

/**
 * A COMPENSATION the create path has claimed and is about to perform.
 *
 * The prefix of `compensating:<token>`. Round 50: `compensateAndUnlink` did
 * the irreversible QuickBooks delete FIRST and then cleared the row pinned
 * only to `{ id, qbInvoiceId }`. A settlement landing after the finalize
 * released its locks but before that clear meant the invoice of a milestone
 * that had just been PAID was deleted, and the paid row was cleared anyway
 * — a progress billing was additionally reset to Draft.
 *
 * Same shape as the deletion sweep's claim: taken under the canonical money
 * locks, pinned to the full state the decision was made from, re-checked
 * immediately before the remote call, and cancelled by a settle.
 */
export const COMPENSATION_CLAIMED_PREFIX = "compensating:";

/** Is this row claimed by a compensation right now? */
export function isCompensationClaimed(marker: string | null | undefined): boolean {
    return typeof marker === "string" && marker.startsWith(COMPENSATION_CLAIMED_PREFIX);
}

/**
 * Is an IRREVERSIBLE remote call fenced on this row right now?
 *
 * Round 51 (P0). A claim is only a fence if the thing it excludes actually
 * checks it. Round 50 claimed the row and then re-COUNTED it before dispatching
 * the delete — but a count is a read, not a fence: a settlement committing
 * between that read and the network call still won, the QuickBooks invoice of a
 * paid milestone was destroyed, and the post-delete CAS then failed, leaving a
 * paid row pointing at nothing.
 *
 * So settlement asks THIS. While either claim is held, some code is between
 * `SELECT` and an irreversible QuickBooks call for this row, and a settle must
 * not slip in behind it. The claim is short-lived and released on every path,
 * so the refusal is a RETRY, never a lost payment: the caller (a person, a
 * Stripe webhook, or the QBO pull) comes back and settles a moment later.
 */
export function isIrreversibleClaimHeld(marker: string | null | undefined): boolean {
    return isCompensationClaimed(marker) || isDeletionClaimed(marker);
}

/** The claim marker for one compensation attempt on one row. */
export function compensationClaimMarker(token: string): string {
    return `${COMPENSATION_CLAIMED_PREFIX}${token}`;
}

/** Is this row claimed by a deletion sweep right now? */
export function isDeletionClaimed(marker: string | null | undefined): boolean {
    return typeof marker === "string" && marker.startsWith(PENDING_DELETION_CLAIMED_PREFIX);
}

/** The claim marker for one sweep's attempt on one row. */
export function deletionClaimMarker(token: string): string {
    return `${PENDING_DELETION_CLAIMED_PREFIX}${token}`;
}

/** Is this row waiting for a QuickBooks delete to be confirmed? */
export function isPendingDeletion(qbSyncError: string | null | undefined): boolean {
    if (!qbSyncError) return false;
    return qbSyncError === PENDING_DELETION_MARKER
        || qbSyncError.startsWith(PENDING_DELETION_MARKER + MARKER_KIND_SEP);
}

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
    /**
     * Fingerprint of the MONEY STATE the invoice was built from, from
     * `qbo-issuance.ts`. Opaque here on purpose -- computing it needs
     * node:crypto and this module is imported by a client component.
     *
     * docNumber + privateNote prove an invoice is OURS. They say nothing about
     * whether it still DESCRIBES the row: neither carries the amount, the
     * status, or the due date. A create that landed but lost its post-create
     * CAS (the milestone was paid, canceled or repriced mid-flight) and whose
     * compensating delete then failed leaves exactly that shape -- a real
     * invoice in QuickBooks for money the row no longer owes. Without this the
     * resolver would link it. `undefined` means the marker predates the field:
     * the resolver treats that as unverifiable and refuses to link.
     */
    issuanceHash?: string;
    /**
     * The QuickBooks invoice TOTAL this create expects to produce.
     *
     * DocNumber + PrivateNote prove a document the resolver finds is OURS;
     * neither carries a dollar figure. Without this, a resolver that matched
     * on identity alone would link ANY invoice sharing that DocNumber and
     * PrivateNote, whatever its actual total — including a coincidental match
     * or a QuickBooks-side edit that changed the amount after our create.
     * `undefined` means the marker predates this field: the resolver skips the
     * comparison rather than refusing outright, since issuanceHash already
     * covers the "did our own row move" case this is a belt-and-suspenders
     * check on top of.
     */
    expectedTotal?: number;
    /**
     * The SALES TAX this create expects the document to carry
     * (`TxnTaxDetail.TotalTax`).
     *
     * The grand total is not enough. QuickBooks recomputes tax under Automated
     * Sales Tax from the customer address and the item's tax code, and it can
     * re-split the SAME grand total into a different pre-tax/tax pair — which
     * is the number the sales-tax return reads, and the number that decides how
     * much of the money is ours. A total-only comparison passes that document
     * without noticing.
     *
     * `undefined` means the marker predates this field: the comparison is
     * skipped rather than refused, exactly as for `expectedTotal`. A recorded
     * value of 0 is an ASSERTION that no tax was sent, not an absence.
     */
    expectedTax?: number;
    /**
     * The QuickBooks COMPANY (realm) the create POST went to.
     *
     * Everything above identifies a document. None of it identifies a BOOK.
     * The resolver queries with whatever credentials are connected NOW, and
     * that connection can legitimately point somewhere else than the one the
     * create used — a reconnect to a second company, a sandbox↔production
     * swap, an agency switching client files. Against the wrong realm the
     * DocNumber lookup finds nothing, which the resolver reads as "no invoice
     * exists" and offers to clear: the row becomes freely re-sendable while its
     * real, collectible invoice sits untouched in the original company.
     *
     * `undefined` means the marker predates this field. That is NOT "any realm
     * will do" -- the realm is then unknown, and an unknown realm is refused
     * outright (never auto-cleared). See the `realm-unknown` refusal in
     * qbo-ambiguous-create.ts.
     */
    realmId?: string;
    /**
     * The QuickBooks `CustomerRef` id the create POST billed.
     *
     * Same class of failure one level down. A DocNumber is unique to neither
     * the company nor the customer, and the row's client can be re-pointed at a
     * different QuickBooks customer between the create and the recovery (a
     * merge in QuickBooks, a re-`ensureQBCustomer` after a rename). Linking on
     * document identity alone would attach an invoice billed to one customer
     * onto a row that now bills another.
     *
     * `undefined` is handled exactly like an absent `realmId`: unknown, so
     * refused.
     */
    customerId?: string;
    /**
     * The QuickBooks id of a document this create DID produce and then could
     * not clean up.
     *
     * Every other field here describes what we went looking for. This one
     * records what we already found and failed to undo: a create whose
     * returned total did not match the row it was issued against, whose
     * compensating delete then failed. The invoice is real, collectible and
     * WRONG, and the row must never re-stage on top of it. The resolver
     * cannot fix that — a human has to void it in QuickBooks — so the id is
     * carried here to make it findable instead of leaving an operator to
     * search a company file by DocNumber.
     *
     * `undefined` is the normal case: nothing was left behind.
     */
    qbId?: string;
    /**
     * The `TxnDate` the create sent, as `YYYY-MM-DD`.
     *
     * The date decides which ACCOUNTING PERIOD the document books to, and the
     * payload builders computed it from `new Date()` at send time. So a replay
     * of an unconfirmed create — which exists precisely to re-send the SAME
     * document — silently sent a different one whenever it crossed midnight or
     * a period close, and recovery, which never looked at the date, adopted it.
     * Captured here so a replay reuses it and a candidate can be checked
     * against it.
     */
    txnDate?: string;
    /**
     * The QuickBooks `ItemRef` every line of the create carried.
     *
     * A single value because both payload builders put the SAME resolved
     * service item on every line (`buildQBEstimateLines`, and the invoice
     * builder's `ItemRef: { value: invoice.itemId }`). The item decides the
     * INCOME ACCOUNT the money books to, so a document built from another item
     * is a different document even when its note, customer and total all
     * agree. If the builders ever emit per-line items, this must become a
     * digest of them rather than one id.
     */
    itemId?: string;
}

/** Separates the marker kind from its identity payload. */
const MARKER_KIND_SEP = ":";
/** Separates docNumber from privateNote. First occurrence wins -- a note may contain more. */
const MARKER_FIELD_SEP = "|";
/**
 * Prefixes the epoch-ms a `create-in-flight` claim was written, e.g.
 * `create-in-flight:@1730000000000|INV-00171-2|ProBuild ...`.
 *
 * Both CREATE_IN_FLIGHT_MARKER and AMBIGUOUS_CREATE_MARKER carry one. Neither
 * PaymentSchedule nor ProgressBilling has an `updatedAt` column, so this is the
 * only durable place to record when the claim was taken -- and it is needed by
 * `resolveAmbiguousInvoiceCreateCore`'s liveness check: a `confirmed-none`
 * clear on a marker with no readable age, or one younger than
 * `CREATE_IN_FLIGHT_STALE_MS`, must refuse rather than assume the request it
 * describes has definitely finished landing in QuickBooks.
 *
 * A create-in-flight marker's timestamp is when the claim was taken; a
 * promotion to ambiguous-create MUST carry that SAME original timestamp
 * forward (composeCreateMarker takes an explicit `at`, callers must reuse the
 * one from the in-flight marker they are promoting), not a fresh one taken at
 * promotion time. Our own deadline firing only means WE gave up waiting -- the
 * request can still be landing at QuickBooks' end for a while after that. If
 * the promoted marker restarted the clock, the resolver's cooldown would judge
 * "is the original request still plausibly in flight?" against the wrong
 * origin and let an operator clear it (via `confirmed-none`) before that
 * original request has had time to become visible, opening the exact
 * double-create window this whole marker exists to close.
 */
const MARKER_TIME_PREFIX = "@";
/**
 * Prefixes the issuance hash, e.g.
 * `ambiguous-create:#4f1c2ab90de7331a|INV-00171-2|ProBuild ...`.
 *
 * Sits after the optional `@time` field and before the docNumber. Both prefixes
 * are safe to test for positionally because neither a DocNumber nor a
 * PrivateNote can begin with them -- see the invariants in composeCreateMarker.
 */
const MARKER_HASH_PREFIX = "#";
/**
 * Prefixes the expected total, e.g.
 * `ambiguous-create:#4f1c2ab90de7331a|$1089.00|INV-00171-2|ProBuild ...`.
 *
 * Sits after the optional `#hash` field and before the docNumber, for the
 * same positional-safety reason as the hash prefix.
 */
const MARKER_TOTAL_PREFIX = "$";
/**
 * Prefixes the expected sales tax, e.g.
 * `ambiguous-create:#4f1c2ab90de7331a|$1089.00|^89.00|INV-00171-2|ProBuild ...`.
 *
 * Sits immediately after the optional `$total` field it belongs with, and
 * before the docNumber, for the same positional-safety reason as the prefixes
 * above. `^` is not a character a ProBuild code or PrivateNote can begin with.
 */
const MARKER_TAX_PREFIX = "^";
/**
 * Prefixes the QuickBooks realm (company) id, e.g.
 * `ambiguous-create:#4f1c2ab90de7331a|$1089.00|~9130354...|INV-00171-2|ProBuild ...`.
 *
 * Sits after the optional `$total` field and before the docNumber, for the
 * same positional-safety reason as the prefixes above.
 */
const MARKER_REALM_PREFIX = "~";
/**
 * Prefixes the QuickBooks CustomerRef id, e.g.
 * `ambiguous-create:~9130354...|%58|INV-00171-2|ProBuild ...`.
 *
 * Last of the optional fields, immediately before the docNumber.
 */
const MARKER_CUSTOMER_PREFIX = "%";
/**
 * Prefixes the QuickBooks id of a document left behind by a failed
 * compensation, e.g. `ambiguous-create:%58|!1042|INV-00171-2|ProBuild ...`.
 *
 * Last of the optional fields, immediately before the docNumber, for the
 * same positional-safety reason as the prefixes above.
 */
const MARKER_QBID_PREFIX = "!";
/**
 * Prefixes the `TxnDate` the create sent, e.g.
 * `create-in-flight:+2026-09-03|EST-00237|ProBuild ...`.
 */
const MARKER_TXNDATE_PREFIX = "+";
/**
 * Prefixes the QuickBooks service `ItemRef` the create's lines carried, e.g.
 * `create-in-flight:+2026-09-03|&7|EST-00237|ProBuild ...`.
 *
 * Last of the optional fields, immediately before the docNumber.
 */
const MARKER_ITEM_PREFIX = "&";

/** Every optional field prefix, in the order composeCreateMarker emits them. */
const MARKER_OPTIONAL_PREFIXES = [
    MARKER_TIME_PREFIX,
    MARKER_HASH_PREFIX,
    MARKER_TOTAL_PREFIX,
    MARKER_TAX_PREFIX,
    MARKER_REALM_PREFIX,
    MARKER_CUSTOMER_PREFIX,
    MARKER_QBID_PREFIX,
    MARKER_TXNDATE_PREFIX,
    MARKER_ITEM_PREFIX,
] as const;

/**
 * `create-in-flight:@1730000000000|INV-00171-2|ProBuild INV-00171 - Rough-in - Mesplay`
 *
 * The identity rides in the qbSyncError column because this PR ships no schema
 * change and there is nowhere else durable to put it that is written in the
 * SAME CAS as the claim. It has to be one write: a marker without its identity
 * is a row we can block but never resolve.
 */
/**
 * Could `composeCreateMarker` have WRITTEN this DocNumber?
 *
 * The one place the composition invariants are stated as a predicate, so the
 * parser can hold a value to the same rules the composer enforces. A DocNumber
 * that fails this did not come out of `composeCreateMarker`, which means the
 * marker is corrupt — and a corrupt marker must be unresolvable rather than
 * resolvable as some other document.
 */
/**
 * Intuit's DocNumber cap, mirrored here.
 *
 * The canonical constant is `QB_DOC_NUMBER_MAX_LEN` in quickbooks.ts, which
 * this module cannot import: it is loaded by a client component and that file
 * pulls in node:crypto, fetch and Prisma. `tests/qbo-marker-grammar.test.ts`
 * asserts the two stay equal, so the duplication cannot drift silently.
 */
export const MARKER_DOC_NUMBER_MAX_LEN = 21;

export function isComposableDocNumber(value: string): boolean {
    if (!value) return false;
    if (value.includes(MARKER_FIELD_SEP)) return false;
    if (MARKER_OPTIONAL_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
    // Intuit's cap. The composer is always handed an already-truncated value,
    // so anything longer is not something this rail wrote.
    return value.length <= MARKER_DOC_NUMBER_MAX_LEN;
}

export function composeCreateMarker(
    kind: typeof CREATE_IN_FLIGHT_MARKER | typeof AMBIGUOUS_CREATE_MARKER,
    identity: CreateIdentity,
    /**
     * When the ORIGINAL create-in-flight claim was taken. Defaults to now,
     * which is correct when composing a fresh `create-in-flight` marker. A
     * caller promoting an existing in-flight marker to `ambiguous-create` MUST
     * pass the in-flight marker's own `at` through unchanged -- see the doc
     * comment on MARKER_TIME_PREFIX for why a fresh timestamp there would be
     * wrong.
     */
    at: Date = new Date(),
): string {
    // A docNumber containing the field separator would make the split
    // ambiguous. QuickBooks DocNumbers are ours to generate and never contain
    // one, so this is an invariant, not input validation.
    if (identity.docNumber.includes(MARKER_FIELD_SEP)) {
        throw new Error(`DocNumber must not contain "${MARKER_FIELD_SEP}": ${identity.docNumber}`);
    }
    // The optional `@time` and `#hash` fields are recognised by their leading
    // character, so a DocNumber starting with one would be swallowed as a
    // malformed field and the marker would parse as corrupt (fail-closed, but
    // silently unresolvable). Ours never do -- this is an invariant, not input
    // validation, same as the separator check above.
    if (MARKER_OPTIONAL_PREFIXES.some((prefix) => identity.docNumber.startsWith(prefix))) {
        throw new Error(
            `DocNumber must not start with ${MARKER_OPTIONAL_PREFIXES.map((p) => `"${p}"`).join(", ")}: ${identity.docNumber}`,
        );
    }
    // The note is the LAST field, and the same invariant applies to it for a
    // subtler reason: it is what the parser is left holding when a field
    // boundary shifts. Corrupt any optional prefix in the middle of a marker
    // and that field's value becomes the docNumber while every field after it
    // slides into the note — which then starts with a prefix character. Ours
    // never do (`documentPrivateNote` writes "ProBuild <code> - <label>"), so
    // this is an invariant, not input validation, and the parser rejecting it
    // is what makes that whole class of corruption unresolvable.
    if (identity.privateNote.includes(MARKER_FIELD_SEP)) {
        throw new Error(`PrivateNote must not contain "${MARKER_FIELD_SEP}": ${identity.privateNote}`);
    }
    if (MARKER_OPTIONAL_PREFIXES.some((prefix) => identity.privateNote.startsWith(prefix))) {
        throw new Error(
            `PrivateNote must not start with ${MARKER_OPTIONAL_PREFIXES.map((p) => `"${p}"`).join(", ")}: ${identity.privateNote}`,
        );
    }
    // The realm and the customer are QuickBooks-generated numeric ids. A
    // separator inside either would make the split ambiguous the same way a
    // separator in the DocNumber would, and an EMPTY one would compose a field
    // that parses back as absent -- i.e. silently downgrade to "unknown realm".
    // Both are invariants of the ids QuickBooks issues, not input validation.
    for (const [label, value] of [["realmId", identity.realmId], ["customerId", identity.customerId], ["qbId", identity.qbId], ["txnDate", identity.txnDate], ["itemId", identity.itemId]] as const) {
        if (value == null) continue;
        if (value === "" || value.includes(MARKER_FIELD_SEP)) {
            throw new Error(`${label} must be non-empty and must not contain "${MARKER_FIELD_SEP}": ${value}`);
        }
    }
    if (identity.issuanceHash != null && !/^[0-9a-f]+$/.test(identity.issuanceHash)) {
        throw new Error(`Issuance hash must be lowercase hex: ${identity.issuanceHash}`);
    }
    if (identity.expectedTotal != null && !Number.isFinite(identity.expectedTotal)) {
        throw new Error(`Expected total must be finite: ${identity.expectedTotal}`);
    }
    if (identity.expectedTax != null && !Number.isFinite(identity.expectedTax)) {
        throw new Error(`Expected tax must be finite: ${identity.expectedTax}`);
    }
    // Both marker kinds carry the timestamp now -- a promotion to
    // ambiguous-create must preserve the in-flight claim's original time, not
    // reset it. See the doc comment on MARKER_TIME_PREFIX.
    const timePart = `${MARKER_TIME_PREFIX}${at.getTime()}${MARKER_FIELD_SEP}`;
    const hashPart = identity.issuanceHash
        ? `${MARKER_HASH_PREFIX}${identity.issuanceHash}${MARKER_FIELD_SEP}`
        : "";
    const totalPart = identity.expectedTotal != null
        ? `${MARKER_TOTAL_PREFIX}${identity.expectedTotal}${MARKER_FIELD_SEP}`
        : "";
    const taxPart = identity.expectedTax != null
        ? `${MARKER_TAX_PREFIX}${identity.expectedTax}${MARKER_FIELD_SEP}`
        : "";
    const realmPart = identity.realmId
        ? `${MARKER_REALM_PREFIX}${identity.realmId}${MARKER_FIELD_SEP}`
        : "";
    const customerPart = identity.customerId
        ? `${MARKER_CUSTOMER_PREFIX}${identity.customerId}${MARKER_FIELD_SEP}`
        : "";
    const qbIdPart = identity.qbId
        ? `${MARKER_QBID_PREFIX}${identity.qbId}${MARKER_FIELD_SEP}`
        : "";
    const txnDatePart = identity.txnDate
        ? `${MARKER_TXNDATE_PREFIX}${identity.txnDate}${MARKER_FIELD_SEP}`
        : "";
    const itemPart = identity.itemId
        ? `${MARKER_ITEM_PREFIX}${identity.itemId}${MARKER_FIELD_SEP}`
        : "";
    return `${kind}${MARKER_KIND_SEP}${timePart}${hashPart}${totalPart}${taxPart}${realmPart}${customerPart}${qbIdPart}${txnDatePart}${itemPart}${identity.docNumber}${MARKER_FIELD_SEP}${identity.privateNote}`;
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
 *
 * `atMs` is the embedded claim time (see `MARKER_TIME_PREFIX`) -- the ORIGINAL
 * in-flight claim's time, preserved through a promotion to ambiguous-create --
 * or `null` when the marker carries none, i.e. it predates this field (legacy
 * row: treat as unknown age, never as fresh).
 */
export function parseCreateMarker(
    qbSyncError: string | null | undefined,
): { kind: string; identity: CreateIdentity | null; atMs: number | null } | null {
    const kind = markerKind(qbSyncError);
    if (!kind) return null;
    const marker = qbSyncError as string;
    if (marker === kind) return { kind, identity: null, atMs: null };
    let payload = marker.slice(kind.length + MARKER_KIND_SEP.length);
    /** Any recognized field that did not parse. The whole marker is then unusable. */
    let corrupt = false;
    const unusable = () => ({ kind, identity: null, atMs });
    let atMs: number | null = null;

    /**
     * Strict: a field whose prefix is present must parse COMPLETELY or the
     * marker is corrupt.
     *
     * These used to \"fall through unstripped\", on the theory that the leftover
     * text would land in docNumber and read as corrupt anyway. It does not
     * always: a malformed `&|...` field leaves a payload whose first separator
     * comes immediately, so the marker parses as docNumber `&` while keeping a
     * perfectly valid realm, customer and hash. A lookup for document `&` finds
     * nothing, and `confirmed-none` then clears the claim for a real invoice
     * sitting in QuickBooks under the number the claim was actually made with.
     * A corrupt marker must be UNRESOLVABLE, not resolvable-as-something-else.
     */
    const field = (prefix: string, valid: (raw: string) => boolean): string | undefined => {
        if (corrupt || !payload.startsWith(prefix)) return undefined;
        const end = payload.indexOf(MARKER_FIELD_SEP);
        const raw = end > 0 ? payload.slice(prefix.length, end) : "";
        if (end <= 0 || !raw || !valid(raw)) {
            corrupt = true;
            return undefined;
        }
        payload = payload.slice(end + MARKER_FIELD_SEP.length);
        return raw;
    };

    const time = field(MARKER_TIME_PREFIX, (raw) => Number.isFinite(Number(raw)));
    if (time !== undefined) atMs = Number(time);
    // REQUIRED, not optional. `composeCreateMarker` emits the timestamp
    // unconditionally for both kinds, so a payload that does not start with one
    // was not written by it. Without this check the leading `@` is the only
    // thing standing between a corrupted marker and a plausible-looking
    // identity: flip it to any other character and the timestamp itself parses
    // as the document number, with the rest of the fields trailing into the
    // note. A lookup for that number finds nothing, and `confirmed-none` then
    // clears the claim for a real document.
    //
    // A marker predating the timestamp field is therefore unresolvable rather
    // than adoptable. That is a deliberate narrowing: its age cannot be read
    // either, so the resolver already refused to CLEAR it
    // (CREATE_IN_FLIGHT_STALE_MS needs a readable claim time), and "link it
    // anyway" was the only thing it could still do with a string nothing in
    // this codebase can prove it wrote.
    if (atMs === null) return unusable();
    const issuanceHash = field(MARKER_HASH_PREFIX, (raw) => /^[0-9a-f]+$/.test(raw));
    const totalRaw = field(MARKER_TOTAL_PREFIX, (raw) => Number.isFinite(Number(raw)));
    const expectedTotal = totalRaw === undefined ? undefined : Number(totalRaw);
    const taxRaw = field(MARKER_TAX_PREFIX, (raw) => Number.isFinite(Number(raw)));
    const expectedTax = taxRaw === undefined ? undefined : Number(taxRaw);
    // The three id fields carry QuickBooks-generated values. Composition refuses
    // an empty one or one containing the separator, so anything else here is a
    // marker that was not written by `composeCreateMarker`.
    const idField = (raw: string) => raw.length > 0 && !raw.includes(MARKER_FIELD_SEP);
    const realmId = field(MARKER_REALM_PREFIX, idField);
    const customerId = field(MARKER_CUSTOMER_PREFIX, idField);
    const qbId = field(MARKER_QBID_PREFIX, idField);
    const txnDate = field(MARKER_TXNDATE_PREFIX, (raw) => /^\d{4}-\d{2}-\d{2}$/.test(raw));
    const itemId = field(MARKER_ITEM_PREFIX, idField);
    if (corrupt) return unusable();

    const sep = payload.indexOf(MARKER_FIELD_SEP);
    // A payload with no separator, an empty docNumber or an empty note is a
    // corrupt marker. Same handling as the legacy shape: refuse, don't guess.
    if (sep <= 0) return unusable();
    const docNumber = payload.slice(0, sep);
    const privateNote = payload.slice(sep + MARKER_FIELD_SEP.length);
    if (!docNumber || !privateNote) return unusable();
    // The DocNumber has to satisfy the SAME invariants composition enforces.
    // Without this, leftovers from a field this parser did not recognise read as
    // a document number and the marker resolves against the wrong document.
    if (!isComposableDocNumber(docNumber)) return unusable();
    // See composeCreateMarker: a note beginning with a field prefix means a
    // field boundary moved, so the docNumber above is some other field's value.
    if (MARKER_OPTIONAL_PREFIXES.some((prefix) => privateNote.startsWith(prefix))) return unusable();
    // And it is the LAST field, so it contains no separator either
    // (`canonicalPrivateNote` strips them before composition). A note carrying
    // one means a field boundary moved and the document number above is some
    // other field's value — the corruption class this whole grammar exists to
    // make unresolvable rather than mis-resolvable.
    if (privateNote.includes(MARKER_FIELD_SEP)) return unusable();
    // Each optional key is OMITTED, not set to undefined, when the marker
    // carries no hash / total / realm / customer: a deep-equality check against
    // a two-field identity has to keep reading as equal for a legacy marker.
    return {
        kind,
        identity: {
            docNumber,
            privateNote,
            ...(issuanceHash ? { issuanceHash } : {}),
            ...(expectedTotal != null ? { expectedTotal } : {}),
            ...(expectedTax != null ? { expectedTax } : {}),
            ...(realmId ? { realmId } : {}),
            ...(customerId ? { customerId } : {}),
            ...(qbId ? { qbId } : {}),
            ...(txnDate ? { txnDate } : {}),
            ...(itemId ? { itemId } : {}),
        },
        atMs,
    };
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

/**
 * Diagnostic flags this module does not own but must still recognise.
 *
 * Both are written by the milestone rail (quickbooks-payments.ts) and neither
 * is a create marker, so `markerKind` ignores them — but both describe a row a
 * client must not be asked to pay, so the send predicate below has to know
 * them. Declared here rather than imported to keep this module free of the
 * server-only rail (it is bundled into a client component).
 */
export const PAID_DELETION_UNRESOLVABLE = "paid-deletion-unresolvable";
export const SETTLED_WITHOUT_QB_PAYMENT = "settled-without-qb-payment";

/**
 * THE one reason a milestone may not be sent, copied or re-sent to a client.
 *
 * Every send path used to make its own decision, and each of them checked a
 * different, smaller thing: `sendMilestoneInvoicesCore` rejected only
 * Paid/Canceled, and an ALREADY-LINKED row never reaches
 * `pushMilestoneToQuickBooks` (which is where the marker guards live), so a
 * milestone whose QuickBooks invoice was queued for deletion — or was parked
 * by an unknown-outcome create, or settled outside QuickBooks — could still be
 * emailed to the client with a pay link for a document that is about to
 * vanish, or has already been paid.
 *
 * `null` means sendable. A string is the reason, written for the operator: it
 * goes in the skip result AND on the disabled button in the editor, so the UI
 * and the server agree by construction rather than by review.
 */
export function milestoneSendBlockedReason(row: {
    qbSyncError?: string | null;
}): string | null {
    const marker = row.qbSyncError;
    if (!marker) return null;
    if (isPendingDeletion(marker)) {
        return "its QuickBooks invoice is queued for deletion " + "— resolve that first, or the client gets a link to a document that is about to vanish";
    }
    if (marker === PAID_DELETION_UNRESOLVABLE) {
        return "it was paid while its QuickBooks invoice was being deleted " + "— reconcile it in QuickBooks before sending anything";
    }
    if (marker === SETTLED_WITHOUT_QB_PAYMENT) {
        return "it is already paid in ProBuild while its QuickBooks invoice is still open " + "— reconcile it in QuickBooks before sending anything";
    }
    if (markerKind(marker)) {
        return "a previous QuickBooks send for it ended without a confirmed result " + "— check QuickBooks and resolve it before sending again";
    }
    // `voided` / `notFound` and anything else the poller wrote: the row is
    // flagged but the invoice is not in an ambiguous or disappearing state, so
    // sending is the operator's call, exactly as it was before.
    return null;
}
