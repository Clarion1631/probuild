/**
 * QuickBooks Payments rail.
 *
 * Each ProBuild payment milestone (PaymentSchedule) maps to ONE QuickBooks
 * invoice with QuickBooks Payments enabled, so the customer pays large draws
 * on Intuit's hosted page (card/ACH) instead of Stripe. Money recorded in
 * QuickBooks — including manual checks Vanessa applies against the QBO
 * invoice from the Washington Trust bank feed — flows back into ProBuild via
 * `syncQuickBooksPayments()` (hourly cron + on-view refresh), which marks the
 * milestone Paid exactly like the Stripe webhook does. That keeps ProBuild,
 * QuickBooks, and the bank in sync, and keeps the sales-tax report truthful.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { withTxRetry, lockMoneyParents, lockClientRow } from "./tx-retry";
import { enqueueMilestonePaid, drainPaymentNotifications } from "./payment-outbox";
import { BANK_DEPOSIT_SOURCE, MONEY_IN_FLIGHT_STATUSES } from "./deposit-sweep";
import { toNum, deriveInvoiceTaxFields } from "./prisma-helpers";
import { getQBSettings, saveQBSettings } from "./integration-store";
import { logAutomationEvent } from "./automation-events";
import { createHash } from "node:crypto";
import {
    type QBTokens,
    refreshQBToken,
    isQBTimeoutError,
    isQBBudgetExhaustedError,
    createRouteDeadline,
    remainingBudgetMs,
    isBudgetExhausted,
    type RouteDeadline,
    qbQuery,
    escapeQBString,
    isQboConnectionFailure,
    isRetryableQboError,
    isQBAmbiguousDocumentCreateError,
    isQboMalformedResponseError,
    qboHttpStatus,
    isQboReconnectRequired,
    QBTokenStrandedError,
    isQBTokenStrandedError,
    QboRetryableError,
    type QBInvoiceProbe,
    ensureQBCustomer,
    ensureQBServiceItem,
    createQBMilestoneInvoice,
    getQBInvoicePaymentLink,
    getQBInvoiceStatus,
    probeQBInvoice,
    getQBPayment,
    deleteQBInvoice,
    QB_DOC_NUMBER_MAX_LEN,
    canonicalPrivateNote,
} from "./quickbooks";
import {
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    PAYLINK_PENDING_MARKER,
    composeCreateMarker,
    isBlockedByAmbiguousCreate,
} from "./qbo-create-markers";
import { milestoneIssuanceHash, milestoneTaxSplit } from "./qbo-issuance";
import { isPendingDeletion, PENDING_DELETION_MARKER } from "./qbo-create-markers";
import { isE2eQboMockEnabled, MOCK_QB_TOKENS } from "./quickbooks-mock";
// One definition of the reconnect-QuickBooks reason string, shared with the
// health probe that counts it. A second literal here is how the row loop and
// the preflight drifted apart in the first place.
import { QBO_AUTH_EVENT_REASON as QBO_AUTH_SYNC_REASON } from "./pipeline-health";
import type { QBSyncIssue } from "./payment-notifications";

/**
 * Intuit rotated the refresh token but we could not store the replacement.
 * Distinct from a refresh failure: the OLD token is already spent, so there is
 * no safe fallback and the connection needs human attention.
 */
export class QBTokenPersistenceError extends Error {
    name = "QBTokenPersistenceError";
    constructor() {
        super("QuickBooks token was rotated but could not be saved; reconnect QuickBooks");
    }
}

export class QBNotConnectedError extends Error {
    constructor() {
        super("QuickBooks is not connected (Settings → Integrations → QuickBooks)");
        this.name = "QBNotConnectedError";
    }
}

/** Name-based, for the same cross-module-identity reason as isQBTimeoutError. */
export function isQBNotConnectedError(error: unknown): error is QBNotConnectedError {
    return (
        error instanceof QBNotConnectedError ||
        (error instanceof Error && error.name === "QBNotConnectedError")
    );
}

/** Fresh tokens, persisting the rotated refresh token. Throws QBNotConnectedError. */
export async function getFreshQBTokens(deadline?: RouteDeadline): Promise<QBTokens> {
    // E2E_QBO_MOCK (deposit-ingest hermeticity) — see quickbooks-mock.ts. The mock
    // replaces the NETWORK, not the CONNECTION STATE: with no connected settings row
    // it still throws QBNotConnectedError, so fail-closed specs (e.g.
    // milestone-payment-request) keep their "rail is down" premise; specs that need
    // QuickBooks seed a connected row (see e2e/deposit-ingest.spec.ts beforeAll).
    if (isE2eQboMockEnabled()) {
        const qb = await getQBSettings();
        if (!qb.connected) throw new QBNotConnectedError();
        return MOCK_QB_TOKENS;
    }
    const qb = await getQBSettings();
    if (!qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new QBNotConnectedError();
    }
    return refreshTokensOrFallBack(
        { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId },
        (token) => refreshQBToken(token, deadline),
    );
}

/**
 * The refresh + fallback policy, split out so the CATCH can be tested without a
 * database (only the network boundary is injectable; the defaults here are the
 * real ones getFreshQBTokens uses).
 *
 * A refresh that fails for an ordinary reason may still leave the OLD access
 * token usable, so that fallback stays. A TIMEOUT is different and must
 * propagate: swallowing it handed the caller a possibly-stale token and let it
 * spend another full QBO deadline on the next request, which is how a QBO
 * outage still ate the route's whole 60s ceiling — exactly the hang the
 * per-request deadline was added to stop. The caller turns it into a 503.
 */
export async function refreshTokensOrFallBack(
    qb: { accessToken: string; refreshToken: string; realmId: string },
    refresh: typeof refreshQBToken = refreshQBToken,
    save: typeof saveQBSettings = saveQBSettings,
): Promise<QBTokens> {
    let fresh: { accessToken: string; refreshToken: string };
    try {
        fresh = await refresh(qb.refreshToken);
    } catch (error) {
        if (isQBTimeoutError(error)) throw error;

        // Falling back is only safe when Intuit EXPLICITLY rejected the
        // exchange — a 400/401 (invalid_grant and friends) means it processed
        // the request and refused, so nothing rotated and the stored access
        // token may still be good.
        //
        // Everything else is ambiguous and must strand: a 5xx says Intuit
        // broke somewhere in its own pipeline and may well have rotated before
        // failing, and a reset socket, TLS failure, truncated or malformed body
        // says we never learned the outcome at all. Treating those as "refused"
        // hands back a pair that could already be spent, reporting a healthy
        // connection sitting on a dead token.
        const status = qboHttpStatus(error);
        const explicitlyRejected = status === 400 || status === 401;
        if (!explicitlyRejected) {
            throw new QBTokenStrandedError(
                status !== null ? `HTTP ${status}` : error instanceof Error ? error.name : "transport failure",
            );
        }
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }

    // A 200 that omits either token is the same ambiguity wearing a different
    // hat: something rotated, and we did not receive what replaced it.
    const usable = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
    if (!usable(fresh.accessToken) || !usable(fresh.refreshToken)) {
        throw new QBTokenStrandedError("refresh response was missing a token");
    }

    // A SAVE failure is a different animal and must never share the catch
    // above. By this point Intuit has already rotated: the old refresh token is
    // spent, so returning the stale pair would report a healthy connection
    // while quietly stranding the integration until someone reconnects by hand.
    // Retry once (a transient DB blip is the common case), then surface it.
    try {
        await save({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
    } catch (first) {
        try {
            await save({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        } catch {
            console.error(
                "QBO token rotated but could NOT be persisted — reconnect QuickBooks if the next refresh fails",
                first instanceof Error ? first.name : "UnknownError",
            );
            throw new QBTokenPersistenceError();
        }
    }
    return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
}

/**
 * Atomically clear a milestone's QuickBooks link fields. The guard fields
 * (`status`, `qbPaymentId`, and the exact `qbInvoiceId` the caller read) all go
 * in the WHERE, so if a QB settlement lands on this milestone between the
 * caller's read and this write, the claim matches 0 rows and the settle wins —
 * we never strip QB fields off a now-paid row, and a concurrent re-push (new
 * id) can't be clobbered either.
 *
 * Accepts either a bare `prisma` client or an in-flight `tx` — shared by
 * `breakQBInvoiceLink` (standalone) and `updatePendingMilestoneAmountsCore`
 * (inside its rebalance transaction) so both go through the same claim.
 */
export async function claimQBInvoiceUnlink(
    client: Prisma.TransactionClient,
    scheduleId: string,
    expectedQbInvoiceId: string,
): Promise<boolean> {
    const cleared = await client.paymentSchedule.updateMany({
        where: {
            id: scheduleId,
            status: { not: "Paid" },
            qbPaymentId: null,
            qbInvoiceId: expectedQbInvoiceId,
        },
        data: {
            qbInvoiceId: null,
            qbInvoiceLink: null,
            // qbInvoiceSentAt deliberately survives the unlink: it records that a
            // payment request was emailed (the portal's "due" marker), which stays
            // true even when the QBO invoice behind it is voided and re-staged.
            qbSyncedAt: null,
            // Also clears the ambiguous-create marker: unlinking is the
            // documented way to release a milestone parked by an unknown-outcome
            // create, once a human has checked QuickBooks.
            qbSyncError: null,
        },
    });
    return cleared.count === 1;
}

// Exported for stageProgressBillingToQuickBooksCore (src/lib/progress-billing.ts),
// which needs the same customer/item resolution pushMilestoneToQuickBooks uses.
export async function resolveCustomerAndItem(
    tokens: QBTokens,
    clientId: string,
    deadline?: RouteDeadline,
): Promise<{ customerId: string; itemId: string }> {
    const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true, email: true, qbCustomerId: true },
    });
    if (!client) throw new Error("Client not found");

    // What the mapping said BEFORE the QuickBooks round trip. Everything below
    // is decided against this value, not against a re-read of `client`, because
    // that is the state `ensureQBCustomer` actually answered about.
    const qbCustomerIdBeforeRemote = client.qbCustomerId;
    const customerId = await ensureQBCustomer(tokens, client, deadline);
    if (customerId !== qbCustomerIdBeforeRemote) {
        // Re-pointing a client at another QuickBooks customer is a money-path
        // write: the ambiguous-create recovery decides whether to link or
        // release a parked invoice against exactly this value. It therefore
        // takes the canonical Client lock (see tx-retry.ts) so that decision
        // either happens entirely before this remap or entirely after it,
        // never straddling it. FOR UPDATE, not FOR SHARE — this is the writer.
        //
        // Only the lock-and-write is inside the transaction. `ensureQBCustomer`
        // above is a QuickBooks round trip and must never be held across a row
        // lock.
        //
        // The lock alone was NOT enough. It serialised this write against the
        // resolver, but the write itself was unconditional: the row was read
        // BEFORE the round trip, and whatever landed in that window — another
        // push remapping the same client, an admin repointing it by hand — was
        // silently overwritten with a decision made against state that no longer
        // existed. So the mapping is RE-READ under the lock and the write only
        // lands while it still says what it said before the round trip.
        const verdict = await withTxRetry(() => prisma.$transaction(async (tx) => {
            await lockClientRow(tx, client.id, "update");
            const fresh = await tx.client.findUnique({
                where: { id: client.id },
                select: { qbCustomerId: true },
            });
            // Gone entirely: there is no row to remap and no safe value to write.
            if (!fresh) return "conflict" as const;
            // Somebody already wrote the SAME answer we were about to write.
            // That is not a conflict — it is this exact remap, done once.
            if (fresh.qbCustomerId === customerId) return "already" as const;
            if (fresh.qbCustomerId !== qbCustomerIdBeforeRemote) return "conflict" as const;
            await tx.client.update({ where: { id: client.id }, data: { qbCustomerId: customerId } });
            return "written" as const;
        }));
        // Fail closed. A caller that went ahead here would build its invoice
        // against a customer the database disagrees with, and the marker it
        // writes would fingerprint a mapping nothing can reproduce — which is
        // exactly the state the resolver has to refuse later, after a real
        // invoice already exists in QuickBooks.
        if (verdict === "conflict") throw new QBCustomerRemappedError(client.name || client.id);
    }

    const qb = await getQBSettings();
    let itemId = qb.serviceItemId;
    if (!itemId) {
        itemId = await ensureQBServiceItem(tokens, deadline);
        await saveQBSettings({ serviceItemId: itemId });
    }
    return { customerId, itemId };
}

export interface MilestonePushResult {
    qbInvoiceId: string;
    payLink: string | null;
    qbTotal?: number; // grand total as QBO computed it (drift check vs the milestone)
}

/**
 * Create (or reuse) the QBO invoice for one milestone and return its pay link.
 * Idempotent: a milestone that already has a QBO invoice just refreshes the link.
 */
// The marker vocabulary and the rules that read it live in a PURE module
// (qbo-create-markers.ts) so money guards everywhere — and the invoice editor's
// client bundle — share one definition instead of re-deriving it. Re-exported
// here because this is where every existing caller imports them from.
export {
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    CREATE_IN_FLIGHT_STALE_MS,
    PAYLINK_PENDING_MARKER,
    PENDING_CREATE_MARKERS,
    PENDING_DELETION_MARKER,
    isPendingDeletion,
    composeCreateMarker,
    parseCreateMarker,
    markerKind,
    pendingCreateMarkerWhere,
    isBlockedByAmbiguousCreate,
    isStaleInFlight,
    isQboInvoiceLinkedOrPending,
    ambiguousCreateFingerprint,
    QBResolveRequiredError,
    QBIdentityUnknownError,
} from "./qbo-create-markers";

/**
 * The QuickBooks DocNumber for one milestone: INV-00012-2, the milestone's
 * position within its invoice's schedule. Truncated to Intuit's 21 characters.
 *
 * ONE definition, shared by the push that writes it and by the ambiguous-create
 * resolver that has to look it up again. A second copy would drift and the
 * resolver would quietly stop finding the invoices we create.
 */
export function milestoneDocNumber(invoiceCode: string, position: number): string {
    const suffix = `-${position}`;
    return `${invoiceCode.slice(0, Math.max(1, QB_DOC_NUMBER_MAX_LEN - suffix.length))}${suffix}`;
}

/** The PrivateNote every milestone invoice carries — what proves it is ours. */
export function milestonePrivateNote(invoiceCode: string, scheduleName: string, projectName: string): string {
    return `ProBuild ${invoiceCode} · ${scheduleName} · ${projectName}`;
}

/** The one write the compensation step needs; either rail's delegate satisfies it. */
export interface CompensatableDelegate {
    updateMany(args: any): Promise<{ count: number }>;
}

/**
 * Delete a QuickBooks invoice we created but could not keep, then release the
 * provisional link we wrote for it.
 *
 * Both rails now record `qbInvoiceId` BEFORE the pay-link fetch, so by the time
 * compensation runs the row may already point at the invoice being deleted.
 * Deleting without clearing left the row linked to a document that no longer
 * exists: the payments poller would keep probing it, the portal would offer a
 * dead pay link, and the next send would refuse because the row "already has"
 * an invoice. The clear is CAS-pinned to the exact id we wrote, so a concurrent
 * settle or re-stage that moved the row on wins instead of being trampled.
 *
 * A FAILED delete deliberately keeps the link: the invoice is still out there
 * and collectible, and a row pointing at it is how a human finds it.
 *
 * The pre-link CAS can also lose BEFORE the row ever carried `qbInvoiceId` at
 * all — the row still has it null, only `qbSyncError` holds our in-flight
 * claim. Clearing by `qbInvoiceId` then matches nothing, and a confirmed
 * delete would leave the claim parked forever with no invoice left to explain
 * it. `ownedInFlightMarker`, when supplied, is the fallback: clear by the exact
 * marker THIS caller wrote instead, so the claim is still released.
 *
 * `deleteInvoice()` returning `false` is not a failure: `deleteQBInvoice`
 * (quickbooks.ts) returns `false` for an AUTHORITATIVE 404 — the invoice is
 * already gone, which is exactly the state compensation wants. Only a THROWN
 * error leaves the remote outcome unknown (the delete may or may not have
 * landed), so only that case skips the unlink and reports failure.
 */
export async function compensateAndUnlink(
    delegate: CompensatableDelegate,
    rowId: string,
    qbInvoiceId: string,
    deleteInvoice: () => Promise<boolean>,
    /** Extra columns to restore alongside the link (e.g. a progress billing's status). */
    extraClearData: Record<string, unknown> = {},
    /** The in-flight marker this caller wrote before the create, if any. */
    ownedInFlightMarker?: string,
): Promise<{ deleted: boolean; unlinked: boolean; alreadyAbsent?: boolean }> {
    let alreadyAbsent = false;
    try {
        const result = await deleteInvoice();
        alreadyAbsent = result === false;
    } catch {
        // Thrown: the delete's outcome is genuinely unknown — the remote
        // invoice may still exist. Do not touch the row.
        return { deleted: false, unlinked: false };
    }
    const cleared = await delegate.updateMany({
        where: { id: rowId, qbInvoiceId },
        data: {
            qbInvoiceId: null,
            qbInvoiceLink: null,
            qbSyncedAt: null,
            // The paylink-pending marker goes with it: there is no invoice left
            // for the sweep to fetch a link for.
            qbSyncError: null,
            ...extraClearData,
        },
    }).catch(() => ({ count: 0 }));
    if (cleared.count === 1) return { deleted: true, unlinked: true, alreadyAbsent };
    if (!ownedInFlightMarker) return { deleted: true, unlinked: false, alreadyAbsent };
    // The row never got as far as carrying qbInvoiceId — clear by the marker we
    // own instead, so a confirmed delete still releases the claim.
    const clearedByMarker = await delegate.updateMany({
        where: { id: rowId, qbInvoiceId: null, qbSyncError: ownedInFlightMarker },
        data: {
            qbInvoiceLink: null,
            qbSyncedAt: null,
            qbSyncError: null,
            ...extraClearData,
        },
    }).catch(() => ({ count: 0 }));
    return { deleted: true, unlinked: clearedByMarker.count === 1, alreadyAbsent };
}

/**
 * Did somebody ELSE already finish the link for the very invoice we just
 * created?
 *
 * The final link CAS in `pushMilestoneToQuickBooks` pins `qbSyncError` to the
 * `paylink-pending` marker the pre-pay-link write left behind. That marker is
 * deliberately transient: `sweepPendingPayLinks` fills the pay link and clears
 * it, and so does a CONCURRENT resend taking the already-linked early-return
 * branch at the top of the push (it fetches the link and clears the flag). Both
 * of those finish the row correctly and, in the resend's case, have already
 * returned success for this exact `qbInvoiceId` to their own caller.
 *
 * Before this guard the losing CAS was read as "the milestone was abandoned",
 * and compensation DELETED a live, correct QuickBooks invoice out from under
 * the caller that had just been told it existed. A marker that moved is not
 * divergence; the invoice id is what identifies the outcome.
 *
 * Pure so the interleaving can be tested exactly. `true` means "this row is
 * still the row we issued for, and it points at OUR invoice" — never
 * compensate. Everything else (a different or absent id, a Canceled row, or
 * content that no longer matches what the QBO invoice was built from) is
 * genuine divergence and still compensates, unchanged.
 *
 * Note `status` is only refused for "Canceled". A row that went **Paid** while
 * we were fetching the pay link was settled AGAINST THIS INVOICE — deleting it
 * would destroy a paid QuickBooks document, which is strictly worse than the
 * abandoned-invoice case this compensation exists for.
 */
export function isConcurrentlyFinalizedMilestoneLink(
    current: {
        qbInvoiceId: string | null;
        status: string;
        amount: unknown;
        name: string;
        dueDate: Date | null;
    } | null,
    qbInvoiceId: string,
    issuedFrom: { amount: unknown; name: string; dueDate: Date | null },
): boolean {
    if (!current) return false;
    if (current.qbInvoiceId !== qbInvoiceId) return false;
    if (current.status === "Canceled") return false;
    if (current.name !== issuedFrom.name) return false;
    // Decimal columns never compare with ===; go through the same numeric
    // conversion the create used to build the invoice amount.
    const a = toNum(current.amount as any);
    const b = toNum(issuedFrom.amount as any);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 0.0001) return false;
    const currentDue = current.dueDate ? new Date(current.dueDate).getTime() : null;
    const issuedDue = issuedFrom.dueDate ? new Date(issuedFrom.dueDate).getTime() : null;
    return currentDue === issuedDue;
}

