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
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import { enqueueMilestonePaid, drainPaymentNotifications } from "./payment-outbox";
import { toNum, deriveInvoiceTaxFields } from "./prisma-helpers";
import { getQBSettings, saveQBSettings } from "./integration-store";
import {
    type QBTokens,
    refreshQBToken,
    QBTimeoutError,
    ensureQBCustomer,
    ensureQBServiceItem,
    createQBMilestoneInvoice,
    getQBInvoicePaymentLink,
    getQBInvoiceStatus,
    probeQBInvoice,
    getQBPayment,
    deleteQBInvoice,
} from "./quickbooks";
import { isE2eQboMockEnabled, MOCK_QB_TOKENS } from "./quickbooks-mock";
import type { QBSyncIssue } from "./payment-notifications";

export class QBNotConnectedError extends Error {
    constructor() {
        super("QuickBooks is not connected (Settings → Integrations → QuickBooks)");
        this.name = "QBNotConnectedError";
    }
}

/** Fresh tokens, persisting the rotated refresh token. Throws QBNotConnectedError. */
export async function getFreshQBTokens(): Promise<QBTokens> {
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
    return refreshTokensOrFallBack({
        accessToken: qb.accessToken,
        refreshToken: qb.refreshToken,
        realmId: qb.realmId,
    });
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
    try {
        const fresh = await refresh(qb.refreshToken);
        await save({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch (error) {
        if (error instanceof QBTimeoutError) throw error;
        // Refresh can fail transiently; the old access token may still be valid.
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
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
            qbSyncError: null,
        },
    });
    return cleared.count === 1;
}

// Exported for stageProgressBillingToQuickBooksCore (src/lib/progress-billing.ts),
// which needs the same customer/item resolution pushMilestoneToQuickBooks uses.
export async function resolveCustomerAndItem(tokens: QBTokens, clientId: string): Promise<{ customerId: string; itemId: string }> {
    const client = await prisma.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true, email: true, qbCustomerId: true },
    });
    if (!client) throw new Error("Client not found");

    const customerId = await ensureQBCustomer(tokens, client);
    if (customerId !== client.qbCustomerId) {
        await prisma.client.update({ where: { id: client.id }, data: { qbCustomerId: customerId } });
    }

    const qb = await getQBSettings();
    let itemId = qb.serviceItemId;
    if (!itemId) {
        itemId = await ensureQBServiceItem(tokens);
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
export async function pushMilestoneToQuickBooks(paymentScheduleId: string, passedTokens?: QBTokens): Promise<MilestonePushResult> {
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

    const tokens = passedTokens ?? await getFreshQBTokens();

    if (schedule.qbInvoiceId) {
        const payLink = schedule.qbInvoiceLink || (await getQBInvoicePaymentLink(tokens, schedule.qbInvoiceId));
        const status = await getQBInvoiceStatus(tokens, schedule.qbInvoiceId);
        const linkChanged = !!payLink && payLink !== schedule.qbInvoiceLink;
        // A reachable invoice (status read back) clears any stale voided/notFound flag.
        const clearFlag = !!status && !!schedule.qbSyncError;
        if (linkChanged || clearFlag) {
            await prisma.paymentSchedule.update({
                where: { id: schedule.id },
                data: {
                    ...(linkChanged ? { qbInvoiceLink: payLink } : {}),
                    ...(clearFlag ? { qbSyncError: null } : {}),
                },
            });
        }
        return { qbInvoiceId: schedule.qbInvoiceId, payLink, qbTotal: status?.total };
    }

    const invoice = schedule.invoice;
    const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.clientId);

    // Stable per-milestone doc number: INV-00012-2 (position within the invoice's schedule)
    const position = invoice.payments.findIndex(p => p.id === schedule.id) + 1 || 1;
    const suffix = `-${position}`;
    const docNumber = `${invoice.code.slice(0, Math.max(1, 21 - suffix.length))}${suffix}`;

    const projectName = invoice.project?.name || "Project";
    const amount = toNum(schedule.amount);

    // Carry the sales tax explicitly so Vanessa's QBO sales-tax reporting sees
    // the liability. The milestone amount is tax-inclusive; split it using the
    // invoice's rate (each milestone carries its proportional share of tax).
    let tax: { preTaxAmount: number; taxAmount: number } | null = null;
    if (schedule.pretaxAmount != null && schedule.taxAmount != null) {
        tax = {
            preTaxAmount: toNum(schedule.pretaxAmount),
            taxAmount: toNum(schedule.taxAmount),
        };
    } else {
        const taxRate = toNum(invoice.taxRate);
        const preTaxAmount = Math.round((amount / (1 + taxRate / 100)) * 100) / 100;
        const taxAmount = Math.round((amount - preTaxAmount) * 100) / 100;
        if (taxRate > 0 && taxAmount > 0) tax = { preTaxAmount, taxAmount };
    }

    const { qbId, total } = await createQBMilestoneInvoice(tokens, {
        docNumber,
        customerId,
        itemId,
        description: `${projectName} — ${schedule.name}`,
        amount,
        tax,
        dueDate: schedule.dueDate,
        billEmail: invoice.client?.email || null,
        privateNote: `ProBuild ${invoice.code} · ${schedule.name} · ${projectName}`,
    });

    // QBO Automated Sales Tax can recalculate on top of what we send — verify the
    // grand total still equals the milestone. A drift means the client would be
    // asked for a different amount than ProBuild expects; flag it loudly.
    if (Math.abs(total - amount) > 0.05) {
        console.warn(`[quickbooks-payments] QBO total drift on ${docNumber}: ProBuild ${amount} vs QBO ${total}`);
    }

    const payLink = await getQBInvoicePaymentLink(tokens, qbId);

    // Conditional link write: the milestone was read as unlinked and unpaid at
    // the top, but this function does several remote calls in between — a manual
    // "Record Payment", a QB settle, a cancellation, a concurrent push, or a
    // rebalance changing the row's content can all land in that window. The
    // guards go in the WHERE — status pinned to Pending (a Canceled row must
    // never get a fresh collectible invoice: the payment poller only watches
    // Pending) and the content snapshot (amount/name/dueDate) pinned to what the
    // QBO invoice was actually created from, so a mid-push edit can't leave QBO
    // silently out of sync. If the claim misses, the just-created QBO invoice is
    // deleted (compensation) instead of being attached to a row it no longer
    // describes.
    // Taken under the invoice lock and paired with a progress-billing re-check:
    // createProgressBillingCore locks the same invoice row, so the two paths
    // serialize instead of interleaving. Without this a progress billing could
    // claim this milestone in the window between the guard at the top of this
    // function and the write below (a full-milestone billing leaves the row
    // Pending and unlinked, so every pinned column here would still match) and
    // the client would end up with two collectible QuickBooks invoices.
    const linked = await withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { invoiceId: schedule.invoiceId });
        const claimedNow = await tx.progressBillingLine.findFirst({
            where: { scheduleId: schedule.id, billing: { status: { not: "Void" } } },
            select: { id: true },
        });
        if (claimedNow) return { count: 0 };
        return tx.paymentSchedule.updateMany({
            where: {
                id: schedule.id,
                status: "Pending",
                qbPaymentId: null,
                qbInvoiceId: null,
                amount: schedule.amount,
                name: schedule.name,
                dueDate: schedule.dueDate,
            },
            // qbSyncError: null — a fresh invoice clears any prior voided/notFound flag (self-heal).
            data: { qbInvoiceId: qbId, qbInvoiceLink: payLink, qbSyncedAt: new Date(), qbSyncError: null },
        });
    }));
    if (linked.count !== 1) {
        const compensated = await deleteQBInvoice(tokens, qbId).catch(() => false);
        if (!compensated) {
            console.error(`[quickbooks-payments] milestone ${schedule.id} changed mid-push and compensating delete of QBO invoice ${qbId} (${docNumber}) failed — delete it in QuickBooks manually`);
            throw new Error(`This milestone changed while staging its QuickBooks invoice, and the abandoned QuickBooks invoice ${docNumber} (id ${qbId}) could not be deleted — remove it in QuickBooks, then retry.`);
        }
        throw new Error("This milestone changed while staging its QuickBooks invoice — refresh and try again.");
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
 */
export async function settleMilestoneFromQBPayment(input: {
    paymentScheduleId: string;
    invoiceId: string;
    qbPaymentId: string | null;
    paidAt: Date;
    referenceNumber: string | null;
}): Promise<boolean> {
    const { paymentScheduleId, invoiceId, ...payment } = input;
    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. This settle mirrors onto the
        // estimate copy, so read the estimate link (non-locking) and lock Estimate before Invoice,
        // matching recordPayment/recordEstimatePayment so overlapping settles never invert order.
        const invLink = await t.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(t, { estimateId: invLink?.estimateId, invoiceId });

        const claimed = await settleMilestonePaidInTx(t, paymentScheduleId, invoiceId, payment);
        if (!claimed) return false;

        // Durable notification, enqueued in-tx (delivered by the drainer after commit).
        await enqueueMilestonePaid(t, { scheduleId: paymentScheduleId, scheduleType: "invoice" });
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
}

/**
 * Poll QuickBooks for settled milestone invoices and record them in ProBuild.
 * Safe to run repeatedly (cron + on-view). Never throws on a single bad row.
 */
export async function syncQuickBooksPayments(scope?: { invoiceId?: string; projectId?: string }): Promise<QBPaymentSyncResult> {
    const result: QBPaymentSyncResult = { checked: 0, settled: 0, partiallyPaid: 0, errors: [], progressBillingsSettled: 0 };

    const pending = await prisma.paymentSchedule.findMany({
        where: {
            status: "Pending",
            qbInvoiceId: { not: null },
            ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
            ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
        },
        select: {
            id: true, invoiceId: true, qbInvoiceId: true, qbSyncError: true, name: true, amount: true,
            invoice: { select: { code: true, project: { select: { id: true, name: true } }, client: { select: { name: true, email: true } } } },
        },
        take: 100,
    });

    // Progress billings (src/lib/progress-billing.ts) staged/sent to QuickBooks
    // — a second, independent pass over the same QBO connection. Milestones
    // billed through a ProgressBilling are NOT in `pending` above (billing
    // them there doesn't touch PaymentSchedule.qbInvoiceId), so this pass is
    // the only place they get settled from a QuickBooks payment.
    const pendingBillings = await prisma.progressBilling.findMany({
        where: {
            qbInvoiceId: { not: null },
            status: { in: ["Staged", "Sent"] },
            ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
            ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
        },
        select: {
            id: true, invoiceId: true, qbInvoiceId: true, code: true,
            lines: { select: { scheduleId: true } },
            invoice: { select: { code: true, estimateId: true } },
        },
        take: 100,
    });

    if (pending.length === 0 && pendingBillings.length === 0) return result;

    let tokens: QBTokens;
    try {
        tokens = await getFreshQBTokens();
    } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "QB tokens unavailable");
        return result;
    }

    // Milestones whose linked QBO invoice was found voided/deleted THIS run (flag was
    // previously null). Reported once per breakage; a re-push clears the flag and re-arms.
    const newlyFlagged: QBSyncIssue[] = [];

    for (const schedule of pending) {
        result.checked++;
        try {
            const probe = await probeQBInvoice(tokens, schedule.qbInvoiceId!);
            // Transient error (token/429/5xx/network) — leave untouched and retry next run.
            if (probe.state === "error") continue;

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
                continue;
            }

            // probe.state === "ok"
            if (probe.total > 0 && probe.balance <= 0) {
                // Fully settled in QuickBooks (online payment OR a check Vanessa applied)
                const paymentId = probe.paymentTxnIds[0] || null;
                let paidAt = new Date();
                let referenceNumber: string | null = null;
                if (paymentId) {
                    const p = await getQBPayment(tokens, paymentId);
                    if (p?.txnDate) paidAt = new Date(`${p.txnDate}T12:00:00Z`);
                    referenceNumber = p?.referenceNumber || null;
                }
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
        } catch (e) {
            result.errors.push(`${schedule.invoice.code}/${schedule.name}: ${e instanceof Error ? e.message : "sync failed"}`);
        }
    }

    // ── Progress billings ───────────────────────────────────────────────────
    // Same probe → settle shape as the milestone loop above, but claims ONE
    // ProgressBilling row and settles it via settleProgressBillingPaidCore,
    // which walks every line the billing carries under a single lock+transaction
    // (custom/change-order lines were materialized into a real PaymentSchedule
    // at billing-creation time — see createProgressBillingCore — so every line
    // has a scheduleId and settles like any other milestone; no special case).
    for (const billing of pendingBillings) {
        try {
            const probe = await probeQBInvoice(tokens, billing.qbInvoiceId!);
            if (probe.state === "error") continue; // transient — retry next run
            if (probe.state === "voided" || probe.state === "notFound") {
                result.errors.push(`${billing.invoice.code}/${billing.code}: QBO invoice ${probe.state}`);
                continue;
            }
            // probe.state === "ok"
            if (probe.total > 0 && probe.balance <= 0) {
                const paymentId = probe.paymentTxnIds[0] || null;
                let paidAt = new Date();
                let referenceNumber: string | null = null;
                if (paymentId) {
                    const p = await getQBPayment(tokens, paymentId);
                    if (p?.txnDate) paidAt = new Date(`${p.txnDate}T12:00:00Z`);
                    referenceNumber = p?.referenceNumber || null;
                }
                const settled = await settleProgressBillingPaidCore(billing.id, { paidAt, referenceNumber, qbPaymentId: paymentId });
                if (settled) result.progressBillingsSettled++;
            } else if (probe.balance < probe.total) {
                result.partiallyPaid++;
            }
        } catch (e) {
            result.errors.push(`${billing.invoice.code}/${billing.code}: ${e instanceof Error ? e.message : "sync failed"}`);
        }
    }

    if (newlyFlagged.length > 0) {
        const { notifyQBSyncIssues } = await import("./payment-notifications");
        await notifyQBSyncIssues(newlyFlagged);
    }

    return result;
}
