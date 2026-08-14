import { prisma } from "./prisma";
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import { enqueueMilestonePaid, drainPaymentNotifications } from "./payment-outbox";
import { toNum } from "./prisma-helpers";

/**
 * Manual (non-QuickBooks) milestone settlement core — the transaction body of
 * the `recordPayment` server action (src/lib/actions.ts), extracted so both
 * that action AND the deposit-ingest endpoint
 * (src/app/api/payments/deposit-ingest/route.ts, Phase B1) settle a milestone
 * through the exact same claim-then-recalculate-then-mirror transaction.
 *
 * No session assertion here — this is system context. Callers own their own
 * authorization (`assertInvoicePermission` for the action; the Bearer secret
 * + strict matching for the endpoint) and must validate `input` themselves
 * (method allowlist, check-number-required-for-check, a real Date) before
 * calling in: this function trusts its input.
 */
export async function recordPaymentCore(
    paymentId: string,
    invoiceId: string,
    input: {
        paymentDate: Date;
        method: string;
        referenceNumber: string | null;
        notes: string | null;
    },
): Promise<
    | { success: true; projectId: string }
    | { success: false; error: string }
> {
    const { paymentDate, method, referenceNumber, notes } = input;

    const tx = await withTxRetry(() => prisma.$transaction(async (t) => {
        // Canonical lock order: Estimate → Invoice → schedules. Two concurrent payments on
        // DIFFERENT milestones of the SAME invoice each claim their own schedule row (no mutual
        // block), so without a parent lock they both read a stale sibling set and overwrite each
        // other's Invoice.balanceDue — one payment's balance effect is silently lost, and no
        // deadlock fires to trigger a retry. Locking the parent(s) first serializes the recompute:
        // the second call blocks until the first commits, then recomputes against fresh state.
        // Read the estimate link (non-locking) so we can lock Estimate BEFORE Invoice, matching
        // recordEstimatePayment's mirror order so the two flows never invert and deadlock.
        const invLink = await t.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(t, { estimateId: invLink?.estimateId, invoiceId });

        // ONE settle instant for BOTH sides of the mirrored pair. Calling new Date()
        // separately per side stamped them ~0.5s apart, so the invoice and estimate copies
        // of the same payment disagreed on paidAt (11 such pairs in prod as of 2026-08-14).
        // Taken AFTER the parent locks: a contended settle can wait on the lock, and a
        // stamp captured before that wait would record when we started queueing rather
        // than when we settled — landing in the previous day or month near a boundary.
        const settledAt = new Date();

        const payment = await t.paymentSchedule.findUnique({ where: { id: paymentId } });
        if (!payment) return { success: false as const, error: "Milestone not found" };
        if (payment.status === "Paid") return { success: false as const, error: "Milestone already paid" };
        if (payment.invoiceId !== invoiceId) return { success: false as const, error: "Milestone/invoice mismatch" };

        const claim = await t.paymentSchedule.updateMany({
            where: { id: paymentId, status: { not: "Paid" } },
            data: {
                status: "Paid",
                paymentDate,
                paidAt: settledAt,
                paymentMethod: method,
                referenceNumber,
                notes,
            },
        });
        if (claim.count === 0) return { success: false as const, error: "Milestone already paid" };

        // Recalculate from scratch (matches Stripe webhook) to avoid drift.
        const invoice = await t.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) return { success: false as const, error: "Invoice not found" };

        const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId } });
        const totalPaid = allSchedules
            .filter((s) => s.status === "Paid")
            .reduce((sum, s) => sum + toNum(s.amount), 0);
        const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
        const newStatus =
            newBalance <= 0 ? "Paid"
            : totalPaid > 0 ? "Partially Paid"
            : invoice.status;

        await t.invoice.update({
            where: { id: invoiceId },
            data: { balanceDue: newBalance, status: newStatus },
        });

        // Mirror to the estimate-side milestone copy so the estimate editor and
        // its balance don't drift from the invoice that actually got paid.
        // Link-first (this milestone's sourceScheduleId points at its estimate
        // original); name+amount fallback only when exactly one row matches.
        if (invoice.estimateId) {
            let estCopy: { id: string } | null = null;
            if (payment.sourceScheduleId) {
                estCopy = await t.estimatePaymentSchedule.findFirst({
                    where: { id: payment.sourceScheduleId, estimateId: invoice.estimateId, status: { not: "Paid" } },
                });
            } else {
                const candidates = await t.estimatePaymentSchedule.findMany({
                    where: { estimateId: invoice.estimateId, status: { not: "Paid" }, name: payment.name },
                    take: 2,
                });
                const matching = candidates.filter(c => toNum(c.amount) === toNum(payment.amount));
                estCopy = matching.length === 1 ? matching[0] : null;
            }
            if (estCopy) {
                const mirrorClaim = await t.estimatePaymentSchedule.updateMany({
                    where: { id: estCopy.id, status: { not: "Paid" } },
                    data: { status: "Paid", paymentDate, paidAt: settledAt, paymentMethod: method, referenceNumber },
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
                                // Captured so unrecording can restore the pre-payment status
                                ...(estFirstPayment && { statusBeforePayment: estimate.status }),
                            },
                        });
                    }
                }
            }
        }

        // Durable notification: enqueue INSIDE the tx so it commits atomically with the
        // settle — a crash before delivery can't drop the team alert / receipt / activity log.
        await enqueueMilestonePaid(t, { scheduleId: paymentId, scheduleType: "invoice" });
        return { success: true as const, projectId: invoice.projectId };
    }));

    if (!tx.success) return tx;

    // Inline fast-path delivery of the just-enqueued notification (single canonical writer,
    // via the outbox). Best-effort — the cron backstop redelivers anything left pending.
    await drainPaymentNotifications({ scheduleId: paymentId }).catch(() => {});

    return { success: true, projectId: tx.projectId };
}