/** One row waiting for its pay link, from either rail. */
export interface PayLinkPendingRow {
    id: string;
    qbInvoiceId: string;
    code: string;
}

export interface PayLinkSweepDelegate {
    findMany(args: any): Promise<any[]>;
    updateMany(args: any): Promise<{ count: number }>;
    /**
     * How many rows currently match the pending-marker filter. Read twice per
     * run — once before the loop, once after — because "the sweep returned" and
     * "the sweep finished the work" are different claims, and only a count
     * taken from the database can tell them apart.
     */
    count(args: any): Promise<number>;
}

/** Per-rail counters, plus the sum the caller actually gates on. */
export interface PayLinkRailCounts {
    milestone: number;
    progressBilling: number;
    total: number;
}

export interface PayLinkSweepDb {
    paymentSchedule: PayLinkSweepDelegate;
    progressBilling: PayLinkSweepDelegate;
}

export interface PayLinkSweepResult {
    checked: number;
    /** A link was fetched and written. */
    repaired: number;
    /** QuickBooks answered, but this invoice has no payment link to offer. */
    noLink: number;
    /** Left for the next run — the sweep stopped, or the CAS lost. */
    skipped: number;
    /**
     * A rail filled its page, so more pending rows may exist than this run
     * looked at. The caller must not report a clean sweep on it.
     */
    truncated?: boolean;
    reason?: string;
    /**
     * Rows that were eligible when this run started and that it never reached.
     *
     * The run's own bookkeeping — eligible-at-start minus rows it actually
     * decided — so it counts everything the pages did not cover as well as
     * everything the budget cut short. Nonzero means the sweep did NOT look at
     * the whole set, whatever else it reports.
     */
    unvisited: PayLinkRailCounts;
    /**
     * Rows still carrying the pending marker when the run ended, counted from
     * the database rather than inferred. Nonzero means there is a milestone or
     * a progress billing whose client still has no pay link — the condition
     * this sweep exists to remove, so a run that leaves any is not clean.
     */
    unresolved: PayLinkRailCounts;
    /** Which rail this run processed first (alternates run to run). */
    railFirst: "milestone" | "progressBilling";
}

/** How many pending rows one sweep will look at, per rail. */
export const PAYLINK_SWEEP_LIMIT = 100;

/**
 * Where the last pay-link sweep stopped, per rail, so the next one CONTINUES.
 *
 * Both rail queries were an UNORDERED `take: 100`. A row whose pay-link read
 * fails for a reason this sweep deliberately leaves alone (the invoice was
 * deleted in QuickBooks, say — the invoice-probe sweep owns that, not this one)
 * keeps its `paylink-pending` marker forever. Once 100 such rows existed, every
 * run fetched the same stuck page and nothing behind it was ever looked at
 * again. Ordering by id makes the page deterministic and the cursor makes the
 * cap a rolling window over the whole set, wrapping to the top when it drains.
 *
 * Separate keys from PAYMENTS_CURSOR_KEYS on purpose: this sweep walks a
 * different set (linked-but-linkless rows) than the payments sync does
 * (unsettled rows), so sharing a cursor would make each skip the other's work.
 */
export const PAYLINK_CURSOR_KEYS = {
    milestones: "qbo-paylink-sweep.cursor.milestones",
    billings: "qbo-paylink-sweep.cursor.billings",
} as const;

/**
 * Which rail this sweep works FIRST, flipped every run.
 *
 * Milestones used to be processed first, always. Under repeated budget
 * exhaustion — the normal state of a backlog — the run died inside the
 * milestone rail every time and progress billings were never reached at all:
 * not a slow rail, a starved one. Alternating is the same fix, and the same
 * key shape, as PAYMENTS_ORDER_KEY on the payments sync.
 */
export const PAYLINK_ORDER_KEY = "qbo-paylink-sweep.order";

/**
 * Finish the work a pay-link timeout left behind, on BOTH rails.
 *
 * `pushMilestoneToQuickBooks` and `stageProgressBillingToQuickBooksCore` link
 * the QBO invoice before fetching its pay link, so a timeout on that second
 * read leaves a correct, linked row whose only missing piece is the convenience
 * link — marked `paylink-pending`. This is what finishes it.
 *
 * Runs under the caller's route budget and stops on any connection-level
 * failure, same rule as every other QBO loop here: the next row would fail the
 * same way at full cost.
 */
export interface PendingDeletionSweepResult {
    checked: number;
    /** Deleted in QuickBooks (or already gone) AND unlinked here. */
    finished: number;
    /** Still linked: QuickBooks refused, or the sweep ran out of budget. */
    stillPending: number;
    reason: string | null;
}

/** The two calls this sweep needs; injectable so a test can drive the real loop. */
export interface PendingDeletionSweepDeps {
    db?: { paymentSchedule: { findMany(args: any): Promise<any[]>; count(args: any): Promise<number> } };
    deleteInvoice?: (tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline) => Promise<boolean>;
    unlink?: (scheduleId: string, qbInvoiceId: string) => Promise<boolean>;
}

/**
 * Finish the deletes Break QB Link could not confirm.
 *
 * A row carrying PENDING_DELETION_MARKER is one a human asked to unlink WITH
 * the QuickBooks invoice removed, where the remote delete did not come back
 * confirmed — out of budget, QuickBooks unreachable, or the process killed.
 * It is still LINKED on purpose: that is what stops a re-send creating a
 * second collectible invoice while the first one may still exist.
 *
 * So the state is not self-healing and it cannot be left to a human to
 * notice. This retries the delete under the sweep's own budget and unlinks
 * only once QuickBooks confirms. Rows it could not finish are REPORTED, so
 * they make the maintenance run ok:false rather than sitting silently.
 *
 * A delete that answers false is not necessarily an error — QuickBooks refuses
 * to delete an invoice with a payment attached, and that row genuinely needs a
 * human. It stays pending and is counted.
 */
export async function sweepPendingDeletions(
    tokens: QBTokens,
    deadline?: RouteDeadline,
    deps?: PendingDeletionSweepDeps,
): Promise<PendingDeletionSweepResult> {
    const db = deps?.db ?? prisma;
    const remove = deps?.deleteInvoice ?? deleteQBInvoice;
    const unlink = deps?.unlink
        ?? ((scheduleId: string, qbInvoiceId: string) => claimQBInvoiceUnlink(prisma, scheduleId, qbInvoiceId));
    const result: PendingDeletionSweepResult = { checked: 0, finished: 0, stillPending: 0, reason: null };

    const where = { qbSyncError: PENDING_DELETION_MARKER, qbInvoiceId: { not: null } };
    const rows = await db.paymentSchedule.findMany({
        where,
        select: { id: true, qbInvoiceId: true },
        orderBy: { id: "asc" },
        take: 50,
    });

    for (const row of rows) {
        // Checked before EVERY row: the delete is a real round trip, and this
        // sweep runs after the options loop and the pay-link sweep have already
        // spent most of the route.
        if (isBudgetExhausted(deadline)) {
            result.reason = "budget-exhausted";
            break;
        }
        result.checked++;
        try {
            const deleted = await remove(tokens, row.qbInvoiceId as string, deadline);
            if (!deleted) {
                // QuickBooks said no. The row keeps its marker and its link — the
                // invoice is still there, so it must still be un-re-sendable.
                result.stillPending++;
                continue;
            }
            if (await unlink(row.id, row.qbInvoiceId as string)) result.finished++;
            else result.stillPending++;
        } catch (e) {
            if (isQBBudgetExhaustedError(e)) {
                result.reason = "budget-exhausted";
                break;
            }
            if (isQboConnectionFailure(e)) {
                // Shared connection: every remaining row fails the same way at
                // full cost. Stop and say so.
                result.reason = isQBTimeoutError(e) ? "qbo-timeout" : "qbo-unavailable";
                break;
            }
            result.stillPending++;
        }
    }

    // Counted from the database AFTER the loop, so it includes rows this run
    // never reached as well as the ones it could not finish.
    result.stillPending = await db.paymentSchedule.count({ where }).catch(() => result.stillPending);
    return result;
}

