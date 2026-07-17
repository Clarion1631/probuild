import { Prisma } from "@prisma/client";
import { enqueueMilestonePaid } from "@/lib/payment-outbox";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { lockMoneyParents, withTxRetry } from "@/lib/tx-retry";

export type StripeEstimateSettlement = {
    stripeSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    paymentMethod: string;
    paymentDate: Date;
    paidAt: Date;
};

type SettleStripeEstimatePaymentInput = {
    estimateId: string;
    scheduleId: string;
    settlement: StripeEstimateSettlement;
    enqueueNotification: boolean;
    dryRun?: boolean;
};

export type SettleStripeEstimatePaymentResult = {
    found: boolean;
    changed: boolean;
    estimateClaimed: boolean;
    mirroredCopyId: string | null;
    mirrorClaimed: boolean;
    notificationEnqueued: boolean;
};

const unchangedResult: SettleStripeEstimatePaymentResult = {
    found: false,
    changed: false,
    estimateClaimed: false,
    mirroredCopyId: null,
    mirrorClaimed: false,
    notificationEnqueued: false,
};

function paymentData(settlement: StripeEstimateSettlement): Prisma.EstimatePaymentScheduleUpdateManyMutationInput {
    return {
        status: "Paid",
        stripeSessionId: settlement.stripeSessionId,
        stripePaymentIntentId: settlement.stripePaymentIntentId,
        paymentMethod: settlement.paymentMethod,
        paymentDate: settlement.paymentDate,
        paidAt: settlement.paidAt,
    };
}

/**
 * Settle an estimate-side Stripe milestone and reconcile its invoice mirror.
 *
 * The durable mirror identity is PaymentSchedule.sourceScheduleId. Name+amount
 * is accepted only for one unlinked legacy row on the deterministic oldest
 * invoice. Both parent aggregates are recomputed while holding the canonical
 * Estimate -> Invoice locks, and the whole transaction is retryable.
 */
export async function settleStripeEstimatePayment(
    input: SettleStripeEstimatePaymentInput,
): Promise<SettleStripeEstimatePaymentResult> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(tx, { estimateId: input.estimateId });
        const lockedInvoice = await tx.invoice.findFirst({
            where: { estimateId: input.estimateId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
        });
        if (lockedInvoice) {
            await lockMoneyParents(tx, { invoiceId: lockedInvoice.id });
        }

        // Re-read after the parent locks. The route-level lookup is context only
        // and may be stale by the time this transaction begins.
        const schedule = await tx.estimatePaymentSchedule.findUnique({
            where: { id: input.scheduleId },
        });
        const estimate = await tx.estimate.findUnique({
            where: { id: input.estimateId },
        });
        if (!schedule || schedule.estimateId !== input.estimateId || !estimate) {
            return unchangedResult;
        }

        const invoice = lockedInvoice
            ? await tx.invoice.findUnique({
                where: { id: lockedInvoice.id },
                include: { payments: true },
            })
            : null;

        let mirror = null as (typeof invoice extends null ? never : NonNullable<typeof invoice>["payments"][number]) | null;
        if (invoice) {
            const linked = invoice.payments.find((copy) => copy.sourceScheduleId === schedule.id);
            const legacyCandidates = linked
                ? []
                : invoice.payments.filter((copy) =>
                    !copy.sourceScheduleId
                    && copy.name === schedule.name
                    && toNum(copy.amount) === toNum(schedule.amount)
                );
            mirror = linked ?? (legacyCandidates.length === 1 ? legacyCandidates[0] : null);
        }

        let mirrorClaimed = false;
        if (mirror && mirror.status !== "Paid") {
            if (input.dryRun) {
                mirrorClaimed = true;
            } else if (invoice) {
                const claim = await tx.paymentSchedule.updateMany({
                    where: { id: mirror.id, invoiceId: invoice.id, status: { not: "Paid" } },
                    data: paymentData(input.settlement),
                });
                mirrorClaimed = claim.count === 1;
            }
        }

        let estimateClaimed = false;
        if (schedule.status !== "Paid") {
            if (input.dryRun) {
                estimateClaimed = true;
            } else {
                const claim = await tx.estimatePaymentSchedule.updateMany({
                    where: { id: schedule.id, estimateId: input.estimateId, status: { not: "Paid" } },
                    data: paymentData(input.settlement),
                });
                estimateClaimed = claim.count === 1;
            }
        }

        const estimateSiblings = await tx.estimatePaymentSchedule.findMany({
            where: { estimateId: input.estimateId },
        });
        const estimatePaid = estimateSiblings.reduce((sum, sibling) => {
            const paid = sibling.id === schedule.id
                ? sibling.status === "Paid" || estimateClaimed
                : sibling.status === "Paid";
            return paid ? sum + toNum(sibling.amount) : sum;
        }, 0);
        const estimateBalance = Math.max(0, toNum(estimate.totalAmount) - estimatePaid);
        const estimateStatus = estimateBalance <= 0
            ? "Paid"
            : estimatePaid > 0 ? "Partially Paid" : estimate.status;
        const capturePriorStatus = estimateClaimed && !["Paid", "Partially Paid"].includes(estimate.status);
        const estimateParentChanged = toNum(estimate.balanceDue) !== estimateBalance
            || estimate.status !== estimateStatus
            || (capturePriorStatus && estimate.statusBeforePayment !== estimate.status);

        if (!input.dryRun && estimateParentChanged) {
            await tx.estimate.update({
                where: { id: input.estimateId },
                data: {
                    balanceDue: estimateBalance,
                    status: estimateStatus,
                    ...(capturePriorStatus && { statusBeforePayment: estimate.status }),
                },
            });
        }

        let invoiceParentChanged = false;
        if (invoice && mirror) {
            const invoiceSiblings = await tx.paymentSchedule.findMany({
                where: { invoiceId: invoice.id },
            });
            const invoicePaid = invoiceSiblings.reduce((sum, sibling) => {
                const paid = sibling.id === mirror.id
                    ? sibling.status === "Paid" || mirrorClaimed
                    : sibling.status === "Paid";
                return paid ? sum + toNum(sibling.amount) : sum;
            }, 0);
            const invoiceBalance = Math.max(0, toNum(invoice.totalAmount) - invoicePaid);
            const invoiceStatus = invoiceBalance <= 0
                ? "Paid"
                : invoicePaid > 0 ? "Partially Paid" : invoice.status;
            invoiceParentChanged = toNum(invoice.balanceDue) !== invoiceBalance || invoice.status !== invoiceStatus;

            if (!input.dryRun && invoiceParentChanged) {
                await tx.invoice.update({
                    where: { id: invoice.id },
                    data: { balanceDue: invoiceBalance, status: invoiceStatus },
                });
            }
        }

        // A repair/replay never creates lifecycle side effects. When a mirror
        // exists, both fresh claims must win; a pre-settled invoice copy means
        // that rail already owns the notification event.
        const notificationEnqueued = !input.dryRun
            && input.enqueueNotification
            && estimateClaimed
            && (!mirror || mirrorClaimed);
        if (notificationEnqueued) {
            await enqueueMilestonePaid(tx, { scheduleId: schedule.id, scheduleType: "estimate" });
        }

        return {
            found: true,
            changed: estimateClaimed || mirrorClaimed || estimateParentChanged || invoiceParentChanged,
            estimateClaimed,
            mirroredCopyId: mirror?.id ?? null,
            mirrorClaimed,
            notificationEnqueued,
        };
    }));
}
