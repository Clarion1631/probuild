/**
 * Resolving an ambiguous QuickBooks invoice create.
 *
 * When a create's outcome is unknown (our deadline fired, or the connection
 * died after the request went out) the row is parked — `ambiguous-create` on
 * the milestone rail (PaymentSchedule) or the progress-billing rail
 * (ProgressBilling) — and every send path refuses it. That is fail-closed and
 * correct, but until now the operator had nowhere to go: the error told them to
 * "check QuickBooks and clear the link", and the unlink action refused precisely
 * the state it was supposed to clear (there is no link to break).
 *
 * This is the recovery. It asks QuickBooks what actually happened, by
 * DocNumber, and accepts only an unambiguous answer:
 *
 *   exactly one invoice carrying OUR PrivateNote  → link it, marker cleared
 *   none, and the operator confirms none          → marker cleared, re-sendable
 *   more than one, or QuickBooks unreachable      → refuse, write NOTHING
 *
 * Session-free (no auth lookups of its own) so it can be driven end to end by a
 * test with a fake Prisma and a fake QuickBooks; the actor and their role come
 * in as arguments and the role rule is enforced HERE, not only at the action
 * wrapper, so a test of the refusal exercises the real decision.
 */
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { withTxRetry, lockMoneyParents, lockClientRow, clientCustomerStillMatches } from "./tx-retry";
import { logAutomationEventInTx, type AutomationEventInput } from "./automation-events";
import { canResolveAmbiguousCreate, canAccessProject, type ProjectScopedUser } from "./access-rules";
import {
    createRouteDeadline,
    isQBTimeoutError,
    isQboConnectionFailure,
    isQBResultSetTruncatedError,
    findQBInvoicesByDocNumber,
    canonicalPrivateNote,
    type QBInvoiceMatch,
    type QBTokens,
    type RouteDeadline,
} from "./quickbooks";
import {
    PAYLINK_PENDING_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_STALE_MS,
    parseCreateMarker,
    getFreshQBTokens,
} from "./quickbooks-payments";
import { RESOLVE_REASON_MAX_LEN, type CreateIdentity } from "./qbo-create-markers";
import { documentMatchesClaim } from "./qbo-document-sync";
import { milestoneIssuanceHash, progressBillingIssuanceHash, milestoneTaxSplit } from "./qbo-issuance";
import { toNum } from "./prisma-helpers";

/** Whole-operation budget: a token refresh plus one query, and room to answer. */
export const RESOLVE_AMBIGUOUS_BUDGET_MS = 25_000;

export type AmbiguousCreateKind = "milestone" | "progressBilling";

/**
 * What the operator asserted when they clicked.
 *
 * `link-existing` means "go look"; it still refuses if the answer is anything
 * other than exactly one match. `confirmed-none` is the extra assertion needed
 * before we will clear a marker on a zero-result answer, because clearing it
 * makes the row freely re-sendable and a wrong "none" bills the client twice.
 */
export type AmbiguousCreateDecision = "link-existing" | "confirmed-none";

export type AmbiguousCreateRefusal =
    | "forbidden"
    | "not-found"
    | "not-ambiguous"
    | "identity-unknown"
    | "stale"
    | "none-found"
    | "multiple-matches"
    | "quickbooks-unreachable"
    | "changed"
    | "invalid"
    | "create-still-active"
    | "result-set-truncated"
    | "issuance-changed"
    | "issuance-unverifiable"
    | "realm-unknown"
    | "realm-mismatch"
    | "customer-mismatch"
    | "mismatch";

export type ResolveAmbiguousCreateResult =
    | { ok: true; outcome: "linked"; qbInvoiceId: string; message: string }
    | { ok: true; outcome: "cleared"; message: string }
    | { ok: false; refusal: AmbiguousCreateRefusal; message: string; candidates?: { qbInvoiceId: string; total: number | null }[] };

/**
 * Extends `ProjectScopedUser` (role + permissions + project scope) so the
 * horizontal check below — the row's project, not just the `invoices`/
 * `resolveAmbiguousCreate` permission generally — can be enforced HERE,
 * alongside the role rule, rather than trusted to whichever action wrapper
 * happens to call this.
 */
export interface AmbiguousCreateActor extends ProjectScopedUser {
    id?: string | null;
    email?: string | null;
    role: string;
}

/**
 * The row state the operator was shown.
 *
 * NEITHER PaymentSchedule NOR ProgressBilling carries an `updatedAt` column,
 * and this PR ships no schema change — so the optimistic-concurrency token is
 * the pair of fields the decision actually depends on. A row someone else
 * already resolved (or re-sent) no longer matches, and the write's CAS below
 * pins the same fields again, so a race that slips past this check still cannot
 * write.
 */
export function ambiguousCreateFingerprint(row: { qbSyncError: string | null; qbInvoiceId: string | null }): string {
    return `${row.qbSyncError ?? ""}|${row.qbInvoiceId ?? ""}`;
}

export interface ResolveAmbiguousCreateInput {
    kind: AmbiguousCreateKind;
    id: string;
    /** From `ambiguousCreateFingerprint` when the row was rendered. */
    expectedState: string;
    decision: AmbiguousCreateDecision;
    /** Free text: what the operator saw in QuickBooks. Recorded on the audit event. */
    reason: string;
    actor: AmbiguousCreateActor;
}

/**
 * The transaction client the guarded write runs on.
 *
 * `$queryRaw` is here because `lockMoneyParents` / `lockClientRow` use it to
 * take the Estimate → Invoice → Client row locks; `invoice.findUnique` and
 * `client.findUnique` because the parent state this resolver's decision depends
 * on (the client's QuickBooks customer, the invoice's tax rate) has to be
 * RE-READ inside those locks.
 *
 * `client` is a delegate of its own rather than an `Invoice.client` relation
 * select on purpose: reading the customer THROUGH the invoice is exactly the
 * bug this shape now prevents — a relation read takes no lock on the Client
 * row, so the mapping could be re-pointed between that read and the child
 * write. The Client id comes off the locked Invoice, the Client row is locked,
 * and only then is `qbCustomerId` read.
 */