export async function sweepPendingPayLinks(
    tokens: QBTokens,
    deadline?: RouteDeadline,
    deps?: {
        db?: PayLinkSweepDb;
        readPayLink?: (tokens: QBTokens, qbInvoiceId: string, deadline?: RouteDeadline) => Promise<string | null>;
        /** Where the per-rail resume cursors live; defaults to AutomationSetting. */
        cursorStore?: PaymentsSyncCursorStore;
    },
): Promise<PayLinkSweepResult> {
    const db: PayLinkSweepDb = deps?.db ?? prisma;
    const readPayLink = deps?.readPayLink ?? getQBInvoicePaymentLink;
    const cursorStore = deps?.cursorStore ?? automationSettingCursorStore;
    const zero = (): PayLinkRailCounts => ({ milestone: 0, progressBilling: 0, total: 0 });
    const result: PayLinkSweepResult = {
        checked: 0, repaired: 0, noLink: 0, skipped: 0,
        unvisited: zero(), unresolved: zero(), railFirst: "milestone",
    };

    const where = { qbSyncError: PAYLINK_PENDING_MARKER, qbInvoiceId: { not: null } };

    /**
     * One rail's rows for this run: the tail after its cursor, and — only when
     * that tail drained AND there is budget left in the page — a BOUNDED wrap
     * back to the head.
     *
     * The wrap used to happen only when the post-cursor page came back EMPTY. A
     * nonempty short tail was processed and then `saveCursors` reset the cursor
     * to the top, reporting a clean run: the head of the collection had not
     * been visited, and the next run started there only if nothing pushed the
     * cursor forward again first. The wrap is now part of the SAME run, capped
     * at `id < cursorId` so it can never re-walk the tail it just did, and the
     * cursor is only reset when the head was genuinely reached (`covered`).
     */
    const fetchRail = async (
        delegate: PayLinkSweepDelegate,
        select: Record<string, unknown>,
        key: string,
    ): Promise<{ rows: any[]; cursorId: string | null; covered: boolean }> => {
        const stored = await cursorStore.get(key);
        const cursorId = stored && stored.length > 0 ? stored : null;
        const page = async (rowWhere: any, take: number) => delegate.findMany({
            where: rowWhere,
            select,
            // Stable key: without it Postgres may hand back the same first page
            // every run and starve everything behind it.
            orderBy: { id: "asc" },
            take,
        });
        const tail = await page(
            cursorId ? { ...where, id: { gt: cursorId } } : where,
            PAYLINK_SWEEP_LIMIT,
        );
        if (!cursorId) {
            // Started at the top: a short page IS the whole collection.
            return { rows: tail, cursorId: null, covered: tail.length < PAYLINK_SWEEP_LIMIT };
        }
        if (tail.length >= PAYLINK_SWEEP_LIMIT) {
            // The page is full of tail; the head waits for a later run.
            return { rows: tail, cursorId, covered: false };
        }
        const room = PAYLINK_SWEEP_LIMIT - tail.length;
        const head = await page({ ...where, id: { lt: cursorId } }, room);
        // A short head means the wrap reached back to the cursor with nothing
        // left in between: every eligible row is in this run's pages.
        return { rows: [...tail, ...head], cursorId, covered: head.length < room };
    };

    // Which rail goes first, flipped every run so a budget that always dies
    // inside the first rail cannot starve the second one forever.
    // Unset reads as "milestone last time" is deliberately NOT the rule: an
    // unset key means nothing has run, so the first run keeps the historical
    // milestone-first order and every run after it alternates.
    const lastOrder = await cursorStore.get(PAYLINK_ORDER_KEY);
    const railFirst: "milestone" | "progressBilling" =
        lastOrder === "milestone" ? "progressBilling" : "milestone";
    result.railFirst = railFirst;

    const [milestonePage, billingPage, milestonesEligible, billingsEligible] = await Promise.all([
        fetchRail(
            db.paymentSchedule,
            { id: true, qbInvoiceId: true, invoice: { select: { code: true } } },
            PAYLINK_CURSOR_KEYS.milestones,
        ),
        fetchRail(
            db.progressBilling,
            { id: true, qbInvoiceId: true, code: true },
            PAYLINK_CURSOR_KEYS.billings,
        ),
        // Eligible-at-start, per rail. `unvisited` is measured against this, so
        // it counts rows beyond the pages as well as rows the budget cut short.
        db.paymentSchedule.count({ where }),
        db.progressBilling.count({ where }),
    ]);
    const milestones = milestonePage.rows;
    const billings = billingPage.rows;
    const eligibleAtStart: Record<"milestone" | "progressBilling", number> = {
        milestone: milestonesEligible,
        progressBilling: billingsEligible,
    };

    /**
     * The furthest each rail's cursor may move: the last row this run actually
     * REACHED A DECISION ON. Jumping to the end of the page after an outage cut
     * it short would step straight over every row the outage skipped, and they
     * would not be looked at again until the cursor wrapped all the way round.
     * A row we deliberately left pending (per-invoice refusal, lost CAS) still
     * counts as decided — leaving the cursor behind it is what starves the tail.
     */
    const lastDecided: Record<"milestone" | "progressBilling", string | null> = {
        milestone: null,
        progressBilling: null,
    };
    /** How many rows on each rail this run reached a decision on. */
    const visited: Record<"milestone" | "progressBilling", number> = {
        milestone: 0,
        progressBilling: 0,
    };
    const decided = (kind: "milestone" | "progressBilling", id: string) => {
        lastDecided[kind] = id;
        visited[kind]++;
    };
    const saveCursors = async () => {
        const rails = [
            { kind: "milestone" as const, key: PAYLINK_CURSOR_KEYS.milestones, page: milestonePage },
            { kind: "progressBilling" as const, key: PAYLINK_CURSOR_KEYS.billings, page: billingPage },
        ];
        for (const rail of rails) {
            const last = lastDecided[rail.kind];
            const rows = rail.page.rows;
            // Everything this run fetched was worked through.
            const allWorked = rows.length === 0 || (last !== null && last === rows[rows.length - 1]?.id);
            // Reset ONLY when the head was actually visited in this run — that
            // is what `covered` means. A short tail alone is not enough: it says
            // the tail ended, not that anything before the cursor was looked at.
            if (rail.page.covered && allWorked) await cursorStore.set(rail.key, "");
            // Otherwise persist the position reached. After a wrap this moves
            // the cursor BACKWARDS, which is right: the run stopped part-way
            // through the head, and the next one must resume there.
            else if (last !== null) await cursorStore.set(rail.key, last);
        }
        await cursorStore.set(PAYLINK_ORDER_KEY, railFirst);
    };

    const milestoneEntries = milestones.map((m: any) => ({
        kind: "milestone" as const,
        row: { id: m.id, qbInvoiceId: m.qbInvoiceId as string, code: m.invoice?.code ?? m.id },
    }));
    const billingEntries = billings.map((b: any) => ({
        kind: "progressBilling" as const,
        row: { id: b.id, qbInvoiceId: b.qbInvoiceId as string, code: b.code },
    }));
    const rows: { kind: "milestone" | "progressBilling"; row: PayLinkPendingRow }[] =
        railFirst === "milestone"
            ? [...milestoneEntries, ...billingEntries]
            : [...billingEntries, ...milestoneEntries];

    // A rail whose pages did not cover its whole eligible set has more behind
    // them. `covered` replaces the old "the page came back full" test, which
    // could not tell a full tail from a tail plus a wrap that finished.
    if (!milestonePage.covered || !billingPage.covered) {
        result.truncated = true;
    }

    for (const [index, entry] of rows.entries()) {
        if (isBudgetExhausted(deadline)) {
            result.reason = "budget-exhausted";
            result.skipped += rows.length - index;
            break;
        }
        result.checked++;
        let payLink: string | null;
        try {
            payLink = await readPayLink(tokens, entry.row.qbInvoiceId, deadline);
        } catch (error) {
            if (isQBBudgetExhaustedError(error)) {
                result.reason = "budget-exhausted";
                result.skipped += rows.length - index;
                result.checked--;
                break;
            }
            if (isQboConnectionFailure(error)) {
                // Shared connection: the remaining rows would fail identically
                // at a fresh 20s each. Stop and leave them pending. A 401/403
                // is named as the credential failure it is — same family the
                // digest's reconnect alert counts.
                result.reason = isQboReconnectRequired(error)
                    ? QBO_AUTH_SYNC_REASON
                    : isQBTimeoutError(error)
                        ? "qbo-timeout"
                        : "qbo-unavailable";
                result.skipped += rows.length - index;
                result.checked--;
                break;
            }
            // A per-invoice refusal (it was deleted in QuickBooks, say). Leave the
            // marker: the row is still linked, and the invoice-probe sweep is what
            // resolves a gone invoice, not this one.
            //
            // The cursor still advances past it. This is THE starvation case:
            // the row keeps its marker, so a fixed page would refetch it (and
            // its 99 friends) forever and never reach anything behind them.
            decided(entry.kind, entry.row.id);
            result.skipped++;
            continue;
        }

        const delegate = entry.kind === "milestone" ? db.paymentSchedule : db.progressBilling;
        // CAS: only clear a marker we still own, on a row still pointing at the
        // invoice we just read. A concurrent unlink/re-stage must win.
        const cleared = await delegate.updateMany({
            where: { id: entry.row.id, qbInvoiceId: entry.row.qbInvoiceId, qbSyncError: PAYLINK_PENDING_MARKER },
            data: { qbSyncError: null, ...(payLink ? { qbInvoiceLink: payLink } : {}) },
        });
        // Decided either way: a lost CAS means someone else moved this row on,
        // so it is no longer this sweep's work.
        decided(entry.kind, entry.row.id);
        if (cleared.count !== 1) {
            result.skipped++;
            continue;
        }
        if (payLink) result.repaired++;
        else result.noLink++;
    }

    // Every exit above falls through to here, so the resume point is recorded
    // whether the run finished its pages or stopped on an outage.
    await saveCursors();

    // What the run did NOT finish. Both are reported per rail and summed,
    // because "the handler returned" is not "the work is done" — a refused head
    // row that keeps its marker used to sit inside an `ok: true` maintenance
    // response indefinitely, and nobody was told.
    result.unvisited = {
        milestone: Math.max(0, eligibleAtStart.milestone - visited.milestone),
        progressBilling: Math.max(0, eligibleAtStart.progressBilling - visited.progressBilling),
        total: 0,
    };
    result.unvisited.total = result.unvisited.milestone + result.unvisited.progressBilling;
    // Counted from the database AFTER the loop: rows this run repaired no
    // longer match, rows it refused (or never reached) still do.
    const [milestoneLeft, billingLeft] = await Promise.all([
        db.paymentSchedule.count({ where }),
        db.progressBilling.count({ where }),
    ]);
    result.unresolved = {
        milestone: milestoneLeft,
        progressBilling: billingLeft,
        total: milestoneLeft + billingLeft,
    };
    return result;
}

/**
 * The client's QuickBooks customer mapping moved while we were asking
 * QuickBooks about it.
 *
 * Raised instead of overwriting: `resolveCustomerAndItem` decided which
 * customer to bill from a read taken BEFORE its round trip, and by the time it
 * held the lock the row said something else. Every invoice built from this
 * resolution — and every marker fingerprinting it — would describe a mapping
 * the database disagrees with, so the send stops here, before anything reaches
 * QuickBooks.
 */
export class QBCustomerRemappedError extends Error {
    name = "QBCustomerRemappedError";
    constructor(clientLabel: string) {
        super(
            `${clientLabel}'s QuickBooks customer changed while this was being prepared, so nothing was sent. ` +
            `Open the client, confirm which QuickBooks customer it should bill, and try again.`,
        );
    }
}

/** Name-based, for the same Node-20 module-identity reason as the guards below. */
export function isQBCustomerRemappedError(error: unknown): boolean {
    return error instanceof Error && error.name === "QBCustomerRemappedError";
}

/** Raised when a send is refused because a previous attempt's outcome is unknown. */
export class QBAmbiguousCreateError extends Error {
    name = "QBAmbiguousCreateError";
    constructor(docNumberOrCode: string) {
        super(
            `A previous QuickBooks send for ${docNumberOrCode} ended without a confirmed result, so it may already exist there. ` +
            `Check QuickBooks: if an invoice was created, keep it; if not, clear the QuickBooks link in ProBuild and send again.`,
        );
    }
}

/**
 * The milestone row moved out from under a repair that had already read it.
 *
 * Raised by the existing-invoice pay-link repair when its CAS finds the row is
 * no longer the one it looked at — most importantly when a concurrent
 * break-link cleared `qbInvoiceId`, or a fresh send claimed the row with a new
 * create marker. Both are ordinary, legitimate concurrent operations; the only
 * wrong answer is to write anyway, because a stale `paylink-pending` landing on
 * an unlinked row (or over a live create claim) either invents work for the
 * sweep against an invoice that is gone, or overwrites the claim that is the
 * only record another sender's POST ever went out.
 */
export class QBMilestoneRowMovedError extends Error {
    name = "QBMilestoneRowMovedError";
    constructor(subject: string) {
        super(
            `${subject} changed while QuickBooks was being read (it was unlinked, or sent again, in the meantime), ` +
            `so nothing was written. Refresh and try again.`,
        );
    }
}

/** Name-based, for the same cross-module-identity reason as isQBTimeoutError. */
export function isQBMilestoneRowMovedError(error: unknown): boolean {
    return (
        error instanceof QBMilestoneRowMovedError ||
        (error instanceof Error && error.name === "QBMilestoneRowMovedError")
    );
}

/** Did this failure leave the create's outcome genuinely unknown? */
export function isAmbiguousCreateFailure(error: unknown): boolean {
    // A timeout or a dead connection means the request may have landed. A
    // business refusal (4xx WITH a QuickBooks Fault) means QuickBooks answered
    // "no" and created nothing, so that is NOT ambiguous and must not park the
    // row.
    //
    // QBAmbiguousDocumentCreateError is what the create boundary itself raises
    // once it has decided an outcome is unknowable — a 4xx carrying no readable
    // Fault, a body it could not read, a 2xx with no Id. It is neither a
    // timeout nor a QboRetryableError, so without it here the callers would
    // release their in-flight claim on exactly the states that must keep it.
    return isQBTimeoutError(error) || isRetryableQboError(error) || isQBAmbiguousDocumentCreateError(error);
}

/** Reserved for the compensating delete, independent of the push's own budget. */
export const MILESTONE_CLEANUP_BUDGET_MS = 10_000;
/**
 * The WORK half: how long the QuickBooks round trips themselves may take.
 * Never handed to `pushMilestoneToQuickBooks` — it is what that function
 * arrives at after carving the cleanup reserve off the route budget below.
 *
 * The two used to be one constant, `MILESTONE_PUSH_BUDGET_MS`, and its name did
 * not say which half it was. The doc called it the work budget, the function
 * treated its argument as the whole-route budget and subtracted the reserve
 * from it, and both action callers passed the constant — so the reserve came
 * out twice and the work budget was really 35s, not 45s. One name per half now,
 * and the function has ONE contract: whatever it is given is the WHOLE ROUTE,
 * and it carves the reserve itself.
 */
export const MILESTONE_PUSH_WORK_BUDGET_MS = 45_000;
/**
 * The WHOLE-ROUTE budget a caller hands in (or the default when it passes
 * none): the work above plus the cleanup reserve, under a 60s route ceiling.
 * An unbudgeted push was the remaining way to run to the platform's ceiling and
 * be killed between the invoice create and the link.
 */
export const MILESTONE_PUSH_ROUTE_BUDGET_MS = MILESTONE_PUSH_WORK_BUDGET_MS + MILESTONE_CLEANUP_BUDGET_MS;
/** Never spend the last slice of the route: leave the platform room to respond. */
export const PLATFORM_RESERVE_MS = 2_000;
/**
 * Whole-route budget for Break QB Link when it also deletes in QuickBooks.
 * Two serial calls — a token refresh and the delete — whose own defaults are
 * 45s and 20s, which together overrun the 60s ceiling and got the action killed
 * mid-delete. One shared budget is what keeps the pair inside it.
 */
export const BREAK_QB_LINK_BUDGET_MS = 50_000;

/**
 * How long compensation may take, measured when it BEGINS.
 *
 * Never additive: the old form added the cleanup window to whatever the route
 * had left, which could push the total past the platform ceiling — the exact
 * thing the budget exists to prevent. It is the SMALLER of the standard
 * cleanup window and the route's real remaining headroom, minus a reserve so
 * the function can still return a response.
 */
export function compensationWindowMs(routeRemainingMs: number): number {
    if (!Number.isFinite(routeRemainingMs)) return MILESTONE_CLEANUP_BUDGET_MS;
    const usable = Math.floor(routeRemainingMs) - PLATFORM_RESERVE_MS;
    // Below the floor there is no useful window left; give the delete the
    // minimum a call needs rather than a negative or absurd deadline.
    if (usable <= 1_000) return 1_000;
    return Math.min(MILESTONE_CLEANUP_BUDGET_MS, usable);
}

/**
 * Claim a milestone's pre-create CAS UNDER the invoice lock, re-checking the
 * "not already covered by a progress billing" relationship inside the SAME
 * lock the claim write takes.
 *
 * `pushMilestoneToQuickBooks`'s earlier check of this relationship (before
 * tokens are refreshed and the customer/item are resolved — both real QBO
 * round trips) is a cheap fast-path, not the guard: a progress billing can
 * still land on this milestone in the window between that check and the
 * claim below, and `createProgressBillingCore` takes the SAME Invoice lock
 * (see tx-retry.ts's canonical lock order) — so re-checking here, inside the
 * lock, is what actually serializes the two paths instead of letting them
 * interleave into two collectible invoices for one milestone.
 *
 * Split out so the interleaving it closes can be tested without a database —
 * see tests/qbo-payments-outage.test.ts.
 */
export async function claimMilestonePreCreateUnderLock(
    schedule: {
        id: string;
        invoiceId: string;
        status: string;
        amount: Prisma.Decimal | number;
        qbPaymentId: string | null;
        dueDate: Date | null;
        name: string;
    },
    inFlightMarker: string,
): Promise<{ count: number }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { invoiceId: schedule.invoiceId });
        const claimedNow = await tx.progressBillingLine.findFirst({
            where: { scheduleId: schedule.id, billing: { status: { not: "Void" } } },
            select: { billing: { select: { code: true, status: true } } },
        });
        if (claimedNow) {
            throw new Error(
                `This milestone is already covered by progress invoice ${claimedNow.billing.code} (${claimedNow.billing.status}) — stage that instead of creating a separate QuickBooks invoice here.`
            );
        }
        // Pinned to the same content snapshot the create is about to build the
        // invoice from — not just qbInvoiceId/qbSyncError. Those two alone let a
        // concurrent settle, cancel, or edit land between the pre-claim read and
        // this write and still pass the CAS, so the claim would protect an
        // amount/name/dueDate/status that no longer matches what gets pushed.
        return tx.paymentSchedule.updateMany({
            where: {
                id: schedule.id,
                qbInvoiceId: null,
                qbSyncError: null,
                status: schedule.status,
                amount: schedule.amount,
                qbPaymentId: schedule.qbPaymentId,
                dueDate: schedule.dueDate,
                name: schedule.name,
            },
            data: { qbSyncError: inFlightMarker },
        });
    }));
}

/** What the final link write settled on. */
export interface MilestoneLinkOutcome {
    /**
     * `linked` — we wrote the link. `already-finalized` — somebody else already
     * finished THIS invoice on this row, so there is nothing to write and
     * nothing to compensate. `abandoned` — the row genuinely moved on and the
     * QuickBooks invoice we created is now unreferenced. `mismatch` — the money
     * state this invoice was ISSUED from no longer describes the row: the
     * client was repointed at another QuickBooks customer, or the parent
     * invoice tax rate moved and with it the milestone pre-tax/tax split. The
     * document bills the wrong thing and must not be adopted.
     *
     * `mismatch` and `abandoned` both compensate; they are kept apart so the
     * operator is told WHICH it was — "the row moved on" and "this invoice is
     * now wrong" need different follow-up.
     */
    outcome: "linked" | "already-finalized" | "abandoned" | "mismatch";
    /** The pay link the row carries, when someone else finished it. */
    payLink: string | null;
    /** For `mismatch`: what diverged, in words, for the error the caller raises. */
    mismatchDetail?: string;
}

/**
 * The final link write for a milestone push, and the verdict when it loses.
 *
 * Taken under the invoice lock and paired with a progress-billing re-check:
 * createProgressBillingCore locks the same invoice row, so the two paths
 * serialize instead of interleaving. Without this a progress billing could
 * claim this milestone in the window between the guard at the top of
 * `pushMilestoneToQuickBooks` and the write here (a full-milestone billing
 * leaves the row Pending and unlinked, so every pinned column would still
 * match) and the client would end up with two collectible QuickBooks invoices.
 *
 * All three outcomes are decided INSIDE the transaction, while the lock is
 * still held — the progress-billing re-check and the re-read below have to
 * agree with each other, and only the lock makes that true.
 */
