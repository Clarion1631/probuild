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
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import { enqueueMilestonePaid, drainPaymentNotifications } from "./payment-outbox";
import { toNum, deriveInvoiceTaxFields } from "./prisma-helpers";
import { getQBSettings, saveQBSettings } from "./integration-store";
import { deriveInvoiceStatus } from "./invoice-lifecycle";
import {
    type QBTokens,
    refreshQBToken,
    ensureQBCustomer,
    ensureQBServiceItem,
    createQBMilestoneInvoice,
    getQBInvoicePaymentLink,
    getQBInvoiceStatus,
    probeQBInvoice,
    getQBPayment,
} from "./quickbooks";
import type { QBSyncIssue } from "./payment-notifications";
import { qboAmountsMatch, validateQboMappingIdentity } from "./qbo-mapping-integrity";

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

    const tokens = passedTokens ?? await getFreshQBTokens();

    if (schedule.qbInvoiceId) {
        const identityIssue = validateQboMappingIdentity({
            mappingCount: await prisma.paymentSchedule.count({
                where: {
                    qbInvoiceId: schedule.qbInvoiceId,
                    OR: [{ qbRealmId: tokens.realmId }, { qbRealmId: null }],
                },
            }),
            boundRealmId: schedule.qbRealmId,
            activeRealmId: tokens.realmId,
        });
        if (identityIssue) {
            throw new Error(identityIssue.kind === "duplicate_qbo_mapping"
                ? "QuickBooks invoice is linked to multiple milestones; break the duplicate link before continuing"
                : "QuickBooks invoice realm is unbound or changed; run the lifecycle migration or break and recreate the link");
        }
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
    if (!qboAmountsMatch(amount, total)) {
        console.warn(`[quickbooks-payments] QBO total drift on ${docNumber}: ProBuild ${amount} vs QBO ${total}`);
    }

    const payLink = await getQBInvoicePaymentLink(tokens, qbId);

    await prisma.paymentSchedule.update({
        where: { id: schedule.id },
        // qbSyncError: null — a fresh invoice clears any prior voided/notFound flag (self-heal).
        data: { qbInvoiceId: qbId, qbRealmId: tokens.realmId, qbInvoiceLink: payLink, qbSyncedAt: new Date(), qbSyncError: null },
    });

    return { qbInvoiceId: qbId, payLink, qbTotal: total };
}

/**
 * Mark a milestone Paid from a QuickBooks settlement. Mirrors the Stripe
 * webhook's claim-then-recalculate transaction so balances never drift.
 */