export interface AmbiguousCreateTx {
    paymentSchedule: { updateMany(args: any): Promise<{ count: number }> };
    progressBilling: { updateMany(args: any): Promise<{ count: number }> };
    invoice: { findUnique(args: any): Promise<any> };
    client: { findUnique(args: any): Promise<any> };
    /**
     * The audit row is written HERE, in the same transaction as the
     * decision it records — see logAutomationEventInTx. Declared on the seam
     * so a fake database cannot quietly skip it.
     */
    automationEvent: { create(args: { data: unknown }): Promise<unknown> };
    $queryRaw(...args: any[]): Promise<unknown>;
}

/** Test seam: the QBO lookup and the two table delegates. */
export interface ResolveAmbiguousCreateDeps {
    db?: {
        paymentSchedule: { findUnique(args: any): Promise<any> };
        progressBilling: { findUnique(args: any): Promise<any> };
        /**
         * Required, not optional. Every write this resolver makes runs inside
         * it — an optional transaction seam would let a fake database skip the
         * parent-lock path entirely, so the tests would prove nothing about the
         * code that actually runs in production.
         */
        $transaction<T>(fn: (tx: AmbiguousCreateTx) => Promise<T>): Promise<T>;
    };
    getTokens?: (deadline: RouteDeadline) => Promise<QBTokens>;
    findInvoices?: (tokens: QBTokens, docNumber: string, deadline: RouteDeadline) => Promise<QBInvoiceMatch[]>;
    deadline?: RouteDeadline;
}

/**
 * The issuance inputs that live on PARENT rows, not on the parked row itself.
 *
 * Both feed the create payload — the customer it is billed to, and (milestone
 * rail only) the rate its tax allocation is derived from — and neither can be
 * pinned by a child-table CAS. They are re-read under the money locks instead.
 */
export interface ParentIssuanceState {
    /** `Client.qbCustomerId` as it stands under the lock. */
    customerId: string | null;
    /** `Invoice.taxRate` as it stands under the lock. Unused on the billing rail. */
    invoiceTaxRate: unknown;
}

/** What we expect QuickBooks to be holding, if the create did land. */
interface ParkedRow {
    id: string;
    code: string;
    /**
     * READ BACK FROM THE MARKER, never recomputed.
     *
     * The docNumber is the milestone's POSITION in its invoice's schedule and
     * the privateNote embeds the project and milestone names, so both move when
     * an earlier milestone is deleted or something is renamed. Recomputing them
     * here would query QuickBooks for a document we never created, find
     * nothing, and offer to release a row whose real invoice is collectible.
     * `null` means the marker predates the identity (or is corrupt): refuse.
     */
    identity: CreateIdentity | null;
    /**
     * The issuance hash of the row AS IT STANDS NOW, recomputed from the same
     * columns the create hashed. Compared against the marker's before linking.
     */
    currentIssuanceHash: string;
    /**
     * The same hash, recomputed against PARENT-row values supplied by the
     * caller instead of the ones read at load time.
     *
     * The child columns are frozen by the link CAS (`issuanceWhere`), but the
     * two inputs that live on OTHER tables — `Client.qbCustomerId` and
     * `Invoice.taxRate` — cannot go in a `PaymentSchedule` `updateMany` where.
     * A comment here used to claim the marker covered them; it does not. The
     * marker records what those values were AT CREATE TIME and is never
     * rewritten when they change, so re-pointing the client at another
     * QuickBooks customer, or moving the invoice's tax rate, left the CAS
     * matching and the link going through. This closure is what lets the write
     * transaction re-read them under the money locks and recompute.
     */
    issuanceHashWith(parent: ParentIssuanceState): string;
    /**
     * The sales tax the create actually sent, in dollars — `0` when the payload
     * carried no tax line. Compared against the CANDIDATE invoice's own
     * `TxnTaxDetail.TotalTax`, so a QuickBooks-side re-split that leaves the
     * grand total alone cannot be adopted.
     */
    expectedTaxAmount: number;
    /**
     * Those same columns as a Prisma `where` fragment, folded into the link
     * CAS. The hash comparison is a read; this is what makes the decision
     * atomic with the write, so a settle landing between the two cannot slip a
     * stale invoice onto a row that just changed.
     */
    issuanceWhere: Record<string, unknown>;
    marker: string;
    /** Which pending-create kind the marker is, or `null` when not parked. */
    kind: string | null;
    /** The embedded claim time, for a `create-in-flight` marker. `null` if unreadable. */
    atMs: number | null;
    fingerprint: string;
    projectId: string | null;
    invoiceId: string | null;
    /**
     * The parent invoice's estimate, read for LOCK ORDER only.
     *
     * Every money-path transaction takes Estimate before Invoice
     * (`lockMoneyParents`), so this one must too or it can deadlock against a
     * settle running the other way.
     */
    estimateId: string | null;
    /**
     * The QuickBooks customer this row bills TODAY — the persisted
     * `Client.qbCustomerId` the create path wrote when it ran
     * `resolveCustomerAndItem`. Compared against the marker's own
     * `customerId` before any QuickBooks call. `null` means the mapping is
     * gone, which is a mismatch, not a pass: an unverifiable customer is
     * exactly the state that must not be linked or cleared.
     */
    customerId: string | null;
}