export async function finalizeMilestoneLinkUnderLock(
    schedule: {
        id: string;
        invoiceId: string;
        amount: Prisma.Decimal | number;
        dueDate: Date | null;
        name: string;
    },
    args: {
        qbId: string;
        payLink: string | null;
        /** Did the pre-pay-link provisional write land? It decides what the CAS pins. */
        preLinked: boolean;
        inFlightMarker: string;
        /** The client this invoice bills — locked here, in Estimate → Invoice → Client order. */
        clientId: string;
        /**
         * The issuance hash the marker carries: a fingerprint of the money state
         * this QuickBooks invoice was actually built from. Recomputed under the
         * locks below and compared, because the CAS alone cannot see it — the
         * pinned columns all live on PaymentSchedule, while the customer mapping
         * lives on Client and the tax rate on Invoice.
         */
        issuanceHash: string;
    },
): Promise<MilestoneLinkOutcome> {
    const { qbId, payLink, preLinked, inFlightMarker, clientId, issuanceHash } = args;
    return withTxRetry(() => prisma.$transaction(async (tx): Promise<MilestoneLinkOutcome> => {
        // Estimate → Invoice → Client, the documented order (tx-retry.ts). The
        // Client lock is FOR SHARE because this decision only READS the mapping,
        // but it must not straddle the FOR UPDATE remap in resolveCustomerAndItem:
        // the two serialise, so the value read below is the value that stands.
        await lockMoneyParents(tx, { invoiceId: schedule.invoiceId, clientId }, { clientLock: "share" });
        const claimedNow = await tx.progressBillingLine.findFirst({
            where: { scheduleId: schedule.id, billing: { status: { not: "Void" } } },
            select: { id: true },
        });
        // ONE re-read, taken under the locks, serving BOTH decisions below: the
        // issuance guard here, and the "did a concurrent writer already finalize
        // this exact invoice" check after a lost CAS. Under the invoice lock
        // nothing can commit between them, so a second read would return the
        // same rows.
        const current = await tx.paymentSchedule.findUnique({
            where: { id: schedule.id },
            select: {
                qbInvoiceId: true, qbInvoiceLink: true, status: true, amount: true,
                name: true, dueDate: true, qbPaymentId: true,
                // The tax split derives from these two plus amount and the parent
                // invoice rate — milestoneTaxSplit, the rule the create used.
                pretaxAmount: true, taxAmount: true,
                invoice: { select: { taxRate: true, client: { select: { qbCustomerId: true } } } },
            },
        });
        // The invoice was issued against a specific QuickBooks customer and a
        // specific tax split. Neither lives on this row, so neither is pinned by
        // the CAS below: a client repointed at another customer, or a parent
        // invoice tax rate edited mid-push, leaves every pinned column identical
        // while the document already in QuickBooks bills the wrong party or the
        // wrong liability. Recomputed from what was just read and compared to the
        // marker hash. The pinned literals are the ones the CAS itself requires,
        // so this asks only: did the PAYLOAD state move?
        const currentIssuanceHash = current
            ? milestoneIssuanceHash({
                status: "Pending",
                qbPaymentId: null,
                amount: current.amount,
                dueDate: current.dueDate,
                tax: milestoneTaxSplit({
                    pretaxAmount: current.pretaxAmount,
                    taxAmount: current.taxAmount,
                    amount: current.amount,
                    invoiceTaxRate: current.invoice?.taxRate ?? null,
                }),
                customerId: current.invoice?.client?.qbCustomerId ?? null,
            })
            : null;
        if (currentIssuanceHash !== issuanceHash) {
            return {
                outcome: "mismatch",
                payLink: null,
                mismatchDetail: current
                    ? "the QuickBooks customer or the tax treatment behind it changed while it was being created"
                    : "the milestone no longer exists",
            };
        }
        // Conditional link write: the milestone was read as unlinked and unpaid
        // at the top of the push, but several remote calls happen in between — a
        // manual "Record Payment", a QB settle, a cancellation, a concurrent
        // push, or a rebalance changing the row's content can all land in that
        // window. The guards go in the WHERE — status pinned to Pending (a
        // Canceled row must never get a fresh collectible invoice: the payment
        // poller only watches Pending) and the content snapshot
        // (amount/name/dueDate) pinned to what the QBO invoice was actually
        // created from, so a mid-push edit can't leave QBO silently out of sync.
        const claimed = claimedNow ? { count: 0 } : await tx.paymentSchedule.updateMany({
            where: {
                id: schedule.id,
                status: "Pending",
                qbPaymentId: null,
                // Pinned to the id WE just wrote, not to null: the pre-pay-link
                // write already linked this row, and demanding null here would
                // miss every time and compensate away a real invoice.
                qbInvoiceId: preLinked ? qbId : null,
                // Prove we still own the claim before writing. When the pre-link
                // write already landed, this is the marker IT wrote; when that
                // write lost the race, this is the SAME in-flight marker it
                // required — never retry against a bare qbInvoiceId: null with no
                // ownership check, or a row whose marker moved on for an
                // unrelated reason (compensated, resolved, reclaimed) could get
                // OUR invoice attached to it.
                qbSyncError: preLinked ? PAYLINK_PENDING_MARKER : inFlightMarker,
                amount: schedule.amount,
                name: schedule.name,
                dueDate: schedule.dueDate,
            },
            // qbSyncError: null — a fresh invoice clears any prior voided/notFound flag (self-heal).
            data: { qbInvoiceId: qbId, qbInvoiceLink: payLink, qbSyncedAt: new Date(), qbSyncError: null },
        });
        if (claimed.count === 1) return { outcome: "linked", payLink };
        // The claim lost. Before treating this invoice as abandoned, ask what
        // the row actually says NOW. The CAS pins `qbSyncError`, and the
        // `paylink-pending` marker it requires is cleared as a matter of course
        // by `sweepPendingPayLinks` and by a concurrent resend (which takes the
        // already-linked branch at the top of the push, fetches the pay link and
        // clears the flag) — both of which leave this row correctly linked to
        // THIS invoice, and the resend has already returned success for it.
        // Compensating on that deleted a live, correct QuickBooks invoice out
        // from under the caller that had just been told it existed.
        //
        // A progress billing that claimed the milestone is NOT that case: its
        // billing stages its own covering invoice, so ours really is the
        // duplicate and must still be compensated away. Hence the `claimedNow`
        // guard here — the row can carry our id and still be a double bill.
        if (!claimedNow) {
            // `current` is the read taken under the locks above: same transaction,
            // same lock, so it is exactly what a fresh read here would return, and
            // one read is one fewer thing to keep in step.
            if (isConcurrentlyFinalizedMilestoneLink(current, qbId, schedule)) {
                return { outcome: "already-finalized", payLink: current?.qbInvoiceLink ?? null };
            }
        }
        return { outcome: "abandoned", payLink: null };
    }));
}

/**
 * Create (or repair) one milestone's QuickBooks invoice.
 *
 * WHAT STOPS A DUPLICATE, precisely — because the comment that used to sit here
 * described a mechanism this function does not have. There is no stored
 * idempotency key and no QBO `requestid` on this create (the Purchase rail has
 * one, keyed off the Drive fileId; nothing on a milestone plays that role).
 * What actually protects the client from a second bill is the marker:
 *
 *   • `claimMilestonePreCreateUnderLock` writes `create-in-flight` BEFORE the
 *     POST, under the invoice lock, so a crash between the POST and the link
 *     write leaves a trace and every other send path refuses the row;
 *   • an outcome we never learned promotes that marker to `ambiguous-create`,
 *     carrying the identity a human (or `resolveAmbiguousInvoiceCreateCore`)
 *     needs to find the invoice in QuickBooks;
 *   • only a QuickBooks refusal we can actually read — a 4xx with a parsed
 *     Fault, see `isAmbiguousCreateFailure` — releases the claim.
 *
 * That is fail-closed rather than idempotent: it never re-sends into an unknown
 * outcome, at the cost of needing a human to resolve one.
 */
