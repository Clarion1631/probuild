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
import { prisma } from "./prisma";
import { toNum } from "./prisma-helpers";
import { getQBSettings, saveQBSettings } from "./integration-store";
import {
    type QBTokens,
    refreshQBToken,
    ensureQBCustomer,
    ensureQBServiceItem,
    createQBMilestoneInvoice,
    getQBInvoicePaymentLink,
    getQBInvoiceStatus,
    getQBPayment,
} from "./quickbooks";

export class QBNotConnectedError extends Error {
    constructor() {
        super("QuickBooks is not connected (Settings → Integrations → QuickBooks)");
        this.name = "QBNotConnectedError";
    }
}

/** Fresh tokens, persisting the rotated refresh token. Throws QBNotConnectedError. */
export async function getFreshQBTokens(): Promise<QBTokens> {
    const qb = await getQBSettings();
    if (!qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new QBNotConnectedError();
    }
    try {
        const fresh = await refreshQBToken(qb.refreshToken);
        await saveQBSettings({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch {
        // Refresh can fail transiently; the old access token may still be valid.
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
}

async function resolveCustomerAndItem(tokens: QBTokens, clientId: string): Promise<{ customerId: string; itemId: string }> {
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
export async function pushMilestoneToQuickBooks(paymentScheduleId: string): Promise<MilestonePushResult> {
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

    const tokens = await getFreshQBTokens();

    if (schedule.qbInvoiceId) {
        const payLink = schedule.qbInvoiceLink || (await getQBInvoicePaymentLink(tokens, schedule.qbInvoiceId));
        if (payLink && payLink !== schedule.qbInvoiceLink) {
            await prisma.paymentSchedule.update({ where: { id: schedule.id }, data: { qbInvoiceLink: payLink } });
        }
        const status = await getQBInvoiceStatus(tokens, schedule.qbInvoiceId);
        return { qbInvoiceId: schedule.qbInvoiceId, payLink, qbTotal: status?.total };
    }

    const invoice = schedule.invoice;
    const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.clientId);

    // Stable per-milestone doc number: INV-00012-2 (position within the invoice's schedule)
    const position = invoice.payments.findIndex(p => p.id === schedule.id) + 1 || 1;
    const docNumber = `${invoice.code}-${position}`;

    const projectName = invoice.project?.name || "Project";
    const amount = toNum(schedule.amount);

    // Carry the sales tax explicitly so Vanessa's QBO sales-tax reporting sees
    // the liability. The milestone amount is tax-inclusive; split it using the
    // invoice's rate (each milestone carries its proportional share of tax).
    const taxRate = toNum(invoice.taxRate);
    let tax: { preTaxAmount: number; taxAmount: number } | null = null;
    if (taxRate > 0) {
        const preTaxAmount = Math.round((amount / (1 + taxRate / 100)) * 100) / 100;
        const taxAmount = Math.round((amount - preTaxAmount) * 100) / 100;
        if (taxAmount > 0) tax = { preTaxAmount, taxAmount };
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

    await prisma.paymentSchedule.update({
        where: { id: schedule.id },
        data: { qbInvoiceId: qbId, qbInvoiceLink: payLink, qbSyncedAt: new Date() },
    });

    return { qbInvoiceId: qbId, payLink, qbTotal: total };
}

/**
 * Mark a milestone Paid from a QuickBooks settlement. Mirrors the Stripe
 * webhook's claim-then-recalculate transaction so balances never drift.
 */
async function markMilestonePaidFromQB(
    paymentScheduleId: string,
    invoiceId: string,
    payment: { paidAt: Date; referenceNumber: string | null; qbPaymentId: string | null }
): Promise<boolean> {
    return prisma.$transaction(async (t) => {
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
            const estCopy = settled?.sourceScheduleId
                ? await t.estimatePaymentSchedule.findFirst({
                    where: { id: settled.sourceScheduleId, estimateId: invoice.estimateId, status: { not: "Paid" } },
                  })
                : settled
                    ? await t.estimatePaymentSchedule.findFirst({
                        where: { estimateId: invoice.estimateId, status: { not: "Paid" }, name: settled.name },
                      })
                    : null;
            const amountsMatch = !!estCopy && !!settled && (settled.sourceScheduleId ? true : toNum(estCopy.amount) === toNum(settled.amount));
            if (estCopy && settled && amountsMatch) {
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
    });
}

export interface QBPaymentSyncResult {
    checked: number;
    settled: number;
    partiallyPaid: number;
    errors: string[];
}

/**
 * Poll QuickBooks for settled milestone invoices and record them in ProBuild.
 * Safe to run repeatedly (cron + on-view). Never throws on a single bad row.
 */
export async function syncQuickBooksPayments(scope?: { invoiceId?: string; projectId?: string }): Promise<QBPaymentSyncResult> {
    const result: QBPaymentSyncResult = { checked: 0, settled: 0, partiallyPaid: 0, errors: [] };

    const pending = await prisma.paymentSchedule.findMany({
        where: {
            status: "Pending",
            qbInvoiceId: { not: null },
            ...(scope?.invoiceId ? { invoiceId: scope.invoiceId } : {}),
            ...(scope?.projectId ? { invoice: { projectId: scope.projectId } } : {}),
        },
        select: {
            id: true, invoiceId: true, qbInvoiceId: true, name: true, amount: true,
            invoice: { select: { code: true, project: { select: { id: true, name: true } }, client: { select: { name: true, email: true } } } },
        },
        take: 100,
    });
    if (pending.length === 0) return result;

    let tokens: QBTokens;
    try {
        tokens = await getFreshQBTokens();
    } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "QB tokens unavailable");
        return result;
    }

    for (const schedule of pending) {
        result.checked++;
        try {
            const status = await getQBInvoiceStatus(tokens, schedule.qbInvoiceId!);
            if (!status) continue;

            if (status.total > 0 && status.balance <= 0) {
                // Fully settled in QuickBooks (online payment OR a check Vanessa applied)
                const paymentId = status.paymentTxnIds[0] || null;
                let paidAt = new Date();
                let referenceNumber: string | null = null;
                if (paymentId) {
                    const p = await getQBPayment(tokens, paymentId);
                    if (p?.txnDate) paidAt = new Date(`${p.txnDate}T12:00:00`);
                    referenceNumber = p?.referenceNumber || null;
                }
                const recorded = await markMilestonePaidFromQB(schedule.id, schedule.invoiceId, {
                    paidAt,
                    referenceNumber,
                    qbPaymentId: paymentId,
                });
                if (recorded) {
                    result.settled++;
                    const { notifyMilestonePaid } = await import("./payment-notifications");
                    await notifyMilestonePaid(schedule.id);
                }
            } else if (status.balance < status.total) {
                result.partiallyPaid++;
            }
        } catch (e) {
            result.errors.push(`${schedule.invoice.code}/${schedule.name}: ${e instanceof Error ? e.message : "sync failed"}`);
        }
    }

    return result;
}