export async function resolveAmbiguousInvoiceCreateCore(
    input: ResolveAmbiguousCreateInput,
    deps?: ResolveAmbiguousCreateDeps,
): Promise<ResolveAmbiguousCreateResult> {
    // Cast rather than structurally checked: PrismaClient's `$transaction` is
    // overloaded (array form, callback form, options form) and the narrow
    // callback shape this module needs does not assign cleanly from it.
    const db = deps?.db ?? (prisma as unknown as NonNullable<ResolveAmbiguousCreateDeps["db"]>);
    const findInvoices = deps?.findInvoices ?? findQBInvoicesByDocNumber;
    const getTokens = deps?.getTokens ?? getFreshQBTokens;

    if (!canResolveAmbiguousCreate(input.actor)) {
        return {
            ok: false,
            refusal: "forbidden",
            message: "Only an admin or the finance role can resolve a QuickBooks invoice that may already exist.",
        };
    }
    const reason = (input.reason || "").trim();
    if (!reason) {
        return { ok: false, refusal: "invalid", message: "Say what you found in QuickBooks — it goes on the audit record." };
    }
    // Bounded at the DOOR, not at the log. The audit row is the whole point of
    // asking, and an unbounded note used to take the rest of the record down
    // with it: the event logger gave up on an oversized `detail` and replaced
    // the entire payload with a list of key names, so the actor, the decision
    // and the reason all vanished together. The logger no longer does that
    // (automation-events.ts truncates value by value), and this is the other
    // half: a note nobody can read is not evidence, so say no up front rather
    // than storing something misleading.
    if (reason.length > RESOLVE_REASON_MAX_LEN) {
        return {
            ok: false,
            refusal: "invalid",
            message: `Keep the note under ${RESOLVE_REASON_MAX_LEN} characters — it goes on the audit record. Put the detail in QuickBooks and summarise it here.`,
        };
    }

    const parked = await loadParkedRow(db, input.kind, input.id);
    if (!parked) return { ok: false, refusal: "not-found", message: "That row no longer exists." };
    // canResolveAmbiguousCreate above only proves this actor may resolve
    // ambiguous creates SOMEWHERE — it says nothing about THIS row's project.
    // Without this, a FINANCE user scoped to one project could resolve (and
    // potentially link a real QuickBooks invoice to) another project's row by
    // id alone, before any QuickBooks call or write happens below. Fail
    // CLOSED on an ownerless row, same as assertEstimateScope.
    if (!parked.projectId || !canAccessProject(input.actor, parked.projectId)) {
        return {
            ok: false,
            refusal: "forbidden",
            message: "You do not have access to this project's invoices.",
        };
    }
    if (!parked.marker) {
        return {
            ok: false,
            refusal: "not-ambiguous",
            message: "This one is not waiting on a QuickBooks answer — nothing to resolve.",
        };
    }
    if (!parked.identity) {
        // A marker from before the identity was carried, or a corrupt one. We
        // cannot know which document to ask about, and the one thing we must
        // never do is conclude "there is none" and release the row.
        // Deliberately not clearable, whatever the operator confirms.
        return {
            ok: false,
            refusal: "identity-unknown",
            message:
                `${parked.code} was parked by an older release that did not record which QuickBooks document to look for, ` +
                `so this cannot be resolved automatically. Find the invoice in QuickBooks by hand — if it exists, keep it and record the payment there.`,
        };
    }
    if (parked.fingerprint !== input.expectedState) {
        return {
            ok: false,
            refusal: "stale",
            message: "This changed since the page was loaded (someone may have already resolved it). Refresh and look again.",
        };
    }

    // A `create-in-flight` marker means the POST may STILL be running. A row
    // promoted to `ambiguous-create` means OUR wait for that same request ended
    // (a timeout, or a definite unknown-outcome failure) — but our deadline
    // firing only means WE gave up; the original request can still be landing
    // at QuickBooks' end for a while afterward, and may not be visible to the
    // lookup below yet. Both kinds carry the ORIGINAL claim's timestamp (see
    // composeCreateMarker), so both get the same cooldown here.
    //
    // This gate used to run only on the zero-match "confirmed-none" clear
    // path, AFTER querying QuickBooks. That left an exact-match LINK on a
    // fresh marker unguarded: if the original sender is still running, its own
    // post-create link write can lose the race against this one (see the CAS
    // in quickbooks-payments.ts), which makes IT compensate — and
    // compensateAndUnlink deletes the very invoice this resolver just adopted.
    // Running it here, before any QuickBooks call, refuses every outcome
    // (link, clear, and mismatch alike) for as long as the original request
    // might still be in flight. A marker without a readable claim time, or one
    // younger than CREATE_IN_FLIGHT_STALE_MS, refuses outright. Neither table
    // carries `updatedAt`, so an unreadable age is the common case today, not
    // the exception — that is deliberately fail-closed.
    if (parked.kind === CREATE_IN_FLIGHT_MARKER || parked.kind === AMBIGUOUS_CREATE_MARKER) {
        const stillActive = parked.atMs == null || Date.now() - parked.atMs < CREATE_IN_FLIGHT_STALE_MS;
        if (stillActive) {
            return {
                ok: false,
                refusal: "create-still-active",
                message: `${parked.code} may still be mid-create in QuickBooks right now — resolving this now could race the original request, letting a second invoice be created or a good one be deleted out from under you. Wait a few minutes and try again.`,
            };
        }
    }

    // WHICH BOOKS, and WHICH CUSTOMER.
    //
    // Everything checked so far identifies a DOCUMENT. None of it identifies
    // the QuickBooks COMPANY the document lives in, and the lookup below runs
    // against whatever connection is active NOW — which can legitimately be a
    // different realm than the create used (a reconnect to a second company, a
    // sandbox↔production swap, an agency moving between client files). Against
    // the wrong realm the DocNumber query finds nothing, the operator is asked
    // "confirm none exists?", and a `confirmed-none` clear releases a row whose
    // real, collectible invoice is sitting untouched in the original company —
    // the exact double-bill this whole marker exists to prevent.
    //
    // A marker that carries neither field predates them. That is NOT "any
    // realm will do": the realm is unknown, and an unknown realm is refused
    // outright — never auto-cleared — the same way an unknown identity is.
    if (!parked.identity.realmId || !parked.identity.customerId) {
        return {
            ok: false,
            refusal: "realm-unknown",
            message:
                `${parked.code} was parked by an older release that did not record WHICH QuickBooks company the invoice was sent to, ` +
                `so ProBuild cannot tell whether the connection it can read now is even the right set of books. ` +
                `Find the invoice in QuickBooks by hand — nothing was changed here.`,
        };
    }
    // The customer check is a pure database read, so it runs before the token
    // fetch: a row whose client has been re-pointed at another QuickBooks
    // customer (a merge in QuickBooks, a re-`ensureQBCustomer` after a rename)
    // must not spend a QuickBooks call, let alone link an invoice billed to
    // somebody else.
    if (parked.customerId !== parked.identity.customerId) {
        return {
            ok: false,
            refusal: "customer-mismatch",
            message:
                `${parked.code} was sent to QuickBooks customer ${parked.identity.customerId}, but it now bills ` +
                `${parked.customerId ?? "no linked QuickBooks customer"}. Linking would attach an invoice billed to a different customer. ` +
                `Check invoice ${parked.identity.docNumber} in QuickBooks — nothing was changed here.`,
        };
    }

    // Bounded: an unreachable QuickBooks must refuse quickly, not hang the
    // action to the platform ceiling — the original defect this PR exists for.
    const deadline = deps?.deadline ?? createRouteDeadline(RESOLVE_AMBIGUOUS_BUDGET_MS);
    let matches: QBInvoiceMatch[];
    try {
        const tokens = await getTokens(deadline);
        // Before the query, not after: a wrong-realm lookup is not a harmless
        // no-op, it is an answer that reads as "no invoice exists".
        if (tokens.realmId !== parked.identity.realmId) {
            return {
                ok: false,
                refusal: "realm-mismatch",
                message:
                    `${parked.code} was sent to QuickBooks company ${parked.identity.realmId}, but ProBuild is connected to ` +
                    `company ${tokens.realmId} right now. Anything read from these books says nothing about that invoice. ` +
                    `Reconnect the original company, or resolve invoice ${parked.identity.docNumber} there by hand — nothing was changed here.`,
            };
        }
        const found = await findInvoices(tokens, parked.identity.docNumber, deadline);
        // DocNumber is not unique in QuickBooks (duplicates can be enabled, and
        // the number is only 21 characters), so the PrivateNote is what says an
        // invoice is OURS. Both come from the marker written before the POST.
        //
        // Canonicalized on BOTH sides. The QuickBooks value used to be trimmed
        // and compared against the raw marker value, so a project or milestone
        // name carrying trailing whitespace made our own invoice invisible to
        // this filter — zero matches, the operator confirms none, the marker is
        // cleared, and the next send bills the client a second time. See
        // canonicalPrivateNote.
        matches = found.filter(
            (inv) => canonicalPrivateNote(inv.privateNote) === canonicalPrivateNote(parked.identity!.privateNote),
        );
    } catch (error) {
        // The query hit its page cap — there may be MORE invoices under this
        // DocNumber than we saw, including one on a page we never fetched.
        // That is exactly the "more than one, ambiguous" case, so refuse the
        // same way as a confirmed multiple-matches answer rather than as a
        // generic unreachable one.
        if (isQBResultSetTruncatedError(error)) {
            return {
                ok: false,
                refusal: "result-set-truncated",
                message: `QuickBooks holds too many invoices under ${parked.identity.docNumber} to confirm this automatically — find and resolve the duplicates in QuickBooks directly. Nothing was changed here.`,
            };
        }
        // Every other failure refuses too. A timeout, a 5xx and a plain
        // refusal all leave the same question unanswered — whether an invoice
        // is sitting there — and the only safe answer to "I don't know" is to
        // write nothing.
        const timedOut = isQBTimeoutError(error) || isQboConnectionFailure(error);
        return {
            ok: false,
            refusal: "quickbooks-unreachable",
            message: timedOut
                ? "QuickBooks did not answer, so nothing was changed. Try again in a minute."
                : `QuickBooks could not be read (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}), so nothing was changed.`,
        };
    }

    if (matches.length > 1) {
        // Two invoices for one row is a real duplicate bill. Refusing keeps the
        // row parked, which is the only state that stops a third one.
        return {
            ok: false,
            refusal: "multiple-matches",
            message: `QuickBooks holds ${matches.length} invoices for ${parked.identity.docNumber}. Delete the extras in QuickBooks first — nothing was changed here.`,
            candidates: matches.map((m) => ({ qbInvoiceId: m.id, total: m.total })),
        };
    }

    if (matches.length === 1) {
        // An invoice exists — but "it is ours" and "it still describes this
        // row" are different questions, and only the first one has been
        // answered so far. DocNumber and PrivateNote carry no amount, no status
        // and no due date, so a create that landed, lost its post-create CAS
        // (paid/canceled/repriced/renamed mid-flight) and then failed to
        // compensate leaves a real QuickBooks invoice for money this row no
        // longer owes, wearing a perfectly matching identity. Linking it would
        // point the row at a stale bill the client can still pay.
        //
        // The marker's issuance hash is the answer. Fail closed on both a
        // mismatch and an absent hash: the operator can still resolve it by
        // hand in QuickBooks, and a wrong link is a wrong bill.
        if (!parked.identity.issuanceHash) {
            return {
                ok: false,
                refusal: "issuance-unverifiable",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but ${parked.code} was parked without a record of the amount it was sent for, ` +
                    `so ProBuild cannot confirm that invoice still matches this row. Check the amount in QuickBooks and resolve it there — nothing was changed here.`,
            };
        }
        if (parked.identity.issuanceHash !== parked.currentIssuanceHash) {
            return {
                ok: false,
                refusal: "issuance-changed",
                message:
                    `${parked.code} has changed since that QuickBooks invoice was created (its amount, status, name or due date is no longer what was sent), ` +
                    `so linking it would attach a bill for the wrong money. Check invoice ${parked.identity.docNumber} in QuickBooks — if it is wrong, void or delete it there. Nothing was changed here.`,
            };
        }
        // DocNumber and PrivateNote prove this invoice is OURS; neither carries
        // a dollar figure, and the issuance-hash check above only proves our OWN
        // row hasn't moved — it says nothing about the invoice QuickBooks
        // actually holds. A coincidental identity match (or a QuickBooks-side
        // edit) with the wrong total would otherwise be linked blind, attaching
        // a bill for money this row does not actually owe.
        //
        // `matches[0].total` comes from `Number(TotalAmt)` on the QBO row — an
        // unparseable TotalAmt reads as NaN, and `Math.abs(NaN - x) > 0.005` is
        // FALSE, which let a candidate whose amount could not even be read slip
        // past this guard as though it matched. An unreadable total is exactly
        // the "cannot confirm" case the rest of this block exists to refuse.
        if (!Number.isFinite(matches[0].total)) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but its total could not be read from QuickBooks, ` +
                    `so ProBuild cannot confirm it matches ${parked.code} — check invoice ${parked.identity.docNumber} ` +
                    `in QuickBooks before doing anything else with this row. Nothing was changed here.`,
            };
        }
        // An UNREADABLE total is not a matching one. The lookup now reports it as
        // null rather than coercing it to 0 (which compared unequal by luck), so
        // the "we could not check" case has to refuse on its own.
        if (parked.identity.expectedTotal != null && matches[0].total == null) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but QuickBooks did not report a ` +
                    `readable total for it, so ProBuild cannot confirm it matches ${parked.code} — check it in QuickBooks ` +
                    `before doing anything else with this row. Nothing was changed here.`,
            };
        }
        if (
            parked.identity.expectedTotal != null
            && Math.abs((matches[0].total as number) - parked.identity.expectedTotal) > 0.005
        ) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but its total ($${(matches[0].total as number).toFixed(2)}) ` +
                    `does not match what ${parked.code} expected ($${parked.identity.expectedTotal.toFixed(2)}) — check invoice ${parked.identity.docNumber} ` +
                    `in QuickBooks before doing anything else with this row. Nothing was changed here.`,
            };
        }
        // WHO QUICKBOOKS IS ACTUALLY BILLING.
        //
        // The customer was checked once already, near the top — but that check
        // compares the MARKER against ProBuild's OWN `Client.qbCustomerId`, so
        // all it proves is that local state has not moved. It says nothing
        // about the document in front of us. QuickBooks holds the CustomerRef,
        // it can be edited there after our create, and a DocNumber is unique to
        // neither the company nor the customer — so an invoice addressed to
        // somebody else could still reach this line wearing a matching
        // DocNumber, PrivateNote and total.
        //
        // An unreadable CustomerRef is refused for the same reason an
        // unreadable total is: "cannot confirm" is not "matches".
        if (matches[0].customerId !== parked.identity.customerId) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but QuickBooks bills it to customer ` +
                    `${matches[0].customerId ?? "nobody we can read"} while ${parked.code} was sent to customer ${parked.identity.customerId}. ` +
                    `Linking would attach a bill addressed to someone else — check invoice ${parked.identity.docNumber} in QuickBooks. Nothing was changed here.`,
            };
        }
        // AND WHAT TAX IT CARRIES.
        //
        // The grand total matching does not mean the invoice matches: QuickBooks
        // Automated Sales Tax can re-split the same total into a different
        // pre-tax/tax pair, and the split is the number Vanessa's sales-tax
        // reporting reads. `expectedTaxAmount` is what the create actually sent
        // — trustworthy here precisely because the issuance hash above has
        // already proved this row still holds the state it was issued from.
        //
        // An absent TotalTax is only accepted when we sent no tax either; on a
        // taxed invoice it is another "cannot confirm".
        const remoteTax = matches[0].totalTax;
        const taxUnverifiable = remoteTax === null && parked.expectedTaxAmount > 0.005;
        if (taxUnverifiable || (remoteTax !== null && Math.abs(remoteTax - parked.expectedTaxAmount) > 0.005)) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but its sales tax ` +
                    `(${remoteTax === null ? "unreadable" : `$${remoteTax.toFixed(2)}`}) does not match what ${parked.code} was sent with ` +
                    `($${parked.expectedTaxAmount.toFixed(2)}) — check invoice ${parked.identity.docNumber} in QuickBooks before doing anything else with this row. ` +
                    `Nothing was changed here.`,
            };
        }
        // The remaining fields, through the SHARED predicate.
        //
        // The hand-written checks above cover note, total, customer and tax. They
        // never covered the accounting DATE or the line ITEMS — so a document
        // booked into another period, or against a different income account, was
        // adopted here while the create path (which runs the same predicate)
        // refused it. One rule, both directions.
        const verdict = documentMatchesClaim(matches[0], parked.identity);
        if (!verdict.ok) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but ${verdict.reason} — ` +
                    `check it in QuickBooks before doing anything else with this row. Nothing was changed here.`,
            };
        }
        // QuickBooks is the truth: an invoice exists, whatever the operator
        // asserted. Adopt it. PAYLINK_PENDING_MARKER rather than null, because
        // we have the id but not the pay link — the maintenance sweep fetches it.
        const qbInvoiceId = matches[0].id;
        const linked = await writeUnderParentLocks(db, input.kind, parked, auditEvent(input, parked, "linked", reason, { qbInvoiceId }), (delegate) => delegate.updateMany({
            // The issuance columns are pinned here as well as hashed above: the
            // hash check is a read taken before this write, so without them a
            // settle or a reprice landing in between would still be linked. The
            // parent-side inputs are covered by the surrounding transaction —
            // see writeUnderParentLocks.
            where: { id: parked.id, qbInvoiceId: null, qbSyncError: parked.marker, ...parked.issuanceWhere },
            data: {
                qbInvoiceId,
                qbSyncedAt: new Date(),
                qbSyncError: PAYLINK_PENDING_MARKER,
                ...(input.kind === "progressBilling" ? { status: "Staged" } : {}),
            },
        }));
        if (!linked.ok) return linked.refused;
        return {
            ok: true,
            outcome: "linked",
            qbInvoiceId,
            message: `Linked to the QuickBooks invoice that was already there (${parked.identity.docNumber}).`,
        };
    }

    // Zero matches. Clearing the marker makes the row freely re-sendable, so it
    // takes an explicit human assertion — a wrong "none" bills twice.
    if (input.decision !== "confirmed-none") {
        return {
            ok: false,
            refusal: "none-found",
            message: `No QuickBooks invoice matches ${parked.identity.docNumber}. If you have checked QuickBooks yourself, confirm none exists to clear this and send again.`,
        };
    }
    // The liveness cooldown for a still-active marker is checked once, up
    // front, before any QuickBooks call — see the comment there. By the time
    // we get here it has already refused a fresh create-in-flight/ambiguous
    // marker for every outcome, clearing included.
    //
    // The clear runs under the same parent locks as the link, and for the same
    // reason: the "nothing exists in QuickBooks" answer was reached against a
    // particular customer mapping, and clearing releases the row to be sent
    // again. A client re-pointed at another QuickBooks customer while this ran
    // makes that answer meaningless, so the guard refuses rather than freeing
    // a row whose real invoice may be sitting in the other customer's ledger.
    const cleared = await writeUnderParentLocks(db, input.kind, parked, auditEvent(input, parked, "cleared", reason, {}), (delegate) => delegate.updateMany({
        where: { id: parked.id, qbInvoiceId: null, qbSyncError: parked.marker },
        data: { qbSyncError: null },
    }));
    if (!cleared.ok) return cleared.refused;
    return { ok: true, outcome: "cleared", message: "Cleared — QuickBooks has nothing for this, so it can be sent again." };
}

/**
 * Run this resolver's ONE write inside the canonical money-path transaction.
 *
 * The child CAS (`issuanceWhere` + the marker + a null `qbInvoiceId`) pins
 * every column that lives on the parked row itself. It cannot pin the two
 * inputs that live on parent rows — `Client.qbCustomerId` and, on the milestone
 * rail, `Invoice.taxRate` — and the marker does not cover them either: it
 * records what they were when the create ran and is never rewritten when they
 * move. So between the read that decided this resolve and the write that
 * commits it, a client could be re-pointed at a different QuickBooks customer,
 * or an invoice's tax rate edited, and the CAS would still match.
 *
 * This closes that window the same way every other money path does:
 *
 *   1. `withTxRetry` + `$transaction`, so a deadlock re-runs cleanly.
 *   2. `lockMoneyParents` in the canonical Estimate → Invoice → Client order,
 *      so this cannot deadlock against a settle or a reprice running
 *      concurrently. The Client id is not known until the Invoice has been
 *      read, so the Client lock is taken as a third step once it is — still in
 *      the canonical direction.
 *   3. RE-READ the parent state under those locks and recompute the issuance
 *      hash from it. Any divergence from what the marker was written against
 *      aborts with `mismatch` and writes nothing.
 *   4. Re-assert the customer mapping as a compare-and-set immediately before
 *      the child write, so a writer that ignored the lock order is caught by a
 *      value comparison instead of being trusted.
 *   5. Only then the child CAS.
 *
 * Locking the Invoice does NOT lock its Client: Postgres takes no transitive
 * row locks through a foreign key, so reading `Invoice.client.qbCustomerId`
 * left `resolveCustomerAndItem` free to re-point the client between step 3 and
 * step 5 — the recovery then linked (or released) a row against a customer it
 * no longer bills. Steps 2–4 are what close that window.
 *
 * Both rails go through here — the milestone rail and the progress-billing
 * rail — and so do both outcomes, the link and the clear.
 */
async function writeUnderParentLocks(
    db: NonNullable<ResolveAmbiguousCreateDeps["db"]>,
    kind: AmbiguousCreateKind,
    parked: ParkedRow,
    /**
     * The audit row, committed with the write or not at all. A human override
     * that lands with no record of who made it, or why, is not reviewable
     * afterwards — and the row it changed is a money row.
     */
    auditInput: AutomationEventInput,
    write: (delegate: { updateMany(args: any): Promise<{ count: number }> }) => Promise<{ count: number }>,
): Promise<{ ok: true } | { ok: false; refused: ResolveAmbiguousCreateResult }> {
    const changed: ResolveAmbiguousCreateResult = {
        ok: false,
        refusal: "changed",
        message: "This changed while it was being resolved. Refresh and look again.",
    };
    return withTxRetry(() => db.$transaction(async (tx) => {
        // Canonical order: Estimate → Invoice → Client → child rows.
        // `tx` is the narrow seam shape above; lockMoneyParents only uses its
        // `$queryRaw`, which that shape declares.
        await lockMoneyParents(tx as any, { estimateId: parked.estimateId, invoiceId: parked.invoiceId });

        // A parked row with no parent invoice cannot be verified at all — the
        // customer and the tax rate both hang off it. Fail closed rather than
        // treating "nothing to read" as "nothing changed".
        if (!parked.invoiceId) {
            return { ok: false as const, refused: mismatchRefusal(parked, "its invoice is missing") };
        }
        const parent = await tx.invoice.findUnique({
            where: { id: parked.invoiceId },
            // `clientId` — the scalar, not the `client` relation. The customer
            // id is read from the CLIENT ROW, after that row has been locked;
            // pulling it through this relation is the read that took no lock.
            select: { taxRate: true, clientId: true },
        });
        if (!parent) {
            return { ok: false as const, refused: mismatchRefusal(parked, "its invoice is missing") };
        }
        // Non-null in the schema, so this is the "somebody made it nullable"
        // guard: an unlockable client is an unverifiable customer.
        if (!parent.clientId) {
            return { ok: false as const, refused: mismatchRefusal(parked, "its client is missing") };
        }
        // Third canonical lock. FOR SHARE: this transaction only READS the
        // mapping, and a concurrent remap takes FOR UPDATE, so the two
        // serialize — the remap either waits for this resolve to commit, or
        // commits first and is seen by the read below.
        await lockClientRow(tx as any, parent.clientId, "share");
        const client = await tx.client.findUnique({
            where: { id: parent.clientId },
            select: { qbCustomerId: true },
        });
        if (!client) {
            return { ok: false as const, refused: mismatchRefusal(parked, "its client is missing") };
        }
        const parentState: ParentIssuanceState = {
            customerId: client.qbCustomerId ?? null,
            invoiceTaxRate: parent.taxRate,
        };
        // The customer the row bills RIGHT NOW, under the lock, must still be
        // the one the create POST addressed.
        if (parentState.customerId !== parked.identity?.customerId) {
            return {
                ok: false as const,
                refused: mismatchRefusal(
                    parked,
                    `it now bills QuickBooks customer ${parentState.customerId ?? "nobody"} instead of ${parked.identity?.customerId ?? "the recorded customer"}`,
                ),
            };
        }
        // And the whole money state, recomputed from those locked parent
        // values, must still hash to what the marker recorded. This is what
        // catches an invoice tax-rate edit: it changes the milestone's tax
        // allocation without touching a single column the child CAS pins.
        if (parked.identity?.issuanceHash && parked.identity.issuanceHash !== parked.issuanceHashWith(parentState)) {
            return {
                ok: false as const,
                refused: mismatchRefusal(parked, "the money it was issued for has changed on its parent invoice (its tax rate or billing customer)"),
            };
        }

        // Belt and braces, immediately before the child write: the customer
        // mapping is re-asserted as a compare-and-set against the value this
        // transaction just read. The FOR SHARE lock already makes it stable
        // against every writer that takes the canonical lock; this catches one
        // that does not, by comparing the value rather than trusting the lock.
        if (!(await clientCustomerStillMatches(tx as any, parent.clientId, parentState.customerId))) {
            return {
                ok: false as const,
                refused: mismatchRefusal(parked, "its QuickBooks customer was re-pointed while this was being resolved"),
            };
        }

        const delegate = kind === "milestone" ? tx.paymentSchedule : tx.progressBilling;
        const written = await write(delegate);
        if (written.count !== 1) return { ok: false as const, refused: changed };
        // Same transaction, and it THROWS. The write above is a human decision
        // about money made against evidence only that human saw; committing it
        // with a best-effort log means a failed insert leaves a row that changed
        // state with no author and no reason. Rolling both back is the honest
        // outcome — the operator sees an error and can decide again.
        await logAutomationEventInTx(tx, auditInput);
        return { ok: true as const };
    }));
}

/** One shape for every "the parent state moved under us" refusal. */
function mismatchRefusal(parked: ParkedRow, what: string): ResolveAmbiguousCreateResult {
    return {
        ok: false,
        refusal: "mismatch",
        message:
            `${parked.code} changed while it was being resolved — ${what}. Nothing was changed here; ` +
            `check invoice ${parked.identity?.docNumber ?? parked.code} in QuickBooks and try again.`,
    };
}

async function loadParkedRow(db: any, kind: AmbiguousCreateKind, id: string): Promise<ParkedRow | null> {
    // NOTE what is NOT selected: the sibling milestone order and the project
    // name. Neither is used any more — the identity comes off the marker, and
    // reading them here at all would invite recomputing it.
    // What IS selected beyond that: the money columns the create hashed
    // (status/amount/name/dueDate/qbPaymentId, or status/subtotal/total/
    // description). Those are recomputed here, not read off the marker — the
    // whole point is to compare the marker's snapshot against the row NOW.
    if (kind === "milestone") {
        const row = await db.paymentSchedule.findUnique({
            where: { id },
            select: {
                id: true, name: true, qbInvoiceId: true, qbSyncError: true, invoiceId: true,
                status: true, amount: true, dueDate: true, qbPaymentId: true,
                // The tax allocation the create actually sent is not a stored
                // column — it prefers these two and otherwise derives from the
                // invoice's rate, so all three have to be read to recompute the
                // same split (milestoneTaxSplit).
                pretaxAmount: true, taxAmount: true,
                invoice: {
                    select: {
                        code: true, projectId: true, taxRate: true, estimateId: true,
                        // Who this row bills in QuickBooks TODAY.
                        client: { select: { qbCustomerId: true } },
                    },
                },
            },
        });
        if (!row) return null;
        const customerId = row.invoice?.client?.qbCustomerId ?? null;
        // ONE definition of "the hash of this row's money state", parameterised
        // by the parent values — used both for the pre-flight comparison below
        // and, with values re-read under the money locks, for the guard that
        // actually gates the write.
        const issuanceHashWith = (parent: ParentIssuanceState) => milestoneIssuanceHash({
            status: row.status ?? null,
            amount: row.amount,
            dueDate: row.dueDate ?? null,
            qbPaymentId: row.qbPaymentId ?? null,
            tax: milestoneTaxSplit({
                pretaxAmount: row.pretaxAmount,
                taxAmount: row.taxAmount,
                amount: row.amount,
                invoiceTaxRate: parent.invoiceTaxRate,
            }),
            customerId: parent.customerId,
        });
        return {
            id: row.id,
            code: row.name || row.invoice?.code || row.id,
            ...parkedIdentity(row),
            issuanceHashWith,
            currentIssuanceHash: issuanceHashWith({ customerId, invoiceTaxRate: row.invoice?.taxRate }),
            // The tax line createQBMilestoneInvoice sent, or $0 when it sent
            // none — the value the candidate invoice's own TotalTax must match.
            expectedTaxAmount: milestoneTaxSplit({
                pretaxAmount: row.pretaxAmount,
                taxAmount: row.taxAmount,
                amount: row.amount,
                invoiceTaxRate: row.invoice?.taxRate,
            })?.taxAmount ?? 0,
            issuanceWhere: {
                status: row.status,
                amount: row.amount,
                dueDate: row.dueDate,
                qbPaymentId: row.qbPaymentId,
                // The tax columns are pinned too, for the same reason the
                // amount is: the hash comparison is a read taken before the
                // link write, so a tax edit landing in between would otherwise
                // still be linked.
                //
                // `invoice.taxRate` and the client's customer id live on OTHER
                // tables and cannot go in this `updateMany` where. They are NOT
                // covered by the marker string either — a previous version of
                // this comment claimed they were, and that was simply false:
                // the marker records what they were when the create ran and is
                // never rewritten when they change, so pinning it proves
                // nothing about them. They are covered by the write
                // transaction, which locks Estimate → Invoice and re-reads both
                // under those locks before this CAS runs.
                pretaxAmount: row.pretaxAmount,
                taxAmount: row.taxAmount,
            },
            fingerprint: ambiguousCreateFingerprint(row),
            projectId: row.invoice?.projectId ?? null,
            invoiceId: row.invoiceId ?? null,
            estimateId: row.invoice?.estimateId ?? null,
            customerId,
        };
    }
    const row = await db.progressBilling.findUnique({
        where: { id },
        select: {
            id: true, code: true, qbInvoiceId: true, qbSyncError: true, invoiceId: true,
            // `description` is a payload field on this rail (it is the QuickBooks
            // line Description, and the ONLY thing updateProgressBillingCore can
            // edit), so the hash covers it and the guard has to read it.
            status: true, subtotal: true, total: true, taxAmount: true, description: true,
            invoice: {
                select: {
                    code: true, projectId: true, estimateId: true,
                    client: { select: { qbCustomerId: true } },
                },
            },
        },
    });
    if (!row) return null;
    const customerId = row.invoice?.client?.qbCustomerId ?? null;
    // Same parameterisation as the milestone rail. The billing's tax lives in
    // its own `taxAmount` column (pinned by the CAS), so only the customer
    // moves with the parent — but the shape is shared so neither rail can grow
    // a private copy of the rule.
    const issuanceHashWith = (parent: ParentIssuanceState) => progressBillingIssuanceHash({
        status: row.status ?? null,
        subtotal: row.subtotal,
        total: row.total,
        taxAmount: row.taxAmount,
        description: row.description ?? null,
        customerId: parent.customerId,
    });
    return {
        id: row.id,
        code: row.code,
        ...parkedIdentity(row),
        issuanceHashWith,
        currentIssuanceHash: issuanceHashWith({ customerId, invoiceTaxRate: null }),
        // stageProgressBilling sends `{ preTaxAmount: subtotal, taxAmount }`
        // only when taxAmount > 0, so a non-positive column means the payload
        // carried no tax line at all.
        expectedTaxAmount: toNum(row.taxAmount) > 0 ? toNum(row.taxAmount) : 0,
        issuanceWhere: {
            status: row.status,
            subtotal: row.subtotal,
            total: row.total,
            taxAmount: row.taxAmount,
            description: row.description,
        },
        fingerprint: ambiguousCreateFingerprint(row),
        projectId: row.invoice?.projectId ?? null,
        invoiceId: row.invoiceId ?? null,
        estimateId: row.invoice?.estimateId ?? null,
        customerId,
    };
}

/**
 * The marker this row is parked by, and the identity it carries.
 *
 * `marker: ""` when the row is not parked at all (including a row that already
 * has a qbInvoiceId — there is nothing ambiguous about a linked row).
 */
function parkedIdentity(row: { qbSyncError: string | null; qbInvoiceId: string | null }): {
    marker: string;
    identity: CreateIdentity | null;
    kind: string | null;
    atMs: number | null;
} {
    if (row.qbInvoiceId) return { marker: "", identity: null, kind: null, atMs: null };
    const parsed = parseCreateMarker(row.qbSyncError);
    if (!parsed) return { marker: "", identity: null, kind: null, atMs: null };
    return { marker: row.qbSyncError as string, identity: parsed.identity, kind: parsed.kind, atMs: parsed.atMs };
}

/**
 * Re-exported from the client-safe marker module, where the UI that has to
 * enforce the same bound can import it without pulling a server module into
 * the browser bundle. Two copies of this number is how a note the form
 * accepts gets rejected by the action that receives it.
 */
export { RESOLVE_REASON_MAX_LEN } from "./qbo-create-markers";

/** Enough marker to recognise, not enough to crowd out the rest of the row. */
export const MARKER_PREVIEW_LEN = 200;

/**
 * A stable, short stand-in for the full marker.
 *
 * Not a security boundary — it exists so two audit rows can be compared, and
 * so a row can be matched back to the marker it was decided against, without
 * carrying hundreds of characters of it into every event.
 */
export function markerDigest(marker: string): string {
    return createHash("sha256").update(marker).digest("hex").slice(0, 16);
}

/**
 * The audit row for one human override, as data.
 *
 * Pure, and built BEFORE the transaction opens, so the write inside the
 * transaction is one insert and nothing that could throw for a reason other
 * than the insert failing.
 */
function auditEvent(
    input: ResolveAmbiguousCreateInput,
    parked: ParkedRow,
    outcome: "linked" | "cleared",
    reason: string,
    extra: Record<string, unknown>,
): AutomationEventInput {
    return {
        kind: "qbo-payments-sync",
        status: "ok",
        reason: `ambiguous-create-${outcome}`,
        source: "ambiguous-create-resolve",
        docNumber: parked.identity?.docNumber ?? parked.code,
        detail: {
            kind: input.kind,
            rowId: parked.id,
            // The marker is the biggest field here by a wide margin — a DocNumber,
            // a PrivateNote, a hash, a realm and a customer id — and none of it is
            // information this record needs in full: the identity it carries is
            // already spelled out in `docNumber` above and in `extra`. What the
            // audit actually needs is to be able to say "this decision was made
            // against THAT marker", which a digest answers exactly, plus enough
            // prefix for a human to recognise it at a glance.
            markerHash: markerDigest(parked.marker),
            markerPreview: parked.marker.slice(0, MARKER_PREVIEW_LEN),
            decision: input.decision,
            operatorReason: reason,
            actorId: input.actor.id ?? null,
            actorEmail: input.actor.email ?? null,
            actorRole: input.actor.role,
            ...extra,
        },
    };
}