export async function pushMilestoneToQuickBooks(
    paymentScheduleId: string,
    passedTokens?: QBTokens,
    /**
     * The WHOLE-ROUTE budget — everything this call may spend, cleanup
     * included. This is six serial QBO calls on a bad day (refresh, customer,
     * service item, invoice create, payment link, status) plus a compensating
     * delete if the link write fails. Individually bounded is not enough;
     * without a shared budget the SUM still runs past the caller's ceiling, and
     * being killed between the invoice create and the DB write is exactly how an
     * orphaned QBO invoice happens.
     *
     * Pass the route's real ceiling (or MILESTONE_PUSH_ROUTE_BUDGET_MS, or
     * nothing at all for that default). Do NOT pass the work budget: this
     * function carves MILESTONE_CLEANUP_BUDGET_MS off the front itself, so a
     * caller that subtracts it too leaves the QuickBooks calls 10s short.
     */
    deadline?: RouteDeadline,
): Promise<MilestonePushResult> {
    // The ROUTE deadline is the platform ceiling this push — and its possible
    // compensating delete — must fit inside. `pushDeadline` (the work budget)
    // carves MILESTONE_CLEANUP_BUDGET_MS off the FRONT of it, sharing the same
    // start time, so that reserve is still genuinely sitting on `routeDeadline`
    // when compensation begins. Measuring the reserve off `pushDeadline` itself
    // (the old form) handed cleanup whatever the work budget had left — which
    // by the time compensation is needed is close to nothing, so the delete's
    // own deadline was already-exhausted before it could even start.
    const routeDeadline = deadline ?? createRouteDeadline(MILESTONE_PUSH_ROUTE_BUDGET_MS);
    const pushDeadline = createRouteDeadline(
        Math.max(1_000, routeDeadline.budgetMs - MILESTONE_CLEANUP_BUDGET_MS),
        routeDeadline.startedAt,
    );
    const schedule = await prisma.paymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        include: {
            invoice: {
                include: {
                    client: { select: { id: true, name: true, email: true, qbCustomerId: true } },
                    project: { select: { id: true, name: true } },
                    payments: { select: { id: true, createdAt: true }, orderBy: { createdAt: "asc" } },
                },
            },
        },
    });
    if (!schedule) throw new Error("Payment milestone not found");
    if (schedule.status === "Paid") throw new Error("Milestone is already paid");

    // A milestone already claimed by a progress billing must never get its own
    // legacy QBO invoice: the billing stages one covering it, so a second one here
    // would leave TWO collectible invoices for the same money. Checked (and
    // re-checked below, immediately before the link write) because a full-milestone
    // billing leaves the row Pending and unlinked — exactly the state this function
    // otherwise accepts.
    const claimedBy = await prisma.progressBillingLine.findFirst({
        where: { scheduleId: paymentScheduleId, billing: { status: { not: "Void" } } },
        select: { billing: { select: { code: true, status: true } } },
    });
    if (claimedBy) {
        throw new Error(
            `This milestone is already covered by progress invoice ${claimedBy.billing.code} (${claimedBy.billing.status}) — stage that instead of creating a separate QuickBooks invoice here.`
        );
    }

    const tokens = passedTokens ?? await getFreshQBTokens(pushDeadline);

    if (schedule.qbInvoiceId) {
        // CLAIM BEFORE THE REMOTE CALL, and CAS every write against the link we
        // read.
        //
        // This repair used to read the row, spend two remote round trips, and
        // then `update({ where: { id } })` — pinned to the row's identity and
        // nothing else. A break-link landing during those round trips clears
        // `qbInvoiceId`, and a fresh send replaces `qbSyncError` with its own
        // create claim; either way the stale write went through, stamping
        // `paylink-pending` onto a row that no longer has a QuickBooks invoice,
        // or erasing the in-flight claim that is the only durable record that
        // another sender's POST ever left the building.
        //
        // Both halves matter. The claim below is CAS-pinned to the exact
        // `{ qbInvoiceId, qbSyncError }` pair that was read, so a row that has
        // already moved is detected BEFORE any QuickBooks call is spent; and the
        // finalising write is pinned again to the same link, so a row that moves
        // DURING the remote calls is refused rather than overwritten.
        const linkedQbInvoiceId = schedule.qbInvoiceId;
        // The pay-link read now reports its failures instead of answering null.
        // A transient one (408/429/5xx/our deadline) must not fail a milestone
        // that is already correctly linked — it leaves PAYLINK_PENDING_MARKER so
        // `sweepPendingPayLinks` finishes it. A 401/403 is a different animal:
        // the credential is bad and only a human reconnect fixes it, so it
        // surfaces.
        let payLink = schedule.qbInvoiceLink;
        let linkReadFailed = false;
        /** What `qbSyncError` holds after the claim — what the final CAS pins. */
        let markerNow = schedule.qbSyncError;
        /** Did THIS call write a `paylink-pending` claim it now owes a retraction for? */
        let claimedPending = false;
        if (!payLink) {
            // A row already flagged `voided`/`notFound` KEEPS that flag: the
            // claim is then purely the CAS probe (it rewrites the same value),
            // because replacing a real diagnosis with `paylink-pending` would
            // lose it whenever the status read below cannot reach the invoice.
            const claimMarker = schedule.qbSyncError ?? PAYLINK_PENDING_MARKER;
            const claimed = await prisma.paymentSchedule.updateMany({
                where: { id: schedule.id, qbInvoiceId: linkedQbInvoiceId, qbSyncError: schedule.qbSyncError },
                data: { qbSyncError: claimMarker },
            });
            if (claimed.count !== 1) {
                throw new QBMilestoneRowMovedError(`${schedule.invoice.code} / ${schedule.name}`);
            }
            markerNow = claimMarker;
            claimedPending = claimMarker === PAYLINK_PENDING_MARKER;
            try {
                payLink = await getQBInvoicePaymentLink(tokens, linkedQbInvoiceId, pushDeadline);
            } catch (error) {
                if (!isAmbiguousCreateFailure(error)) throw error;
                linkReadFailed = true;
            }
        }
        const status = await getQBInvoiceStatus(tokens, linkedQbInvoiceId, pushDeadline);
        const linkChanged = !!payLink && payLink !== schedule.qbInvoiceLink;
        // Two different reasons to clear the marker, kept apart on purpose:
        //   • a `paylink-pending` claim THIS call wrote is RETRACTED as soon as
        //     the pay-link read answered at all (a link, or a definite "none")
        //     — otherwise a row that had no marker before this call would be
        //     left carrying one it never earned;
        //   • a pre-existing `voided`/`notFound` flag (or a `paylink-pending`
        //     this call did not write) is cleared only on the original
        //     evidence, a reachable invoice.
        // A failed link read clears nothing: the marker stays for the sweep.
        //   • a `pending-deletion` flag is cleared by NEITHER. A reachable
        //     invoice is the whole reason that row is still waiting: somebody
        //     asked for it to be deleted and the delete has not been confirmed,
        //     so "we could read it" is evidence the intent is UNFINISHED, not
        //     evidence to forget it.
        const clearFlag = !linkReadFailed && !isPendingDeletion(markerNow)
            && (claimedPending || (!!markerNow && !!status));
        if (linkChanged || clearFlag) {
            const written = await prisma.paymentSchedule.updateMany({
                // Pinned to the link we read AND to the marker the claim left,
                // so an unlink or a new create claim during the remote calls
                // above loses this write instead of being overwritten by it.
                where: { id: schedule.id, qbInvoiceId: linkedQbInvoiceId, qbSyncError: markerNow },
                data: {
                    ...(linkChanged ? { qbInvoiceLink: payLink } : {}),
                    ...(clearFlag ? { qbSyncError: null } : {}),
                },
            });
            if (written.count !== 1) {
                throw new QBMilestoneRowMovedError(`${schedule.invoice.code} / ${schedule.name}`);
            }
        }
        return { qbInvoiceId: linkedQbInvoiceId, payLink, qbTotal: status?.total };
    }

    // Fail closed: a previous attempt may already have created the invoice, or
    // another sender is mid-flight right now.
    if (isBlockedByAmbiguousCreate(schedule)) {
        throw new QBAmbiguousCreateError(schedule.invoice.code);
    }

    const invoice = schedule.invoice;
    const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.clientId, pushDeadline);

    // Stable per-milestone doc number: INV-00012-2 (position within the invoice's schedule)
    const position = invoice.payments.findIndex(p => p.id === schedule.id) + 1 || 1;
    const docNumber = milestoneDocNumber(invoice.code, position);

    const projectName = invoice.project?.name || "Project";
    const amount = toNum(schedule.amount);

    // Carry the sales tax explicitly so Vanessa's QBO sales-tax reporting sees
    // the liability. The milestone amount is tax-inclusive; split it using the
    // invoice's rate (each milestone carries its proportional share of tax).
    //
    // The rule itself lives in qbo-issuance.ts because the issuance hash below
    // has to fingerprint EXACTLY what this sends — a second copy here would
    // drift and the resolver would recompute a hash the create never wrote.
    const tax = milestoneTaxSplit({
        pretaxAmount: schedule.pretaxAmount,
        taxAmount: schedule.taxAmount,
        amount: schedule.amount,
        invoiceTaxRate: invoice.taxRate,
    });

    const description = `${projectName} — ${schedule.name}`;
    // Truncated to QBO's PrivateNote cap BEFORE it goes anywhere — see the
    // matching comment in progress-billing.ts's stage function. QBO stores the
    // truncated note; resolveAmbiguousInvoiceCreateCore matches the marker's
    // identity against it by exact equality, so an untruncated identity here
    // would never match and a `confirmed-none` clear on that false negative
    // would let a real duplicate invoice through.
    // canonicalPrivateNote, not a bare `.slice()`: it also collapses whitespace
    // runs and trims the ends, and it is the SAME function createQBMilestoneInvoice
    // applies to the payload. A raw slice here left the marker holding an
    // untrimmed string while QuickBooks stored the trimmed one, so a project or
    // milestone name with stray whitespace made our own invoice invisible to
    // the resolver — "none found", operator clears, client billed twice.
    const privateNote = canonicalPrivateNote(milestonePrivateNote(invoice.code, schedule.name, projectName));
    // Claim the send BEFORE the request goes out. Losing this CAS means another
    // sender got there first — refuse rather than race them into two invoices.
    // A failure to WRITE the marker must abort: without it a crash mid-create
    // is invisible, which is the whole failure this guards.
    //
    // The marker CARRIES the recovery identity (docNumber + PrivateNote),
    // written in this same CAS. Both are derived from mutable state — the
    // docNumber from this milestone's POSITION in the schedule, the note from
    // the project and milestone names — so a recovery that recomputed them
    // after an earlier milestone was deleted or the project renamed would look
    // for a document we never created, find nothing, and offer to release a row
    // whose real invoice is sitting in QuickBooks collectible.
    //
    // It also carries an ISSUANCE HASH of the money state this invoice is being
    // built from. DocNumber and PrivateNote prove an invoice is ours; they do
    // not prove it still describes the row. If this create lands, the CAS below
    // loses (paid/canceled/repriced mid-flight) and the compensating delete
    // then fails, a real invoice for the OLD amount is left in QuickBooks with
    // a matching identity — and the resolver would link it. The hash is what
    // lets the resolver see the row moved and refuse.
    const issuanceHash = milestoneIssuanceHash({
        // Pinned literals, not the loaded row: these are the values the CAS
        // below requires, so they are what the invoice is genuinely issued
        // against. Reading them off `schedule` would let a row that was already
        // Paid at load time hash as Paid and then match itself at resolve time.
        status: "Pending",
        qbPaymentId: null,
        amount: schedule.amount,
        dueDate: schedule.dueDate,
        // The rest of the PAYLOAD this create is about to send. `amount` alone
        // does not describe the invoice: the same dollars split differently
        // between pre-tax and tax, or billed to a different QuickBooks
        // customer, is a different bill.
        tax,
        customerId,
    });
    const identity = {
        docNumber, privateNote, issuanceHash,
        // The QBO invoice TOTAL this create expects to produce. DocNumber +
        // PrivateNote prove a resolved match is OURS; they carry no dollar
        // figure, so this is what lets the ambiguous-create resolver refuse a
        // coincidental match whose total is wrong instead of linking it blind.
        expectedTotal: amount,
        // WHICH BOOK and WHICH CUSTOMER this POST is going to. Everything above
        // identifies a document; none of it identifies the company the document
        // lives in. A recovery run after a reconnect to a different realm would
        // otherwise query the wrong books, find nothing, and offer to clear a
        // row whose real invoice is collectible in the original company.
        realmId: tokens.realmId,
        customerId,
    };
    // Captured once and reused for the promotion below — the ambiguous-create
    // marker must carry this SAME claim time, not a fresh one taken after the
    // request ends. See composeCreateMarker's `at` param.
    const claimedAt = new Date();
    const inFlightMarker = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, identity, claimedAt);
    // Claimed UNDER the invoice lock, re-checking the progress-billing
    // relationship inside that same lock — see claimMilestonePreCreateUnderLock's
    // doc comment for why the earlier check above is not enough on its own.
    // The lock is released (the transaction ends) here, BEFORE the QBO create
    // call below.
    const claimedSend = await claimMilestonePreCreateUnderLock(schedule, inFlightMarker);
    if (claimedSend.count !== 1) {
        throw new QBAmbiguousCreateError(schedule.invoice.code);
    }

    let created: Awaited<ReturnType<typeof createQBMilestoneInvoice>>;
    try {
        created = await createQBMilestoneInvoice(tokens, {
            docNumber,
            customerId,
            itemId,
            description,
            amount,
            tax,
            dueDate: schedule.dueDate,
            billEmail: invoice.client?.email || null,
            privateNote,
        }, pushDeadline);
    } catch (error) {
        if (!isAmbiguousCreateFailure(error)) {
            // QuickBooks answered "no" and created nothing, so this row is
            // freely re-sendable: release the in-flight claim. Pinned to the
            // exact marker we wrote — releasing someone else's claim would
            // unblock a row whose outcome is genuinely unknown.
            await prisma.paymentSchedule.updateMany({
                where: { id: schedule.id, qbSyncError: inFlightMarker },
                data: { qbSyncError: null },
            }).catch(() => {});
            throw error;
        }
        {
            // The request went out and we never learned the outcome. Promote
            // the in-flight claim to the durable ambiguous marker, carrying the
            // SAME identity, so the next send refuses rather than risking a
            // duplicate bill and the recovery knows what to look for. Pinned to
            // our own claim; if it no longer matches, the row is still blocked
            // by whatever marker replaced it.
            await prisma.paymentSchedule.updateMany({
                where: { id: schedule.id, qbInvoiceId: null, qbSyncError: inFlightMarker },
                data: { qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, identity, claimedAt) },
            });
            await logAutomationEvent({
                kind: "qbo-payments-sync",
                status: "error",
                reason: AMBIGUOUS_CREATE_MARKER,
                source: "milestone-push",
                docNumber,
                detail: { paymentScheduleId: schedule.id, error: error instanceof Error ? error.name : "unknown" },
            });
            throw new QBAmbiguousCreateError(docNumber);
        }
    }

    const { qbId, total } = created;

    // QBO Automated Sales Tax can recalculate on top of what we send — verify
    // the grand total still equals the milestone. A drift means the client
    // would be asked for a different amount than ProBuild expects.
    if (Math.abs(total - amount) > 0.05) {
        console.warn(`[quickbooks-payments] QBO total drift on ${docNumber}: ProBuild ${amount} vs QBO ${total}`);
    }

    // Persist the link FIRST, before the pay-link fetch.
    //
    // The pay-link read is another remote call, and a timeout there used to
    // abandon a real, created invoice: the row still said unlinked, so the next
    // send made a second one. Recording the id immediately means the worst case
    // is a linked row with no pay link yet, which the maintenance sweep can
    // finish. CAS-guarded on the same content snapshot the final write uses.
    const claimedLink = await prisma.paymentSchedule.updateMany({
        where: {
            id: schedule.id,
            status: "Pending",
            qbPaymentId: null,
            qbInvoiceId: null,
            // Our own in-flight claim, still ours.
            qbSyncError: inFlightMarker,
            amount: schedule.amount,
            name: schedule.name,
            dueDate: schedule.dueDate,
        },
        data: { qbInvoiceId: qbId, qbSyncedAt: new Date(), qbSyncError: PAYLINK_PENDING_MARKER },
    });

    let payLink: string | null = null;
    if (claimedLink.count === 1) {
        try {
            payLink = await getQBInvoicePaymentLink(tokens, qbId, pushDeadline);
        } catch (error) {
            if (!isAmbiguousCreateFailure(error)) throw error;
            // Linked but no pay link: leave PAYLINK_PENDING_MARKER for
            // sweepPendingPayLinks (below, run by the qbo-maintenance
            // sync-payment-options action) to finish. The invoice exists and is
            // correct; only the convenience link is missing, so this is not an
            // error the operator must fix.
            console.warn(`[quickbooks-payments] pay link pending for ${docNumber} (QBO id ${qbId})`);
            return { qbInvoiceId: qbId, payLink: null, qbTotal: total };
        }
    } else {
        payLink = await getQBInvoicePaymentLink(tokens, qbId, pushDeadline).catch(() => null);
    }

    // Finish the link. The rules the write enforces (the content/status pins,
    // the progress-billing re-check under the invoice lock) and the verdict
    // when it loses live in `finalizeMilestoneLinkUnderLock` above; an
    // `abandoned` verdict — and only that — compensates the QBO invoice away.
    const linked = await finalizeMilestoneLinkUnderLock(schedule, {
        qbId,
        payLink,
        preLinked: claimedLink.count === 1,
        inFlightMarker,
        // The Client this invoice bills, so the decision can lock and re-read
        // the mapping it was issued against — the CAS cannot see that column.
        clientId: invoice.clientId,
        // The SAME hash the marker carries. Recomputed under the locks and
        // compared, so a customer remap or a tax-rate edit that landed while
        // this create was in flight refuses the link instead of adopting an
        // invoice that now bills the wrong party or the wrong liability.
        issuanceHash,
    });
    if (linked.outcome === "already-finalized") {
        // Someone else finished this exact invoice. Nothing to write and
        // nothing to delete — report the same success they did.
        return { qbInvoiceId: qbId, payLink: linked.payLink ?? payLink, qbTotal: total };
    }
    if (linked.outcome !== "linked") {
        // The compensation clock starts HERE, when compensation begins — not at
        // entry, where it would have been ticking down through every call that
        // preceded it and could already be spent by the time it is needed. It
        // is also capped by what the ROUTE has left, so cleanup cannot itself
        // overrun the platform ceiling: reserve whichever is smaller. Measured
        // off `routeDeadline`, not the (by now likely exhausted) work budget —
        // that reserve was carved out of the route's front on entry, so it is
        // still really there.
        const cleanupDeadline = createRouteDeadline(compensationWindowMs(remainingBudgetMs(routeDeadline)));
        // Say WHICH failure this was. "Changed while staging" is true of a row
        // that was paid or repriced mid-push; it is misleading for a milestone
        // that never moved at all and whose CUSTOMER or TAX RATE did — the
        // operator would go looking at the milestone and find nothing wrong.
        const whatChanged = linked.outcome === "mismatch"
            ? `This milestone could not be linked to its new QuickBooks invoice because ${linked.mismatchDetail ?? "the money state it was issued from changed"}`
            : "This milestone changed while staging its QuickBooks invoice";
        // Deleting is only half of it: this row may already carry the
        // provisional link written before the pay-link fetch, and leaving it
        // pointing at a deleted invoice would block the next send behind an
        // invoice that no longer exists.
        const { deleted: compensated, unlinked } = await compensateAndUnlink(
            prisma.paymentSchedule,
            schedule.id,
            qbId,
            () => deleteQBInvoice(tokens, qbId, cleanupDeadline),
            {},
            inFlightMarker,
        );
        if (compensated && claimedLink.count === 1 && !unlinked) {
            // The invoice is gone but the row still points at it. Say so rather
            // than reporting a tidy "changed while staging" — the next send
            // would otherwise refuse against a dead link.
            console.error(`[quickbooks-payments] milestone ${schedule.id}: deleted QBO invoice ${qbId} but could not clear the local link`);
            throw new Error(`${whatChanged}. The abandoned QuickBooks invoice ${docNumber} was deleted, but the link in ProBuild could not be cleared — use "Break QB Link" before re-sending.`);
        }
        if (!compensated) {
            // Even the reserved budget is gone (or the delete was refused).
            // Record the orphan durably so the maintenance sweep can resolve
            // it; a console line is not a work queue.
            await logAutomationEvent({
                kind: "qbo-payments-sync",
                status: "error",
                reason: "invoice-orphan-check",
                source: "milestone-push",
                docNumber,
                detail: { paymentScheduleId: schedule.id, qbInvoiceId: qbId, docNumber },
            });
            console.error(`[quickbooks-payments] milestone ${schedule.id} changed mid-push and compensating delete of QBO invoice ${qbId} (${docNumber}) failed — delete it in QuickBooks manually`);

            throw new Error(`${whatChanged}, and the abandoned QuickBooks invoice ${docNumber} (id ${qbId}) could not be deleted — remove it in QuickBooks, then retry.`);
        }
        throw new Error(`${whatChanged} — refresh and try again.`);
    }

    return { qbInvoiceId: qbId, payLink, qbTotal: total };
}

/**
 * Shared bookkeeping for settling ONE milestone from a QuickBooks payment:
 * claim it Paid, recompute the parent invoice's balance/status from every
 * milestone, and mirror the settle onto the linked estimate-side copy.
 *
 * Caller-locked: the caller must already hold the canonical Estimate→Invoice
 * locks (via `lockMoneyParents`) for this milestone's invoice BEFORE calling
 * this — it does no locking of its own so it can be called more than once
 * inside one transaction (progressBillingSettleLoop below settles every
 * milestone line of a multi-line progress billing under ONE lock+transaction).
 *
 * Deliberately does NOT enqueue a paid notification — that is the caller's
 * job, so a caller that must not notify (progress billing settle, this pass)
 * can skip it without a second/duplicate writer for the same lifecycle event.
 */
async function settleMilestonePaidInTx(
    t: Prisma.TransactionClient,
    paymentScheduleId: string,
    invoiceId: string,
    payment: { paidAt: Date; referenceNumber: string | null; qbPaymentId: string | null }
): Promise<boolean> {
    // INVARIANT: do NOT pin qbInvoiceId in this claim. A real QBO settlement must
    // win over a concurrent breakQBInvoiceLink (which nulls qbInvoiceId): pinning it
    // would drop a genuinely-received payment (the row would be excluded from the next
    // sync's `pending` query forever → client could be double-billed). The settle
    // wins; qbPaymentId below preserves the QBO audit link even if the id was cleared.
    const claim = await t.paymentSchedule.updateMany({
        where: { id: paymentScheduleId, status: { not: "Paid" } },
        data: {
            status: "Paid",
            paymentMethod: "quickbooks",
            paidAt: payment.paidAt,
            paymentDate: payment.paidAt,
            referenceNumber: payment.referenceNumber,
            qbPaymentId: payment.qbPaymentId,
            qbSyncedAt: new Date(),
        },
    });
    if (claim.count === 0) return false;

    const invoice = await t.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return false;
    const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId } });
    const totalPaid = allSchedules
        .filter(s => s.status === "Paid")
        .reduce((sum, s) => sum + toNum(s.amount), 0);
    const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
    await t.invoice.update({
        where: { id: invoiceId },
        data: {
            balanceDue: newBalance,
            status: newBalance <= 0 ? "Paid" : totalPaid > 0 ? "Partially Paid" : invoice.status,
        },
    });

    // Mirror the settle onto the estimate-side milestone copy so the
    // estimate editor/balance track the QuickBooks rail too (link-first,
    // name+amount fallback for pre-link rows; claimed update).
    if (invoice.estimateId) {
        const settled = allSchedules.find(s => s.id === paymentScheduleId);
        let estCopy: { id: string } | null = null;
        if (settled?.sourceScheduleId) {
            estCopy = await t.estimatePaymentSchedule.findFirst({
                where: { id: settled.sourceScheduleId, estimateId: invoice.estimateId, status: { not: "Paid" } },
            });
        } else if (settled) {
            // Fallback for pre-link rows: only safe when exactly one candidate matches.
            const candidates = await t.estimatePaymentSchedule.findMany({
                where: { estimateId: invoice.estimateId, status: { not: "Paid" }, name: settled.name },
                take: 2,
            });
            const matching = candidates.filter(c => toNum(c.amount) === toNum(settled.amount));
            estCopy = matching.length === 1 ? matching[0] : null;
        }
        if (estCopy && settled) {
            const mirrorClaim = await t.estimatePaymentSchedule.updateMany({
                where: { id: estCopy.id, status: { not: "Paid" } },
                data: {
                    status: "Paid",
                    paymentMethod: "quickbooks",
                    paidAt: payment.paidAt,
                    paymentDate: payment.paidAt,
                    referenceNumber: payment.referenceNumber,
                },
            });
            if (mirrorClaim.count > 0) {
                const estimate = await t.estimate.findUnique({ where: { id: invoice.estimateId } });
                if (estimate) {
                    const estSiblings = await t.estimatePaymentSchedule.findMany({ where: { estimateId: invoice.estimateId } });
                    const estPaid = estSiblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                    const estBalance = Math.max(0, toNum(estimate.totalAmount) - estPaid);
                    const estFirstPayment = !["Paid", "Partially Paid"].includes(estimate.status);
                    await t.estimate.update({
                        where: { id: invoice.estimateId },
                        data: {
                            balanceDue: estBalance,
                            status: estBalance <= 0 ? "Paid" : estPaid > 0 ? "Partially Paid" : estimate.status,
                            ...(estFirstPayment && { statusBeforePayment: estimate.status }),
                        },
                    });
                }
            }
        }
    }
    return true;
}

