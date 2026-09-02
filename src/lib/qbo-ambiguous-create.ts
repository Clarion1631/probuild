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
import { canResolveAmbiguousCreate } from "./access-rules";
import {
    createRouteDeadline,
    isQBTimeoutError,
    isQboConnectionFailure,
    findQBInvoicesByDocNumber,
    type QBInvoiceMatch,
    type QBTokens,
    type RouteDeadline,
} from "./quickbooks";
import {
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    PAYLINK_PENDING_MARKER,
    isBlockedByAmbiguousCreate,
    milestoneDocNumber,
    milestonePrivateNote,
    getFreshQBTokens,
} from "./quickbooks-payments";
import { progressBillingPrivateNote } from "./progress-billing";

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
    | "stale"
    | "none-found"
    | "multiple-matches"
    | "quickbooks-unreachable"
    | "changed"
    | "invalid";

export type ResolveAmbiguousCreateResult =
    | { ok: true; outcome: "linked"; qbInvoiceId: string; message: string }
    | { ok: true; outcome: "cleared"; message: string }
    | { ok: false; refusal: AmbiguousCreateRefusal; message: string; candidates?: { qbInvoiceId: string; total: number }[] };

export interface AmbiguousCreateActor {
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
    docNumber: string;
    privateNote: string;
    marker: string;
    fingerprint: string;
    projectId: string | null;
    invoiceId: string | null;
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
    if (!parked.marker) {
        return {
            ok: false,
            refusal: "not-ambiguous",
            message: "This one is not waiting on a QuickBooks answer — nothing to resolve.",
        };
    }
    if (parked.fingerprint !== input.expectedState) {
        return {
            ok: false,
            refusal: "stale",
            message: "This changed since the page was loaded (someone may have already resolved it). Refresh and look again.",
        };
    }

    // Bounded: an unreachable QuickBooks must refuse quickly, not hang the
    // action to the platform ceiling — the original defect this PR exists for.
    const deadline = deps?.deadline ?? createRouteDeadline(RESOLVE_AMBIGUOUS_BUDGET_MS);
    let matches: QBInvoiceMatch[];
    try {
        const tokens = await getTokens(deadline);
        const found = await findInvoices(tokens, parked.docNumber, deadline);
        // DocNumber is not unique in QuickBooks (duplicates can be enabled, and
        // the number is only 21 characters), so the PrivateNote is what says an
        // invoice is OURS.
        matches = found.filter((inv) => (inv.privateNote || "").trim() === parked.privateNote);
    } catch (error) {
        // Every failure refuses. A timeout, a 5xx and a plain refusal all leave
        // the same question unanswered — whether an invoice is sitting there —
        // and the only safe answer to "I don't know" is to write nothing.
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
            message: `QuickBooks holds ${matches.length} invoices for ${parked.docNumber}. Delete the extras in QuickBooks first — nothing was changed here.`,
            candidates: matches.map((m) => ({ qbInvoiceId: m.id, total: m.total })),
        };
    }

    const delegate = input.kind === "milestone" ? db.paymentSchedule : db.progressBilling;

    if (matches.length === 1) {
        // QuickBooks is the truth: an invoice exists, whatever the operator
        // asserted. Adopt it. PAYLINK_PENDING_MARKER rather than null, because
        // we have the id but not the pay link — the maintenance sweep fetches it.
        const qbInvoiceId = matches[0].id;
        const linked = await delegate.updateMany({
            where: { id: parked.id, qbInvoiceId: null, qbSyncError: parked.marker },
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
            message: `Linked to the QuickBooks invoice that was already there (${parked.docNumber}).`,
        };
    }

    // Zero matches. Clearing the marker makes the row freely re-sendable, so it
    // takes an explicit human assertion — a wrong "none" bills twice.
    if (input.decision !== "confirmed-none") {
        return {
            ok: false,
            refusal: "none-found",
            message: `No QuickBooks invoice matches ${parked.docNumber}. If you have checked QuickBooks yourself, confirm none exists to clear this and send again.`,
        };
    }
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
    if (kind === "milestone") {
        const row = await db.paymentSchedule.findUnique({
            where: { id },
            select: {
                id: true, name: true, qbInvoiceId: true, qbSyncError: true, invoiceId: true,
                invoice: {
                    select: {
                        code: true, projectId: true,
                        project: { select: { name: true } },
                        payments: { select: { id: true }, orderBy: { createdAt: "asc" } },
                    },
                },
            },
        });
        if (!row) return null;
        const invoiceCode: string = row.invoice?.code ?? "";
        const projectName: string = row.invoice?.project?.name || "Project";
        const position = (row.invoice?.payments ?? []).findIndex((p: { id: string }) => p.id === row.id) + 1 || 1;
        return {
            id: row.id,
            code: invoiceCode,
            docNumber: milestoneDocNumber(invoiceCode, position),
            privateNote: milestonePrivateNote(invoiceCode, row.name, projectName),
            marker: blockingMarker(row),
            fingerprint: ambiguousCreateFingerprint(row),
            projectId: row.invoice?.projectId ?? null,
            invoiceId: row.invoiceId ?? null,
        };
    }
    const row = await db.progressBilling.findUnique({
        where: { id },
        select: {
            id: true, code: true, qbInvoiceId: true, qbSyncError: true, invoiceId: true,
            invoice: { select: { code: true, projectId: true } },
        },
    });
    if (!row) return null;
    return {
        id: row.id,
        code: row.code,
        docNumber: row.code,
        privateNote: progressBillingPrivateNote(row.invoice?.code ?? "", row.code),
        marker: blockingMarker(row),
        fingerprint: ambiguousCreateFingerprint(row),
        projectId: row.invoice?.projectId ?? null,
        invoiceId: row.invoiceId ?? null,
    };
}

/** "" when the row is not parked at all. */
function blockingMarker(row: { qbSyncError: string | null; qbInvoiceId: string | null }): string {
    if (row.qbInvoiceId) return "";
    if (!isBlockedByAmbiguousCreate(row)) return "";
    return row.qbSyncError === CREATE_IN_FLIGHT_MARKER ? CREATE_IN_FLIGHT_MARKER : AMBIGUOUS_CREATE_MARKER;
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
        docNumber: parked.docNumber,
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