export async function markMilestonePaidFromQB(
    paymentScheduleId: string,
    invoiceId: string,
    payment: { paidAt: Date; referenceNumber: string | null; qbPaymentId: string | null },
    settlement: { qbInvoiceId: string; realmId: string; qboTotal: number },
): Promise<boolean> {
    return withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. This settle mirrors onto the
        // estimate copy, so read the estimate link (non-locking) and lock Estimate before Invoice,
        // matching recordPayment/recordEstimatePayment so overlapping settles never invert order.
        const invLink = await t.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(t, { estimateId: invLink?.estimateId, invoiceId });

        // Revalidate the money evidence after taking the invoice lock. This
        // closes the gap between a worker's QBO probe and the settlement write.
        const currentSchedule = await t.paymentSchedule.findUnique({ where: { id: paymentScheduleId } });
        if (!currentSchedule || currentSchedule.invoiceId !== invoiceId
            || !qboAmountsMatch(toNum(currentSchedule.amount), settlement.qboTotal)) return false;
        const mappingStillMatches = currentSchedule.qbInvoiceId === settlement.qbInvoiceId
            && currentSchedule.qbRealmId === settlement.realmId;
        const linkWasExplicitlyBroken = currentSchedule.qbInvoiceId === null && currentSchedule.qbRealmId === null;
        if (!mappingStillMatches && !linkWasExplicitlyBroken) return false;
        if (mappingStillMatches) {
            const unsafeMappingCount = await t.paymentSchedule.count({
                where: {
                    qbInvoiceId: settlement.qbInvoiceId,
                    OR: [{ qbRealmId: settlement.realmId }, { qbRealmId: null }],
                },
            });
            if (unsafeMappingCount !== 1) return false;
        }

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
                status: deriveInvoiceStatus({
                    currentStatus: invoice.status,
                    balanceDue: newBalance,
                    issueDate: invoice.issueDate,
                    sentAt: invoice.sentAt,
                    paymentStatuses: allSchedules.map(schedule => schedule.status),
                }),
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
 * Recalc/mirror logic is modeled on `markMilestonePaidFromQB` above — link-first
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

        const oldAmount = toNum(schedule.amount);
        // Idempotent: a re-submit with the same QBO total is a no-op.
        if (Math.abs(oldAmount - newAmount) <= 0.005) {
            return { ok: true, oldAmount, newAmount, invoiceId: schedule.invoiceId, estimateTouched: false };
        }

        // 1) Claimed update of the invoice-side amount — mirrors markMilestonePaidFromQB's
        //    pattern so a concurrent settle (QB sync / Stripe) that marks the row Paid
        //    between the read above and this write can't have its amount overwritten.
        const claim = await t.paymentSchedule.updateMany({
            where: { id: schedule.id, status: { notIn: ["Paid", "Canceled"] } },
            data: { amount: newAmount, qbSyncedAt: new Date() },
        });
        if (claim.count === 0) {
            return { ok: false, error: "Milestone changed status (paid or canceled) — reload and try again." };
        }

        // 2) Recompute the parent invoice (mirror markMilestonePaidFromQB's recalc,
        //    extended to also move totalAmount since an amount change moves the grand total).
        const invoice = await t.invoice.findUnique({ where: { id: schedule.invoiceId } });
        if (!invoice) return { ok: false, error: "Invoice not found" };
        const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId: schedule.invoiceId } });
        const newTotal = r2(allSchedules.reduce((sum, s) => sum + toNum(s.amount), 0));
        const totalPaid = r2(allSchedules.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0));
        const newBalance = Math.max(0, r2(newTotal - totalPaid));
        const invoiceRate = toNum(invoice.taxRate);
        const tax = deriveInvoiceTaxFields(newTotal, invoiceRate, invoiceRate <= 0);
        await t.invoice.update({
            where: { id: invoice.id },
            data: {
                totalAmount: newTotal,
                subtotal: tax.subtotal,
                taxAmount: tax.taxAmount,
                balanceDue: newBalance,
                status: deriveInvoiceStatus({
                    currentStatus: invoice.status,
                    balanceDue: newBalance,
                    issueDate: invoice.issueDate,
                    sentAt: invoice.sentAt,
                    paymentStatuses: allSchedules.map(schedule => schedule.status),
                }),
            },
        });

        // 3) Mirror onto the estimate-side copy (link-first via sourceScheduleId,
        //    name + OLD-amount fallback for pre-link rows; only touch an unpaid copy)
        //    and recompute the estimate, matching markMilestonePaidFromQB's mirror block.
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
            id: true, invoiceId: true, qbInvoiceId: true, qbRealmId: true, qbSyncError: true, name: true, amount: true,
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

    // Milestones whose linked QBO invoice was found voided/deleted THIS run (flag was
    // previously null). Reported once per breakage; a re-push clears the flag and re-arms.
    const newlyFlagged: QBSyncIssue[] = [];
    const mappingRows = await prisma.paymentSchedule.groupBy({
        by: ["qbRealmId", "qbInvoiceId"],
        where: { qbInvoiceId: { in: pending.map(schedule => schedule.qbInvoiceId!) } },
        _count: { _all: true },
    });
    const mappingCounts = new Map(mappingRows.map(row => [`${row.qbRealmId ?? "<unbound>"}:${row.qbInvoiceId}`, row._count._all]));

    for (const schedule of pending) {
        result.checked++;
        try {
            const identityIssue = validateQboMappingIdentity({
                mappingCount: (mappingCounts.get(`${tokens.realmId}:${schedule.qbInvoiceId}`) ?? 0)
                    + (mappingCounts.get(`<unbound>:${schedule.qbInvoiceId}`) ?? 0),
                boundRealmId: schedule.qbRealmId,
                activeRealmId: tokens.realmId,
            });
            if (identityIssue) {
                result.errors.push(identityIssue.kind === "duplicate_qbo_mapping"
                    ? `${schedule.invoice.code}/${schedule.name}: duplicate QBO invoice mapping; settlement quarantined`
                    : `${schedule.invoice.code}/${schedule.name}: QBO realm is unbound or changed; settlement quarantined`);
                continue;
            }
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
            if (!qboAmountsMatch(Number(schedule.amount), probe.total)) {
                result.errors.push(`${schedule.invoice.code}/${schedule.name}: QBO total differs from ProBuild; settlement quarantined`);
                continue;
            }
            if (probe.total > 0 && probe.balance <= 0) {
                // Fully settled in QuickBooks (online payment OR a check Vanessa applied)
                const paymentId = probe.paymentTxnIds[0] || null;
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
                }, { qbInvoiceId: schedule.qbInvoiceId!, realmId: tokens.realmId, qboTotal: probe.total });
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

    if (newlyFlagged.length > 0) {
        const { notifyQBSyncIssues } = await import("./payment-notifications");
        await notifyQBSyncIssues(newlyFlagged);
    }

    return result;
}