/**
 * Settle ONE progress billing (src/lib/progress-billing.ts) from a QuickBooks
 * payment: claim the billing Paid, then settle every milestone line it
 * carries (custom/CO lines are materialized into a real PaymentSchedule at
 * billing-creation time — see createProgressBillingCore — so every line has a
 * scheduleId here; there is no special case). Exported (not just inlined in
 * syncQuickBooksPayments below) so it can be driven directly — by a caller
 * that already has a settlement to record, or by a test with no live
 * QuickBooks connection.
 */
export async function settleProgressBillingPaidCore(
    billingId: string,
    payment: { paidAt: Date; referenceNumber: string | null; qbPaymentId: string | null },
): Promise<boolean> {
    const billing = await prisma.progressBilling.findUnique({
        where: { id: billingId },
        select: {
            id: true,
            invoiceId: true,
            lines: { select: { scheduleId: true } },
            invoice: { select: { estimateId: true } },
        },
    });
    if (!billing) return false;

    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. Every line of
        // this billing shares the same invoiceId, so one lock covers them all.
        await lockMoneyParents(t, { estimateId: billing.invoice.estimateId, invoiceId: billing.invoiceId });

        const claim = await t.progressBilling.updateMany({
            where: { id: billing.id, status: { in: ["Staged", "Sent"] }, qbPaymentId: null },
            data: { status: "Paid", paidAt: payment.paidAt, qbPaymentId: payment.qbPaymentId, qbSyncedAt: new Date() },
        });
        if (claim.count === 0) return false;

        for (const line of billing.lines) {
            if (!line.scheduleId) continue; // defensive — every line should have one by creation time
            await settleMilestonePaidInTx(t, line.scheduleId, billing.invoiceId, payment);
        }
        // TODO(progress-billing): route paid-billing notifications through
        // notifyMilestonePaid in the UI pass — deliberately not enqueued here
        // (this pass ships no customer notifications, per the owner's hard
        // constraint; see PROGRESS_BILLING_REPORT.md).
        return true;
    }));
}

/**
 * Settle ONE milestone from a QuickBooks payment: claim it Paid, recompute
 * the parent invoice, mirror the estimate copy, and enqueue the paid
 * notification. Mirrors the Stripe webhook's claim-then-recalculate
 * transaction so balances never drift.
 *
 * Exported (not just the hourly sync's private helper) so the deposit-ingest
 * endpoint (src/app/api/payments/deposit-ingest/route.ts, Phase B1) can
 * settle a milestone from a deposit-triggered QuickBooks Payment the exact
 * same way the cron settles one it discovers on its own poll. Claim-once via
 * `settleMilestonePaidInTx`'s `status: { not: "Paid" }` guard: a caller that
 * loses the claim (the cron beat it to this schedule, or vice versa) gets
 * `false` back and must NOT treat that as a generic failure — re-read the
 * schedule and compare `qbPaymentId`. The same `qbPaymentId` means the OTHER
 * caller settled it with OUR OWN QuickBooks payment (deposit-ingest raced the
 * cron's poll of the payment it just created) and this is a success, not a
 * conflict; a different or absent `qbPaymentId` is a genuine conflict the
 * caller must route to manual reconciliation.
 *
 * Receipt suppression is DERIVED here, not just taken from the caller. The
 * deposit sweep persists `qbo_created` before it settles; if it dies in that
 * gap, the hourly QuickBooks sync finds the very payment the sweep created and
 * settles the milestone itself — with no opts at all — and the client gets a
 * "Payment Confirmed" email for money no human has looked at. So this function
 * asks the database whether a bank-sourced deposit owns this milestone. Either
 * signal suppresses; neither one can be lost by which caller happened to win.
 *
 * The question is asked about THIS payment, not about the schedule's history.
 * A finished (`applied`) deposit row only suppresses when its own qbPaymentId
 * is the payment being settled — otherwise an undo-and-repay months later
 * would inherit the old sweep's silence and swallow the client's receipt. A
 * row that is still mid-flight (including one parked in `reconcile`, which is
 * very much still the sweep's money) suppresses on status alone, because its
 * QuickBooks payment id may not be known yet.
 */
export async function settleMilestoneFromQBPayment(input: {
    paymentScheduleId: string;
    invoiceId: string;
    qbPaymentId: string | null;
    paidAt: Date;
    referenceNumber: string | null;
    /** Deposit sweep only: skip the CLIENT receipt for this settlement (team
     *  email + activity log still fire). See payment-outbox.enqueueMilestonePaid. */
    suppressClientReceipt?: boolean;
}): Promise<boolean> {
    const { paymentScheduleId, invoiceId, suppressClientReceipt, ...payment } = input;
    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. This settle mirrors onto the
        // estimate copy, so read the estimate link (non-locking) and lock Estimate before Invoice,
        // matching recordPayment/recordEstimatePayment so overlapping settles never invert order.
        const invLink = await t.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(t, { estimateId: invLink?.estimateId, invoiceId });

        const claimed = await settleMilestonePaidInTx(t, paymentScheduleId, invoiceId, payment);
        if (!claimed) return false;

        // Read INSIDE the settle transaction, so the answer is the same one the
        // settle itself committed against.
        const sweptByBankDeposit = await t.depositIngest.findFirst({
            where: {
                source: BANK_DEPOSIT_SOURCE,
                paymentScheduleId,
                OR: [
                    // (a) this exact payment came from the sweep, whatever state
                    //     the row has since reached;
                    ...(payment.qbPaymentId ? [{ qbPaymentId: payment.qbPaymentId }] : []),
                    // (b) a sweep is mid-flight on this milestone right now.
                    { status: { in: [...MONEY_IN_FLIGHT_STATUSES] } },
                ],
            },
            select: { id: true },
        });

        // Durable notification, enqueued in-tx (delivered by the drainer after commit).
        await enqueueMilestonePaid(t, {
            scheduleId: paymentScheduleId,
            scheduleType: "invoice",
            suppressClientReceipt: suppressClientReceipt === true || sweptByBankDeposit !== null,
        });
        return true;
    }));
}

/**
 * Reconcile a milestone's ProBuild amount to the QBO grand total, then recompute
 * the parent invoice (and mirror the estimate copy + recompute the estimate),
 * all inside one transaction.
 *
 * QBO is the system of record for what the client is actually charged. When a
 * bookkeeper edits a price/tax/discount directly in QuickBooks the QBO total
 * drifts from the ProBuild milestone; this brings ProBuild back in line so the
 * books stay truthful before the invoice is (re)sent.
 *
 * Recalc/mirror logic is modeled on `settleMilestoneFromQBPayment` above — link-first
 * via `sourceScheduleId`, single-candidate name+amount fallback for pre-link
 * rows, claimed updates that never touch a settled row. Amounts are tax-inclusive
 * so we recompute the invoice/estimate totals from the milestone amounts and
 * re-derive the invoice tax fields from the new total at the existing tax rate.
 */
export async function reconcileMilestoneToQbo(
    paymentScheduleId: string,
    qbTotal: number,
): Promise<{ ok: boolean; error?: string; oldAmount?: number; newAmount?: number; invoiceId?: string; estimateTouched?: boolean }> {
    // Round every money figure to whole cents before writing/comparing so float
    // sums of Decimal amounts can't leave sub-penny residue in balances/status.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const newAmount = r2(qbTotal);
    // A milestone should never reconcile to $0 — a $0/negative QBO total means the
    // invoice is voided/deleted, not legitimately free. Refuse rather than zero it
    // out (which could falsely flip the parent invoice to Paid).
    if (newAmount <= 0) {
        return { ok: false, error: "QuickBooks shows a $0 total — the invoice may be voided or deleted. Re-push it before sending." };
    }
    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. This reconcile moves the invoice
        // amount and mirrors onto the estimate copy, so read the schedule's invoice + estimate
        // links (non-locking) and lock Estimate before Invoice before touching either balance.
        const linkRow = await t.paymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            select: { invoiceId: true, invoice: { select: { estimateId: true } } },
        });
        if (linkRow) {
            await lockMoneyParents(t, { estimateId: linkRow.invoice?.estimateId, invoiceId: linkRow.invoiceId });
        }

        const schedule = await t.paymentSchedule.findUnique({ where: { id: paymentScheduleId } });
        if (!schedule) return { ok: false, error: "Milestone not found" };
        // Fast reject for an already-settled milestone — money already moved.
        if (schedule.status === "Paid" || schedule.status === "Canceled") {
            return { ok: false, error: "Cannot reconcile a paid or canceled milestone" };
        }
        if (schedule.pretaxAmount != null || schedule.taxAmount != null) {
            return {
                ok: false,
                error: "This milestone has a frozen ProBuild tax split and cannot be reconciled to a changed QuickBooks total. Void the QuickBooks invoice and rebill it in ProBuild.",
            };
        }

        const oldAmount = toNum(schedule.amount);
        // Idempotent: a re-submit with the same QBO total is a no-op.
        if (Math.abs(oldAmount - newAmount) <= 0.005) {
            return { ok: true, oldAmount, newAmount, invoiceId: schedule.invoiceId, estimateTouched: false };
        }

        // 1) Claimed update of the invoice-side amount — mirrors settleMilestoneFromQBPayment's
        //    pattern so a concurrent settle (QB sync / Stripe) that marks the row Paid
        //    between the read above and this write can't have its amount overwritten.
        const claim = await t.paymentSchedule.updateMany({
            where: { id: schedule.id, status: { notIn: ["Paid", "Canceled"] } },
            data: { amount: newAmount, qbSyncedAt: new Date() },
        });
        if (claim.count === 0) {
            return { ok: false, error: "Milestone changed status (paid or canceled) — reload and try again." };
        }

        // 2) Recompute the parent invoice (mirror settleMilestoneFromQBPayment's recalc,
        //    extended to also move totalAmount since an amount change moves the grand total).
        const invoice = await t.invoice.findUnique({ where: { id: schedule.invoiceId } });
        if (!invoice) return { ok: false, error: "Invoice not found" };
        const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId: schedule.invoiceId } });
        const newTotal = r2(allSchedules.reduce((sum, s) => sum + toNum(s.amount), 0));
        const totalPaid = r2(allSchedules.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0));
        const newBalance = Math.max(0, r2(newTotal - totalPaid));
        const splitSchedules = allSchedules.filter((row) => row.pretaxAmount != null && row.taxAmount != null);
        const legacySchedules = allSchedules.filter((row) => row.pretaxAmount == null || row.taxAmount == null);
        const storedPretax = r2(splitSchedules.reduce((sum, row) => sum + toNum(row.pretaxAmount), 0));
        const storedTax = r2(splitSchedules.reduce((sum, row) => sum + toNum(row.taxAmount), 0));
        const residualTotal = r2(legacySchedules.reduce((sum, row) => sum + toNum(row.amount), 0));
        const invoiceRate = toNum(invoice.taxRate);
        const residualTax = deriveInvoiceTaxFields(residualTotal, invoiceRate, invoiceRate <= 0);
        await t.invoice.update({
            where: { id: invoice.id },
            data: {
                totalAmount: newTotal,
                subtotal: r2(storedPretax + residualTax.subtotal),
                taxAmount: r2(storedTax + residualTax.taxAmount),
                balanceDue: newBalance,
                status: newBalance <= 0 ? "Paid" : totalPaid > 0 ? "Partially Paid" : invoice.status,
            },
        });

        // 3) Mirror onto the estimate-side copy (link-first via sourceScheduleId,
        //    name + OLD-amount fallback for pre-link rows; only touch an unpaid copy)
        //    and recompute the estimate, matching settleMilestoneFromQBPayment's mirror block.
        let estimateTouched = false;
        if (invoice.estimateId) {
            let estCopy: { id: string } | null = null;
            if (schedule.sourceScheduleId) {
                estCopy = await t.estimatePaymentSchedule.findFirst({
                    where: { id: schedule.sourceScheduleId, estimateId: invoice.estimateId, status: { not: "Paid" } },
                });
            } else {
                // Fallback for pre-link rows: match on name AND the old amount in the
                // query (not after a take:2), so 3+ same-name rows can't slip a wrong
                // single match through. Only mirror when exactly one candidate matches.
                const candidates = await t.estimatePaymentSchedule.findMany({
                    where: { estimateId: invoice.estimateId, status: { not: "Paid" }, name: schedule.name, amount: oldAmount },
                    take: 2,
                });
                estCopy = candidates.length === 1 ? candidates[0] : null;
            }
            if (estCopy) {
                const mirrorClaim = await t.estimatePaymentSchedule.updateMany({
                    where: { id: estCopy.id, status: { not: "Paid" } },
                    data: { amount: newAmount },
                });
                if (mirrorClaim.count > 0) {
                    estimateTouched = true;
                    const estimate = await t.estimate.findUnique({ where: { id: invoice.estimateId } });
                    if (estimate) {
                        const estSiblings = await t.estimatePaymentSchedule.findMany({ where: { estimateId: invoice.estimateId } });
                        const estTotal = r2(estSiblings.reduce((sum, s) => sum + toNum(s.amount), 0));
                        const estPaid = r2(estSiblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0));
                        const estBalance = Math.max(0, r2(estTotal - estPaid));
                        await t.estimate.update({
                            where: { id: invoice.estimateId },
                            data: {
                                totalAmount: estTotal,
                                balanceDue: estBalance,
                                status: estBalance <= 0 ? "Paid" : estPaid > 0 ? "Partially Paid" : estimate.status,
                            },
                        });
                    }
                }
            }
        }
        return { ok: true, oldAmount, newAmount, invoiceId: schedule.invoiceId, estimateTouched };
    }));
}

export interface QBPaymentSyncResult {
    checked: number;
    settled: number;
    partiallyPaid: number;
    errors: string[];
    // Progress billings (src/lib/progress-billing.ts) settled this run — a
    // separate counter from `settled` (which counts individual milestones)
    // since one progress billing can carry several milestone lines.
    progressBillingsSettled: number;
    /**
     * Rows we deliberately did not probe because QBO had already stopped
     * answering this run. Non-zero means the run is INCOMPLETE, not clean —
     * every skipped row is simply retried next run.
     */
    skipped: number;
    /** True when the run stopped early on a connection-level QBO failure. */
    abortedOnQboOutage: boolean;
    /**
     * True when the run did not complete its work for ANY reason — a QBO
     * outage mid-loop, or a preflight failure (not connected, settings store
     * unreadable, refresh failed). The audit event's status keys off THIS, not
     * off the outage flag alone: a run that never got tokens did no work, and
     * recording it as "ok" made the digest blind to a dead money rail.
     */
    runFailed: boolean;
    /** Short machine reason for `runFailed` — goes on the audit event. */
    failureReason?: string;
}

/**
 * The per-row loop both passes share, extracted so the abort rule is ONE piece
 * of real code that a test can drive with fake rows and a fake QBO client.
 *
 * The rule: any connection-level failure (our deadline, a thrown network
 * error, or QBO answering 429/5xx) from ANY QBO sub-call in the row — the
 * invoice probe, the payment-detail read, anything added later — stops the run.
 * Continuing would spend a fresh 20s deadline per row against the same wall,
 * which is exactly how six timeouts consumed the cron's 120s ceiling. Ordinary
 * per-row failures (a business error, a DB conflict) are recorded and the loop
 * carries on.
 */
