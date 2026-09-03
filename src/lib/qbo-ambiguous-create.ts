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
import { prisma } from "./prisma";
import { logAutomationEvent } from "./automation-events";
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
import type { CreateIdentity } from "./qbo-create-markers";
import { milestoneIssuanceHash, progressBillingIssuanceHash, milestoneTaxSplit } from "./qbo-issuance";

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
    | { ok: false; refusal: AmbiguousCreateRefusal; message: string; candidates?: { qbInvoiceId: string; total: number }[] };

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

/** Test seam: the QBO lookup and the two table delegates. */
export interface ResolveAmbiguousCreateDeps {
    db?: {
        paymentSchedule: { findUnique(args: any): Promise<any>; updateMany(args: any): Promise<{ count: number }> };
        progressBilling: { findUnique(args: any): Promise<any>; updateMany(args: any): Promise<{ count: number }> };
    };
    getTokens?: (deadline: RouteDeadline) => Promise<QBTokens>;
    findInvoices?: (tokens: QBTokens, docNumber: string, deadline: RouteDeadline) => Promise<QBInvoiceMatch[]>;
    logEvent?: typeof logAutomationEvent;
    deadline?: RouteDeadline;
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
    const db = deps?.db ?? prisma;
    const logEvent = deps?.logEvent ?? logAutomationEvent;
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

    const delegate = input.kind === "milestone" ? db.paymentSchedule : db.progressBilling;

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
        if (
            parked.identity.expectedTotal != null
            && Math.abs(matches[0].total - parked.identity.expectedTotal) > 0.005
        ) {
            return {
                ok: false,
                refusal: "mismatch",
                message:
                    `A QuickBooks invoice matching ${parked.identity.docNumber} exists, but its total ($${matches[0].total.toFixed(2)}) ` +
                    `does not match what ${parked.code} expected ($${parked.identity.expectedTotal.toFixed(2)}) — check invoice ${parked.identity.docNumber} ` +
                    `in QuickBooks before doing anything else with this row. Nothing was changed here.`,
            };
        }
        // QuickBooks is the truth: an invoice exists, whatever the operator
        // asserted. Adopt it. PAYLINK_PENDING_MARKER rather than null, because
        // we have the id but not the pay link — the maintenance sweep fetches it.
        const qbInvoiceId = matches[0].id;
        const linked = await delegate.updateMany({
            // The issuance columns are pinned here as well as hashed above: the
            // hash check is a read taken before this write, so without them a
            // settle or a reprice landing in between would still be linked.
            where: { id: parked.id, qbInvoiceId: null, qbSyncError: parked.marker, ...parked.issuanceWhere },
            data: {
                qbInvoiceId,
                qbSyncedAt: new Date(),
                qbSyncError: PAYLINK_PENDING_MARKER,
                ...(input.kind === "progressBilling" ? { status: "Staged" } : {}),
            },
        });
        if (linked.count !== 1) {
            return { ok: false, refusal: "changed", message: "This changed while it was being resolved. Refresh and look again." };
        }
        await audit(logEvent, input, parked, "linked", reason, { qbInvoiceId });
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
    const cleared = await delegate.updateMany({
        where: { id: parked.id, qbInvoiceId: null, qbSyncError: parked.marker },
        data: { qbSyncError: null },
    });
    if (cleared.count !== 1) {
        return { ok: false, refusal: "changed", message: "This changed while it was being resolved. Refresh and look again." };
    }
    await audit(logEvent, input, parked, "cleared", reason, {});
    return { ok: true, outcome: "cleared", message: "Cleared — QuickBooks has nothing for this, so it can be sent again." };
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
                        code: true, projectId: true, taxRate: true,
                        // Who this row bills in QuickBooks TODAY.
                        client: { select: { qbCustomerId: true } },
                    },
                },
            },
        });
        if (!row) return null;
        const customerId = row.invoice?.client?.qbCustomerId ?? null;
        return {
            id: row.id,
            code: row.name || row.invoice?.code || row.id,
            ...parkedIdentity(row),
            currentIssuanceHash: milestoneIssuanceHash({
                status: row.status ?? null,
                amount: row.amount,
                dueDate: row.dueDate ?? null,
                qbPaymentId: row.qbPaymentId ?? null,
                tax: milestoneTaxSplit({
                    pretaxAmount: row.pretaxAmount,
                    taxAmount: row.taxAmount,
                    amount: row.amount,
                    invoiceTaxRate: row.invoice?.taxRate,
                }),
                customerId,
            }),
            issuanceWhere: {
                status: row.status,
                amount: row.amount,
                dueDate: row.dueDate,
                qbPaymentId: row.qbPaymentId,
                // The tax columns are pinned too, for the same reason the
                // amount is: the hash comparison is a read taken before the
                // link write, so a tax edit landing in between would otherwise
                // still be linked. `invoice.taxRate` and the client's customer
                // id live on OTHER tables and cannot go in this `updateMany`
                // where — they are covered instead by the marker string itself,
                // which the CAS pins and which now carries both the issuance
                // hash and the realm/customer identity.
                pretaxAmount: row.pretaxAmount,
                taxAmount: row.taxAmount,
            },
            fingerprint: ambiguousCreateFingerprint(row),
            projectId: row.invoice?.projectId ?? null,
            invoiceId: row.invoiceId ?? null,
            customerId,
        };
    }
    const row = await db.progressBilling.findUnique({
        where: { id },
        select: {
            id: true, code: true, qbInvoiceId: true, qbSyncError: true, invoiceId: true,
            status: true, subtotal: true, total: true, taxAmount: true,
            invoice: {
                select: {
                    code: true, projectId: true,
                    client: { select: { qbCustomerId: true } },
                },
            },
        },
    });
    if (!row) return null;
    const customerId = row.invoice?.client?.qbCustomerId ?? null;
    return {
        id: row.id,
        code: row.code,
        ...parkedIdentity(row),
        currentIssuanceHash: progressBillingIssuanceHash({
            status: row.status ?? null,
            subtotal: row.subtotal,
            total: row.total,
            taxAmount: row.taxAmount,
            customerId,
        }),
        issuanceWhere: {
            status: row.status,
            subtotal: row.subtotal,
            total: row.total,
            taxAmount: row.taxAmount,
        },
        fingerprint: ambiguousCreateFingerprint(row),
        projectId: row.invoice?.projectId ?? null,
        invoiceId: row.invoiceId ?? null,
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

async function audit(
    logEvent: typeof logAutomationEvent,
    input: ResolveAmbiguousCreateInput,
    parked: ParkedRow,
    outcome: "linked" | "cleared",
    reason: string,
    extra: Record<string, unknown>,
) {
    await logEvent({
        kind: "qbo-payments-sync",
        status: "ok",
        reason: `ambiguous-create-${outcome}`,
        source: "ambiguous-create-resolve",
        docNumber: parked.identity?.docNumber ?? parked.code,
        detail: {
            kind: input.kind,
            rowId: parked.id,
            marker: parked.marker,
            decision: input.decision,
            operatorReason: reason,
            actorId: input.actor.id ?? null,
            actorEmail: input.actor.email ?? null,
            actorRole: input.actor.role,
            ...extra,
        },
    });
}
