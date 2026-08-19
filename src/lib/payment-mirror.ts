import { Prisma } from "@prisma/client";
import { toNum } from "@/lib/prisma-helpers";

/**
 * Mirror helpers for the estimate/invoice milestone pair.
 *
 * Estimate and invoice milestones are mirrored copies linked by
 * `PaymentSchedule.sourceScheduleId` (see CLAUDE.md). Settling or unsettling
 * either side must move the other, or the two documents disagree about how much
 * the client has paid. The manual (`recordPaymentCore` / `unrecordPayment`),
 * QuickBooks (`quickbooks-payments.ts`) and estimate-side Stripe
 * (`stripe-estimate-settlement.ts`) rails each carried their own copy of this
 * logic; the invoice-side Stripe rails carried none, which is what these helpers
 * fix.
 *
 * All of them run INSIDE an existing money-path transaction whose caller has
 * already taken the canonical Estimate → Invoice row locks (`lockMoneyParents`).
 * They only touch the MIRROR side and its parent aggregate — the caller still
 * owns the primary side it settled.
 *
 * UNSETTLING is not here. It used to be — a matching set of one-row unwind
 * helpers keyed off `sourceScheduleId` plus the PaymentIntent. But that link
 * identifies a mirror GROUP rather than a row (invoice conversion clones a paid
 * estimate milestone, intent and all), so a per-row unwind could only ever fix
 * one member of a refunded charge and had to bail out as "ambiguous" whenever
 * there were several. Refunds now unwind the whole charge group at once — see
 * `refund-group.ts`.
 */

type Tx = Prisma.TransactionClient;

type ScheduleRef = {
    id: string;
    name: string;
    amount: unknown;
    sourceScheduleId?: string | null;
};

export type MirrorSettleData = {
    paymentDate: Date;
    paidAt: Date;
    paymentMethod?: string | null;
    stripeSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    referenceNumber?: string | null;
};

/**
 * Locate the UNPAID estimate-side original of an invoice milestone that was just
 * paid. Link-first via `sourceScheduleId`; a name+amount match is accepted only
 * when EXACTLY one unpaid candidate exists, which is the same pre-link legacy
 * fallback the manual and QuickBooks rails use.
 */
async function findUnpaidEstimateMirror(
    tx: Tx,
    estimateId: string,
    payment: ScheduleRef,
): Promise<{ id: string } | null> {
    const statusFilter = { status: { not: "Paid" } };
    if (payment.sourceScheduleId) {
        return await tx.estimatePaymentSchedule.findFirst({
            where: { id: payment.sourceScheduleId, estimateId, ...statusFilter },
            select: { id: true },
        });
    }
    // No `take` here: the ambiguity check must see EVERY same-name row, or a
    // third non-matching row can push a second amount-match out of the window
    // and make a genuinely ambiguous fallback look unique. Milestone counts are
    // small (tens per estimate), so the unbounded read is cheap.
    const candidates = await tx.estimatePaymentSchedule.findMany({
        where: { estimateId, name: payment.name, ...statusFilter },
    });
    const matching = candidates.filter((c) => toNum(c.amount) === toNum(payment.amount));
    return matching.length === 1 ? { id: matching[0].id } : null;
}

/**
 * Recompute an estimate's balance/status from its own milestones. `zeroPaid`
 * decides what the estimate reverts to once nothing is paid: `"restore"` puts
 * back the captured pre-payment status (unsettle), `"keep"` leaves the current
 * status alone (settle, where a zero total means nothing changed).
 *
 * The `statusBeforePayment ?? …` fallback only fires for legacy rows settled
 * before that column was captured. It is derived rather than hard-coded because
 * the two refund rails disagreed on it: the mirror path always ran on an
 * estimate that had an invoice and fell back to "Invoiced", while the
 * estimate-side webhook branch could run on an un-invoiced estimate and fell
 * back to "Approved". Asking whether an invoice exists reproduces both.
 */
export async function recomputeEstimate(tx: Tx, estimateId: string, zeroPaid: "restore" | "keep"): Promise<void> {
    const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) return;
    const siblings = await tx.estimatePaymentSchedule.findMany({ where: { estimateId } });
    const paid = siblings
        .filter((s) => s.status === "Paid")
        .reduce((sum, s) => sum + toNum(s.amount), 0);
    const balance = Math.max(0, toNum(estimate.totalAmount) - paid);
    // Captured so a later unsettle can restore the pre-payment status.
    const capturePriorStatus = paid > 0 && !["Paid", "Partially Paid"].includes(estimate.status);
    const restoredStatus = paid === 0 && zeroPaid === "restore" && !estimate.statusBeforePayment
        ? ((await tx.invoice.count({ where: { estimateId } })) > 0 ? "Invoiced" : "Approved")
        : null;
    const status = paid === 0
        ? (zeroPaid === "restore" ? estimate.statusBeforePayment ?? restoredStatus! : estimate.status)
        : balance <= 0 ? "Paid"
        : "Partially Paid";
    await tx.estimate.update({
        where: { id: estimateId },
        data: {
            balanceDue: balance,
            status,
            ...(capturePriorStatus && { statusBeforePayment: estimate.status }),
            ...(paid === 0 && zeroPaid === "restore" && { statusBeforePayment: null }),
        },
    });
}

/** Recompute an invoice's balance/status from its own milestones. */
export async function recomputeInvoice(tx: Tx, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return;
    const siblings = await tx.paymentSchedule.findMany({ where: { invoiceId } });
    const paid = siblings
        .filter((s) => s.status === "Paid")
        .reduce((sum, s) => sum + toNum(s.amount), 0);
    const balance = Math.max(0, toNum(invoice.totalAmount) - paid);
    await tx.invoice.update({
        where: { id: invoiceId },
        data: {
            balanceDue: balance,
            status: balance <= 0 ? "Paid" : paid > 0 ? "Partially Paid" : "Issued",
        },
    });
}

/**
 * Settle the estimate-side copy of an invoice milestone that was just paid, and
 * recompute the estimate. Returns true when a mirror was actually claimed.
 */
export async function mirrorInvoiceSettleToEstimate(
    tx: Tx,
    args: { estimateId: string | null | undefined; payment: ScheduleRef; data: MirrorSettleData },
): Promise<boolean> {
    if (!args.estimateId) return false;
    const mirror = await findUnpaidEstimateMirror(tx, args.estimateId, args.payment);
    if (!mirror) return false;
    const claim = await tx.estimatePaymentSchedule.updateMany({
        where: { id: mirror.id, estimateId: args.estimateId, status: { not: "Paid" } },
        data: {
            status: "Paid",
            paymentDate: args.data.paymentDate,
            paidAt: args.data.paidAt,
            paymentMethod: args.data.paymentMethod,
            ...(args.data.stripeSessionId !== undefined && { stripeSessionId: args.data.stripeSessionId }),
            ...(args.data.stripePaymentIntentId !== undefined && { stripePaymentIntentId: args.data.stripePaymentIntentId }),
            ...(args.data.referenceNumber !== undefined && { referenceNumber: args.data.referenceNumber }),
        },
    });
    if (claim.count === 0) return false;
    await recomputeEstimate(tx, args.estimateId, "keep");
    return true;
}