export async function runQboRowLoop<T extends { id: string }>(
    rows: T[],
    result: QBPaymentSyncResult,
    handleRow: (row: T) => Promise<void>,
    onRowError: (row: T, error: unknown) => void,
    skippedLabel: string,
    deadline?: RouteDeadline,
    /**
     * When paginating, the caller counts what is left straight from the
     * database AFTER this page's cursor — which already includes this page's
     * unprocessed tail. Adding it here too counted those rows twice. Standalone
     * callers keep the tally; `forEachPendingPage` opts out and owns the count.
     */
    countSkipped: boolean = true,
): Promise<{ lastCompletedId: string | null; skippedInPage: number }> {
    // The id of the last row this loop actually finished with. The cursor may
    // only advance to HERE: jumping to the end of the page after a mid-page
    // outage would step straight over every row the outage cut short, and they
    // would not be looked at again until the cursor wrapped all the way round.
    let lastCompletedId: string | null = null;
    let skippedInPage = 0;
    const skip = (count: number) => {
        skippedInPage += count;
        if (countSkipped) result.skipped += count;
    };

    for (const [index, row] of rows.entries()) {
        // A previous pass already hit the wall — the connection is shared, so
        // there is nothing to gain by trying again here.
        if (result.abortedOnQboOutage) {
            skip(rows.length - index);
            return { lastCompletedId, skippedInPage };
        }
        // Checked before EVERY row: a row costs several serial QBO calls, so
        // starting one with seconds left is how a run gets killed mid-write
        // instead of returning a result someone can act on.
        if (isBudgetExhausted(deadline)) {
            skip(rows.length - index);
            return { lastCompletedId, skippedInPage };
        }
        try {
            await handleRow(row);
            lastCompletedId = row.id;
        } catch (error) {
            // Out of time is not a QBO fault: stop cleanly, count the rest as
            // skipped (making the run partial), and let the next run continue.
            if (isQBBudgetExhaustedError(error)) {
                skip(rows.length - index);
                return { lastCompletedId, skippedInPage };
            }
            if (isQboConnectionFailure(error)) {
                result.abortedOnQboOutage = true;
                result.runFailed = true;
                // A 401/403 mid-loop is the CREDENTIAL, not an outage, and it
                // arrives here wrapped as QboRetryableError(status) by the row
                // handler — so a plain `qboHttpStatus` check could not see it
                // and every such run was filed as "qbo-unavailable". The digest
                // counts only the reconnect family toward its
                // reconnect-QuickBooks alert, so a broken connection discovered
                // mid-sweep (rather than in preflight) was invisible to it.
                // Same verdict as classifyPreflightFailure, one definition.
                result.failureReason = isQboReconnectRequired(error) ? QBO_AUTH_SYNC_REASON : "qbo-unavailable";
                result.errors.push(
                    `QuickBooks stopped responding (${isQBTimeoutError(error) ? "timeout" : "unavailable"}) — remaining ${skippedLabel} skipped, will retry next run`,
                );
                skip(rows.length - index - 1);
                return { lastCompletedId, skippedInPage };
            }
            // A row-level failure is recorded and the run continues, so this
            // row IS finished as far as the cursor is concerned — leaving the
            // cursor behind it would retry the same bad row forever.
            onRowError(row, error);
            lastCompletedId = row.id;
        }
    }
    return { lastCompletedId, skippedInPage };
}

/**
 * Poll QuickBooks for settled milestone invoices and record them in ProBuild.
 * Safe to run repeatedly (cron + on-view). Never throws on a single bad row.
 */
/**
 * The QBO calls the sync loop makes per row. Injectable so a test can drive the
 * REAL loop (abort rule, skip accounting, settle sequencing) against a fake
 * QuickBooks instead of re-implementing the decision in the test.
 */
export interface PaymentsSyncQboClient {
    probeInvoice(qbInvoiceId: string): Promise<QBInvoiceProbe>;
    getPayment(paymentId: string): Promise<{ txnDate: string | null; amount: number; referenceNumber: string | null } | null>;
    /**
     * One cheap authenticated read, used only to prove the connection works on
     * a run with no rows to sync. Throws if QuickBooks is not actually usable.
     */
    verifyConnection(): Promise<void>;
}

/**
 * The cron's route ceiling is 120s; stopping at 100s leaves room to write the
 * audit event and return a result instead of being killed mid-run.
 */
export const PAYMENTS_SYNC_BUDGET_MS = 100_000;

/**
 * The budget for an ON-VIEW refresh (`refreshQBPayments`), which runs as a
 * server ACTION under a 60s ceiling — not as the cron under 120s.
 *
 * Passing no deadline inherited PAYMENTS_SYNC_BUDGET_MS, so a slow QuickBooks
 * could keep a page's refresh going for 100s inside a 60s ceiling: the action
 * is killed with nothing returned and the user sees a hung page rather than
 * "QuickBooks is slow, nothing changed". 30s leaves room for the revalidate
 * work after the sync and still fits one probe plus a settle comfortably.
 */
export const ON_VIEW_PAYMENTS_SYNC_BUDGET_MS = 30_000;

export interface SyncQuickBooksPaymentsOptions {
    /**
     * Who triggered this run. Only "cron" counts as the hourly heartbeat the
     * health check watches — an on-view refresh must never be able to stand in
     * for it, or a dead cron looks alive.
     */
    source?: "cron" | "view" | "manual";
    /** Test seam; defaults to the real QBO calls. */
    qboClient?: PaymentsSyncQboClient;
    /** Whole-run time budget; defaults to PAYMENTS_SYNC_BUDGET_MS. */
    deadline?: RouteDeadline;
    /** Where the resume cursors live; defaults to the AutomationSetting table. */
    cursorStore?: PaymentsSyncCursorStore;
}

/**
 * Where the last run stopped, per collection, so the next one CONTINUES rather
 * than restarting.
 *
 * Ordering by id made each run deterministic, but every run still began at the
 * same end: with more pending rows than one run's budget, the rows past the cap
 * were re-skipped forever and never verified. Persisting the cursor turns the
 * cap into a rolling window over the whole set. Wrapping to the start on
 * exhaustion keeps it a cycle rather than a dead end.
 */
export const PAYMENTS_CURSOR_KEYS = {
    milestones: "qbo-payments-sync.cursor.milestones",
    billings: "qbo-payments-sync.cursor.billings",
} as const;
/** Which collection goes first; flipped each run so neither can starve the other. */
export const PAYMENTS_ORDER_KEY = "qbo-payments-sync.order";

export interface PaymentsSyncCursorStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
}

/** AutomationSetting-backed cursor store. Never throws: a cursor is an optimisation. */
export const automationSettingCursorStore: PaymentsSyncCursorStore = {
    async get(key) {
        try {
            const row = await prisma.automationSetting.findUnique({ where: { key }, select: { value: true } });
            return row?.value ?? null;
        } catch {
            return null;
        }
    },
    async set(key, value) {
        try {
            await prisma.automationSetting.upsert({
                where: { key },
                create: { key, value },
                update: { value },
            });
        } catch {
            // A lost cursor costs one restart from the top, never correctness.
        }
    },
};

/**
 * Rows this run has not looked at, given where it started, where it stopped,
 * and whether it wrapped.
 *
 * Counting only `id > cursor` under-reported every capped run that resumed
 * mid-collection: with the cursor at row 100 and the cap reached at row 199,
 * rows 0-99 are equally unverified but sat before the cursor, so the run
 * reported them as nothing left to do and called itself clean.
 */
async function countUnvisited(
    count: (where: Record<string, unknown>) => Promise<number>,
    state: { cursorId: string | null; originalCursor: string | null; wrapped: boolean },
): Promise<number> {
    const { cursorId, originalCursor, wrapped } = state;

    if (wrapped) {
        // Walking the head segment: the tail past the original cursor is done.
        if (!originalCursor) return 0;
        return count({
            id: { ...(cursorId ? { gt: cursorId } : {}), lte: originalCursor },
        });
    }

    // Still in the tail. Everything after where we stopped, PLUS the head
    // segment we resumed past and never came back to.
    const tail = await count(cursorId ? { id: { gt: cursorId } } : {});
    if (!originalCursor) return tail;
    const head = await count({ id: { lte: originalCursor } });
    return tail + head;
}

/** One database page. Small enough to stay responsive, big enough to be cheap. */
const PAYMENTS_SYNC_PAGE_SIZE = 100;
/** Hard ceiling on rows per run, so one huge backlog cannot run past the cron's window. */
const PAYMENTS_SYNC_MAX_ROWS = 500;
/**
 * Walk a pending collection in stable id order, a page at a time.
 *
 * The old queries took an unordered first 100 and stopped: rows past the cap
 * were neither checked nor counted as skipped, so the run reported a clean
 * "ok" while work was silently left undone — and with no ORDER BY, Postgres was
 * free to hand back the SAME first 100 every hour, starving later rows forever.
 * Ordering by id makes the walk deterministic, and anything we do not reach is
 * counted as skipped so the run is honestly reported as partial.
 */
export async function forEachPendingPage<T extends { id: string }>(
    result: QBPaymentSyncResult,
    deadline: RouteDeadline,
    /**
     * `stopAfterId` bounds the WRAPPED pass: rows with an id greater than it
     * were already visited earlier in this same run, so re-fetching them would
     * process them twice (and could loop). Null means "no upper bound".
     */
    fetchPage: (cursorId: string | null, take: number, stopAfterId: string | null) => Promise<T[]>,
    /**
     * How many rows this run has NOT visited. Takes the whole traversal state,
     * not just the cursor: a run that resumed at C and stopped at D has left
     * both (> D) AND (<= C) unvisited, and the head segment is invisible to a
     * plain "after the cursor" count. After a wrap it is the reverse — the tail
     * past C was already done, so only (> D and <= C) is left.
     */
    countRemaining: (state: {
        cursorId: string | null;
        originalCursor: string | null;
        wrapped: boolean;
    }) => Promise<number>,
    /** Returns the last row it actually completed — the furthest the cursor may move. */
    handlePage: (rows: T[]) => Promise<{ lastCompletedId: string | null }>,
    cursor?: { store: PaymentsSyncCursorStore; key: string },
    maxRows: number = PAYMENTS_SYNC_MAX_ROWS,
): Promise<void> {
    // Resume where the last run stopped. A run that finishes the tail wraps
    // back to the start, so the window rolls over the whole collection instead
    // of stalling at whichever rows happen to sort last.
    const storedCursor = cursor ? await cursor.store.get(cursor.key) : null;
    // "" is how "start from the top" is stored; it is never a real id.
    let cursorId: string | null = storedCursor && storedCursor.length > 0 ? storedCursor : null;
    // Wrapping exists to reach the rows BEFORE a resume point. A run that
    // already started at the top has no such rows, so wrapping there would
    // just re-walk everything it had only now finished — the guard has to be
    // "did this run resume?", not "is the cursor non-null?" (which is true of
    // any run that processed a page).
    const startedFromCursor = cursorId !== null;
    let processed = 0;
    let wrapped = false;

    const saveCursor = async (value: string | null) => {
        if (cursor) await cursor.store.set(cursor.key, value ?? "");
    };

    while (true) {
        if (result.abortedOnQboOutage) break;
        if (processed >= maxRows) break;
        if (isBudgetExhausted(deadline)) break;

        const take = Math.min(PAYMENTS_SYNC_PAGE_SIZE, maxRows - processed);
        // After wrapping, the run is walking the rows BEFORE where it started;
        // it must stop at that point or it would revisit the ones it has
        // already done this run.
        const page = await fetchPage(cursorId, take, wrapped ? storedCursor : null);

        if (page.length === 0) {
            // End of the collection. If we started mid-way, wrap once and keep
            // going with whatever budget is left; the rows before the old
            // cursor are exactly the ones a fixed start would never reach.
            if (startedFromCursor && !wrapped) {
                wrapped = true;
                cursorId = null;
                await saveCursor(null);
                continue;
            }
            await saveCursor(null); // fully drained: next run starts at the top
            return;
        }

        const { lastCompletedId } = await handlePage(page);
        processed += page.length;
        // Only past what finished. On a clean page this is the page tail; on a
        // page an outage cut short it is wherever the loop actually got to, so
        // the next run resumes at the first unverified row rather than after it.
        if (lastCompletedId !== null) {
            cursorId = lastCompletedId;
            await saveCursor(cursorId);
        }

        // A short page means we reached the end of the collection.
        if (page.length < take) {
            if (startedFromCursor && !wrapped) {
                wrapped = true;
                cursorId = null;
                await saveCursor(null);
                continue;
            }
            await saveCursor(null);
            return;
        }
    }

    // Stopped early. Count what is genuinely left AFTER the cursor rather than
    // subtracting from a stale total — rows settled during this run have
    // already dropped out of the pending set.
    //
    // If that count FAILS we do not know how much was left. Defaulting to 0
    // was the worst possible answer: skipped stayed 0, the run reported "ok",
    // and an unknown amount of unverified payment work vanished from the
    // record. Not knowing is a failed run.
    try {
        const remaining = await countRemaining({ cursorId, originalCursor: storedCursor, wrapped });
        if (remaining > 0) result.skipped += remaining;
    } catch (error) {
        result.runFailed = true;
        result.failureReason = "count-failed";
        result.errors.push(
            `Could not count remaining rows: ${error instanceof Error ? error.message : "unknown error"}`,
        );
    }
}

export async function syncQuickBooksPayments(
    scope?: { invoiceId?: string; projectId?: string },
    options?: SyncQuickBooksPaymentsOptions,
): Promise<QBPaymentSyncResult> {
    // Exactly one audit event per invocation, whatever happens.
    //
    // The event used to be written at each return point, so any path that did
    // not reach one — a Prisma failure in the pagination queries, a bug in the
    // loop — returned or threw with NO event at all. The health check reads
    // those events, so a crashing cron looked exactly like a cron that had
    // never been deployed: silent. try/finally makes the record unconditional,
    // and `recorded` keeps it to one.
    const runState = { recorded: false };
    try {
        return await runPaymentsSync(scope, options, runState);
    } catch (error) {
        // A DB/pagination exception is still a failed RUN and must be visible.
        if (!runState.recorded) {
            runState.recorded = true;
            await recordPaymentsSyncEvent(
                {
                    checked: 0, settled: 0, partiallyPaid: 0, progressBillingsSettled: 0,
                    skipped: 0, abortedOnQboOutage: false,
                    runFailed: true,
                    failureReason: "run-crashed",
                    errors: [error instanceof Error ? error.message : "payments sync threw"],
                },
                options?.source,
            ).catch(() => {});
        }
        throw error;
    }
}

async function runPaymentsSync(
    scope: { invoiceId?: string; projectId?: string } | undefined,
    options: SyncQuickBooksPaymentsOptions | undefined,
    runState: { recorded: boolean },
): Promise<QBPaymentSyncResult> {
    const result: QBPaymentSyncResult = {
        checked: 0, settled: 0, partiallyPaid: 0, errors: [], progressBillingsSettled: 0,
        skipped: 0, abortedOnQboOutage: false, runFailed: false,
    };
    const routeDeadline = options?.deadline ?? createRouteDeadline(PAYMENTS_SYNC_BUDGET_MS);

    const pendingWhere = {
        status: "Pending",
        qbInvoiceId: { not: null },
        ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
        ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
    };
    const pendingRowCount = await prisma.paymentSchedule.count({ where: pendingWhere });

    // Progress billings (src/lib/progress-billing.ts) staged/sent to QuickBooks
    // — a second, independent pass over the same QBO connection. Milestones
    // billed through a ProgressBilling are NOT in `pending` above (billing
    // them there doesn't touch PaymentSchedule.qbInvoiceId), so this pass is
    // the only place they get settled from a QuickBooks payment.
    const billingWhere = {
        qbInvoiceId: { not: null },
        status: { in: ["Staged", "Sent"] },
        ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
        ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
    };
    const billingRowCount = await prisma.progressBilling.count({ where: billingWhere });

    // Tokens FIRST, even with nothing to do. Recording "ok" before proving we
    // can talk to QuickBooks let a disconnected or expired integration emit a
    // fresh successful heartbeat every hour, forever — the health check would
    // read a perfectly alive money rail that could not have synced anything.
    let tokens: QBTokens;
    try {
        tokens = await getFreshQBTokens(routeDeadline);
    } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "QB tokens unavailable");
        // ANY preflight failure means the run did no work — not connected, the
        // settings store unreadable, a refresh that failed or timed out. All of
        // them must record status=error: banking them as "ok" is precisely what
        // made the digest blind to a dead money rail.
        const preflight = classifyPreflightFailure(e);
        result.runFailed = true;
        result.failureReason = preflight.reason;
        result.abortedOnQboOutage = preflight.abortedOnQboOutage;
        // Nothing was checked, so everything we loaded counts as skipped.
        result.skipped = pendingRowCount + billingRowCount;
        runState.recorded = true;
        await recordPaymentsSyncEvent(result, options?.source);
        return result;
    }

    const qbo: PaymentsSyncQboClient = options?.qboClient ?? {
        // Every call is capped by what is LEFT of the run budget, not just by
        // its own timeout — six legal 20s calls would otherwise still run past
        // the cron's ceiling.
        probeInvoice: (qbInvoiceId) => probeQBInvoice(tokens, qbInvoiceId, routeDeadline),
        getPayment: (paymentId) => getQBPayment(tokens, paymentId, routeDeadline),
        // CompanyInfo is the cheapest authenticated read in the API.
        verifyConnection: async () => {
            await qbQuery(tokens, "SELECT * FROM CompanyInfo", routeDeadline);
        },
    };

    // Nothing to sync. Holding tokens is NOT proof the rail works: a
    // non-timeout refresh failure falls back to the stale pair, and stale
    // credentials, a wrong realm, or revoked accounting access all still
    // produce a token object. Without an actual API call this run would record
    // a fresh "ok" every hour forever while nothing could ever sync. One cheap
    // authenticated read settles it.
    if (pendingRowCount === 0 && billingRowCount === 0) {
        try {
            await qbo.verifyConnection();
        } catch (error) {
            const verdict = classifyPreflightFailure(error);
            result.runFailed = true;
            result.failureReason = verdict.reason;
            result.abortedOnQboOutage = verdict.abortedOnQboOutage;
            result.errors.push(
                `QuickBooks connectivity check failed: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        }
        runState.recorded = true;
        await recordPaymentsSyncEvent(result, options?.source);
        return result;
    }

    // Milestones whose linked QBO invoice was found voided/deleted THIS run (flag was
    // previously null). Reported once per breakage; a re-push clears the flag and re-arms.
    const newlyFlagged: QBSyncIssue[] = [];

    // A SCOPED run (the on-view refresh for one invoice or project) is not a
    // sweep: it looks at a handful of rows the user is staring at. Letting it
    // read the shared cursor would make it skip the very row it was asked
    // about, and letting it WRITE one would move the cron's resume point to
    // wherever that user happened to be looking — silently starving everything
    // after it. Only the unscoped cron sweep carries cursors.
    const isSweep = !scope?.invoiceId && !scope?.projectId;
    const cursorStore = options?.cursorStore ?? automationSettingCursorStore;
    const milestoneCursor = isSweep
        ? { store: cursorStore, key: PAYMENTS_CURSOR_KEYS.milestones }
        : undefined;
    const billingCursor = isSweep
        ? { store: cursorStore, key: PAYMENTS_CURSOR_KEYS.billings }
        : undefined;

    const milestoneSelect = {
        id: true, invoiceId: true, qbInvoiceId: true, qbSyncError: true, name: true, amount: true,
        invoice: { select: { code: true, project: { select: { id: true, name: true } }, client: { select: { name: true, email: true } } } },
    } as const;

    const runMilestonePass = () => forEachPendingPage(
        result,
        routeDeadline,
        (cursorId, take, stopAfterId) => prisma.paymentSchedule.findMany({
            where: {
                ...pendingWhere,
                ...(cursorId || stopAfterId
                    ? {
                        id: {
                            ...(cursorId ? { gt: cursorId } : {}),
                            ...(stopAfterId ? { lte: stopAfterId } : {}),
                        },
                    }
                    : {}),
            },
            select: milestoneSelect,
            // Stable key: without it Postgres may return the same first page
            // every run and starve everything behind it.
            orderBy: { id: "asc" },
            take,
        }),
        ({ cursorId, originalCursor, wrapped }) => countUnvisited(
            (where) => prisma.paymentSchedule.count({ where: { ...pendingWhere, ...where } }),
            { cursorId, originalCursor, wrapped },
        ),
        (page) => runQboRowLoop(page, result, async (schedule) => {
        result.checked++;
        {
            const probe = await qbo.probeInvoice(schedule.qbInvoiceId!);
            if (probe.state === "error") {
                // A connection-level failure becomes a throw so the shared loop
                // applies one abort rule to every QBO sub-call in this row.
                if (probe.connectionFailed) {
                    throw new QboRetryableError(
                        `QB invoice probe failed (${probe.timedOut ? "timeout" : `status ${probe.status}`})`,
                        probe.status,
                    );
                }
                // Any other probe failure leaves this milestone UNVERIFIED. It
                // used to return silently, so a run that checked nothing could
                // still finish with zero errors and emit status "ok" — a green
                // heartbeat for work that never happened. Record it as a row
                // error (the run becomes "partial") and move on.
                throw new Error(`QBO invoice probe failed (status ${probe.status})`);
            }

            if (probe.state === "voided" || probe.state === "notFound") {
                // The QBO invoice is gone/voided: it can never settle. Flag so the UI can
                // surface a Break-Link recovery, and report it ONCE so a human re-issues.
                //
                // Atomic claim: `qbSyncError: null` is in the WHERE, so exactly one run
                // (across overlapping cron + on-view syncs) flips null→state and reports.
                // `status: "Pending"` + pinned `qbInvoiceId` also avoid flagging a row a
                // concurrent settle/break-link just changed under us.
                const claim = await prisma.paymentSchedule.updateMany({
                    where: { id: schedule.id, status: "Pending", qbInvoiceId: schedule.qbInvoiceId, qbSyncError: null },
                    data: { qbSyncError: probe.state },
                });
                if (claim.count === 1) {
                    newlyFlagged.push({
                        scheduleId: schedule.id,
                        invoiceId: schedule.invoiceId,
                        state: probe.state,
                        invoiceCode: schedule.invoice.code,
                        milestoneName: schedule.name,
                        projectId: schedule.invoice.project?.id ?? null,
                        projectName: schedule.invoice.project?.name ?? null,
                    });
                } else if (schedule.qbSyncError && schedule.qbSyncError !== probe.state) {
                    // Already flagged, but the state changed (e.g. voided → later deleted):
                    // refresh the label for the UI badge only — never re-report/re-email.
                    // Pin qbInvoiceId so a stale run can't relabel a milestone whose link
                    // was re-pushed or broken out from under us.
                    await prisma.paymentSchedule.updateMany({
                        where: { id: schedule.id, status: "Pending", qbInvoiceId: schedule.qbInvoiceId, qbSyncError: { not: null } },
                        data: { qbSyncError: probe.state },
                    }).catch(() => {});
                }
                result.errors.push(`${schedule.invoice.code}/${schedule.name}: QBO invoice ${probe.state}`);
                return;
            }

            // probe.state === "ok"
            if (probe.total > 0 && probe.balance <= 0) {
                // Fully settled in QuickBooks (online payment OR a check Vanessa applied)
                const paymentId = probe.paymentTxnIds[0] || null;
                // Same abort rule as the probe: a timeout/401/403/408/429/5xx
                // inside resolvePaymentDate throws and stops the run rather
                // than costing another full deadline on every remaining row.
                const { paidAt, referenceNumber } = await resolveSettlementDate(qbo, paymentId);
                const recorded = await settleMilestoneFromQBPayment({
                    paymentScheduleId: schedule.id,
                    invoiceId: schedule.invoiceId,
                    paidAt,
                    referenceNumber,
                    qbPaymentId: paymentId,
                });
                if (recorded) {
                    result.settled++;
                    await drainPaymentNotifications({ scheduleId: schedule.id }).catch(() => {});
                }
            } else if (probe.balance < probe.total) {
                result.partiallyPaid++;
            }
        }
    }, (schedule, e) => {
            result.errors.push(`${schedule.invoice.code}/${schedule.name}: ${e instanceof Error ? e.message : "sync failed"}`);
        }, "milestones", routeDeadline, false),
        milestoneCursor,
    );

    // ── Progress billings ───────────────────────────────────────────────────
    // Same probe → settle shape as the milestone loop above, but claims ONE
    // ProgressBilling row and settles it via settleProgressBillingPaidCore,
    // which walks every line the billing carries under a single lock+transaction
    // (custom/change-order lines were materialized into a real PaymentSchedule
    // at billing-creation time — see createProgressBillingCore — so every line
    // has a scheduleId and settles like any other milestone; no special case).
    const billingSelect = {
        id: true, invoiceId: true, qbInvoiceId: true, code: true,
        lines: { select: { scheduleId: true } },
        invoice: { select: { code: true, estimateId: true } },
    } as const;

    const runBillingPass = () => forEachPendingPage(
        result,
        routeDeadline,
        (cursorId, take, stopAfterId) => prisma.progressBilling.findMany({
            where: {
                ...billingWhere,
                ...(cursorId || stopAfterId
                    ? {
                        id: {
                            ...(cursorId ? { gt: cursorId } : {}),
                            ...(stopAfterId ? { lte: stopAfterId } : {}),
                        },
                    }
                    : {}),
            },
            select: billingSelect,
            orderBy: { id: "asc" },
            take,
        }),
        ({ cursorId, originalCursor, wrapped }) => countUnvisited(
            (where) => prisma.progressBilling.count({ where: { ...billingWhere, ...where } }),
            { cursorId, originalCursor, wrapped },
        ),
        (page) => runQboRowLoop(page, result, async (billing) => {
        // Counted exactly where the milestone pass counts it — BEFORE the
        // probe, so a row that was looked at and then failed still shows up as
        // looked at. Omitting it here made `checked` the milestone count alone:
        // a run that verified nothing but progress billings reported
        // "checked: 0" beside a real settle, and any coverage number computed
        // off it under-reported the billing rail entirely.
        result.checked++;
        {
            const probe = await qbo.probeInvoice(billing.qbInvoiceId!);
            if (probe.state === "error") {
                if (probe.connectionFailed) {
                    throw new QboRetryableError(
                        `QB invoice probe failed (${probe.timedOut ? "timeout" : `status ${probe.status}`})`,
                        probe.status,
                    );
                }
                // Same rule as the milestone loop: unverified is not "fine".
                throw new Error(`QBO invoice probe failed (status ${probe.status})`);
            }
            if (probe.state === "voided" || probe.state === "notFound") {
                result.errors.push(`${billing.invoice.code}/${billing.code}: QBO invoice ${probe.state}`);
                return;
            }
            // probe.state === "ok"
            if (probe.total > 0 && probe.balance <= 0) {
                const paymentId = probe.paymentTxnIds[0] || null;
                const { paidAt, referenceNumber } = await resolveSettlementDate(qbo, paymentId);
                const settled = await settleProgressBillingPaidCore(billing.id, { paidAt, referenceNumber, qbPaymentId: paymentId });
                if (settled) result.progressBillingsSettled++;
            } else if (probe.balance < probe.total) {
                result.partiallyPaid++;
            }
        }
    }, (billing, e) => {
            result.errors.push(`${billing.invoice.code}/${billing.code}: ${e instanceof Error ? e.message : "sync failed"}`);
        }, "progress billings", routeDeadline, false),
        billingCursor,
    );

    // Alternate which collection goes first. Whichever runs second only gets
    // the budget the first one left, so a fixed order lets a busy milestone
    // queue starve progress billings indefinitely (and vice versa). Flipping
    // each run guarantees both sides get to go first half the time.
    //
    // Sweep-only, for the same reason as the cursors: an on-view refresh must
    // not rotate the cron's order, or a burst of them could pin the sweep to
    // one collection.
    let billingsFirst = false;
    if (isSweep) {
        const lastOrder = await cursorStore.get(PAYMENTS_ORDER_KEY);
        billingsFirst = lastOrder !== "billings-first";
        await cursorStore.set(PAYMENTS_ORDER_KEY, billingsFirst ? "billings-first" : "milestones-first");
    }

    if (billingsFirst) {
        await runBillingPass();
        await runMilestonePass();
    } else {
        await runMilestonePass();
        await runBillingPass();
    }

    if (newlyFlagged.length > 0) {
        const { notifyQBSyncIssues } = await import("./payment-notifications");
        await notifyQBSyncIssues(newlyFlagged);
    }

    runState.recorded = true;
    await recordPaymentsSyncEvent(result, options?.source);
    return result;
}

/** Reason recorded when a settlement is refused for want of an authoritative date. */
export const PAYMENT_DATE_MISSING = "payment-date-missing";

/**
 * The authoritative payment date, or refuse to settle.
 *
 * `paidAt` used to default to `new Date()` and was only replaced when a
 * txnDate happened to be present, so an invoice with no linked payment id, a
 * payment carrying a null/garbage txnDate, or an unreadable payment record all
 * settled REAL milestones stamped with today — wrong money data, and it fires
 * the mirror/notification side effects on the way out. There is no safe
 * fallback for "when was this paid": leave the row Pending (the run becomes
 * partial) and let a later run settle it with a real date.
 */
export async function resolveSettlementDate(
    qbo: PaymentsSyncQboClient,
    paymentId: string | null,
): Promise<{ paidAt: Date; referenceNumber: string | null }> {
    if (!paymentId) {
        throw new Error(`QBO invoice is fully paid but carries no linked payment; ${PAYMENT_DATE_MISSING}`);
    }
    const payment = await qbo.getPayment(paymentId);
    if (!payment) {
        throw new Error(`QBO payment ${paymentId} could not be read; ${PAYMENT_DATE_MISSING}`);
    }
    if (!payment.txnDate) {
        throw new Error(`QBO payment ${paymentId} has no TxnDate; ${PAYMENT_DATE_MISSING}`);
    }
    const paidAt = new Date(`${payment.txnDate}T12:00:00Z`);
    if (Number.isNaN(paidAt.getTime())) {
        throw new Error(`QBO payment ${paymentId} has an unparseable TxnDate "${payment.txnDate}"; ${PAYMENT_DATE_MISSING}`);
    }
    return { paidAt, referenceNumber: payment.referenceNumber || null };
}

/**
 * Why a run never got off the ground. EVERY branch here is a failed run: the
 * sync did no work, so recording it as "ok" would tell the digest the money
 * rail is healthy when it is not. Only the connection-level branch also counts
 * as an outage (the flag that stops further QBO calls).
 */
export function classifyPreflightFailure(error: unknown): { reason: string; abortedOnQboOutage: boolean } {
    if (isQboConnectionFailure(error)) {
        // 401/403 is the credential, not an outage — pipeline-health's digest
        // only counts events reasoned "qbo-auth" toward reconnect-QuickBooks
        // alerting (QBO_AUTH_EVENT_REASON), so folding it into the generic
        // "qbo-unavailable" bucket here made a broken connection invisible to
        // that alert and read like ordinary transient QBO flakiness instead.
        if (isQboReconnectRequired(error)) {
            return { reason: QBO_AUTH_SYNC_REASON, abortedOnQboOutage: true };
        }
        return { reason: "qbo-unavailable", abortedOnQboOutage: true };
    }
    if (error instanceof QBNotConnectedError || (error instanceof Error && error.name === "QBNotConnectedError")) {
        return { reason: "quickbooks-not-connected", abortedOnQboOutage: false };
    }
    if (error instanceof QBTokenPersistenceError || (error instanceof Error && error.name === "QBTokenPersistenceError")) {
        return { reason: "token-not-persisted", abortedOnQboOutage: false };
    }
    if (isQBTokenStrandedError(error)) {
        return { reason: "token-rotation-ambiguous", abortedOnQboOutage: false };
    }
    // Settings-store read failures, a rejected refresh, anything else.
    return { reason: "token-fetch-failed", abortedOnQboOutage: false };
}

/**
 * The audit status for a finished run.
 *
 * "ok" is reserved for a run that actually completed ALL its work. A run that
 * skipped rows or hit row-level errors did NOT verify those milestones, so
 * calling it "ok" refreshed the health heartbeat on the strength of work that
 * never happened — the digest would read green while payments went unchecked.
 * Those runs are "partial": visible and heartbeat-ineligible, but not counted
 * as hard errors, so one stubborn row does not read like a QBO outage.
 */
export function paymentsSyncRunStatus(result: QBPaymentSyncResult): "ok" | "partial" | "error" {
    if (result.runFailed) return "error";
    if (result.skipped > 0 || result.errors.length > 0) return "partial";
    return "ok";
}

/** The AutomationEvent kind the payments cron writes once per run. */
export const QBO_PAYMENTS_SYNC_EVENT_KIND = "qbo-payments-sync";

/**
 * One audit row per payments-sync run, so an outage on this rail is VISIBLE.
 *
 * Before this, a QBO outage during the payments cron left no trace anywhere a
 * human or the morning digest would look: the run returned a tidy result object
 * to a cron log nobody reads. The pipeline health check counts these errors and
 * reports the last successful run, so a stalled money rail turns the digest red
 * instead of staying silent. Fire-and-forget, like every other automation
 * event — the audit row must never fail the sync it describes.
 */
async function recordPaymentsSyncEvent(
    result: Omit<QBPaymentSyncResult, "runFailed"> & { runFailed: boolean },
    source: SyncQuickBooksPaymentsOptions["source"],
): Promise<void> {
    const status = paymentsSyncRunStatus(result);
    await logAutomationEvent({
        kind: QBO_PAYMENTS_SYNC_EVENT_KIND,
        status,
        reason: result.failureReason ?? (status === "partial" ? "incomplete-run" : undefined),
        // Only a real cron run may claim to be the heartbeat. An on-view or
        // manual refresh is recorded under its own source (or none) so it can
        // never mask an hourly job that has stopped running.
        source,
        detail: {
            runFailed: result.runFailed,
            errorCount: result.errors.length,
            checked: result.checked,
            settled: result.settled,
            partiallyPaid: result.partiallyPaid,
            progressBillingsSettled: result.progressBillingsSettled,
            skipped: result.skipped,
            errors: result.errors.slice(0, 5),
        },
    });
}
