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
 */

type Tx = Prisma.TransactionClient;

type ScheduleRef = {
    id: string;
    name: string;
    amount: unknown;
    sourceScheduleId?: string | null;
    stripePaymentIntentId?: string | null;
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
 * Locate the estimate-side original of an invoice milestone. Link-first via
 * `sourceScheduleId`; a name+amount match is accepted only when EXACTLY one
 * unpaid/paid candidate exists, which is the same pre-link legacy fallback the
 * manual and QuickBooks rails use.
 */
async function findEstimateMirror(
    tx: Tx,
    estimateId: string,
    payment: ScheduleRef,
    wantStatus: "Paid" | "Unpaid",
): Promise<{ id: string } | null> {
    const statusFilter = wantStatus === "Paid" ? { status: "Paid" } : { status: { not: "Paid" } };
    // Unsettling additionally requires the mirror to belong to the SAME charge:
    // a row settled through some other intent must never be released by this
    // refund. A null intent is accepted because manual and legacy settlements
    // carry none.
    const intentFilter = wantStatus === "Paid" && payment.stripePaymentIntentId
        ? { OR: [{ stripePaymentIntentId: payment.stripePaymentIntentId }, { stripePaymentIntentId: null }] }
        : {};
    if (payment.sourceScheduleId) {
        return await tx.estimatePaymentSchedule.findFirst({
            where: { id: payment.sourceScheduleId, estimateId, ...statusFilter, ...intentFilter },
            select: { id: true },
        });
    }
    // No `take` here: the ambiguity check must see EVERY same-name row, or a
    // third non-matching row can push a second amount-match out of the window
    // and make a genuinely ambiguous fallback look unique. Milestone counts are
    // small (tens per estimate), so the unbounded read is cheap.
    const candidates = await tx.estimatePaymentSchedule.findMany({
        where: { estimateId, name: payment.name, ...statusFilter, ...intentFilter },
    });
    const matching = candidates.filter((c) => toNum(c.amount) === toNum(payment.amount));
    return matching.length === 1 ? { id: matching[0].id } : null;
}

/**
 * Recompute an estimate's balance/status from its own milestones. `zeroPaid`
 * decides what the estimate reverts to once nothing is paid: `"restore"` puts
 * back the captured pre-payment status (unsettle), `"keep"` leaves the current
 * status alone (settle, where a zero total means nothing changed).
 */
async function recomputeEstimate(tx: Tx, estimateId: string, zeroPaid: "restore" | "keep"): Promise<void> {
    const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) return;
    const siblings = await tx.estimatePaymentSchedule.findMany({ where: { estimateId } });
    const paid = siblings
        .filter((s) => s.status === "Paid")
        .reduce((sum, s) => sum + toNum(s.amount), 0);
    const balance = Math.max(0, toNum(estimate.totalAmount) - paid);
    // Captured so a later unsettle can restore the pre-payment status.
    const capturePriorStatus = paid > 0 && !["Paid", "Partially Paid"].includes(estimate.status);
    const status = paid === 0
        ? (zeroPaid === "restore" ? estimate.statusBeforePayment ?? "Invoiced" : estimate.status)
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
async function recomputeInvoice(tx: Tx, invoiceId: string): Promise<void> {
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
    const mirror = await findEstimateMirror(tx, args.estimateId, args.payment, "Unpaid");
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

/**
 * Unsettle the estimate-side copy of an invoice milestone that was just fully
 * refunded, and recompute the estimate.
 */
export async function mirrorInvoiceUnsettleToEstimate(
    tx: Tx,
    args: { estimateId: string | null | undefined; payment: ScheduleRef },
): Promise<boolean> {
    if (!args.estimateId) return false;
    const mirror = await findEstimateMirror(tx, args.estimateId, args.payment, "Paid");
    if (!mirror) return false;
    const claim = await tx.estimatePaymentSchedule.updateMany({
        where: { id: mirror.id, estimateId: args.estimateId, status: "Paid" },
        // Deliberately leaves the Stripe ids in place, matching the primary
        // refund reset. They are how a redelivered `charge.refunded` re-finds
        // this row; clearing them would let a duplicate delivery land on a
        // DIFFERENT clone sharing the same intent and unset a real payment.
        // (That a Pending row still carrying an intent is refused by progress
        // billing is a real, pre-existing gap — tracked separately, because
        // fixing it means fixing the refund row-identity problem first.)
        data: { status: "Pending", paidAt: null, paymentDate: null },
    });
    if (claim.count === 0) return false;
    await recomputeEstimate(tx, args.estimateId, "restore");
    return true;
}

/**
 * Find the invoice-side copy of an estimate milestone.
 *
 * `sourceScheduleId` identifies a mirror GROUP, not a single row — one estimate
 * milestone can have several invoice-side clones (progress billing clones them,
 * and `convertEstimateToInvoice` copies the whole schedule). So the link alone
 * is not enough to pick the row a specific charge settled. Order of preference:
 *
 *  1. The Paid clone carrying this charge's PaymentIntent — exact, when unique.
 *     (The intent is copied onto clones at creation, so it is NOT unique on its
 *     own; combining it with the link is what makes the match safe.)
 *  2. The Paid linked clone, but ONLY when exactly one exists.
 *
 * Anything ambiguous returns null and the mirror is left alone rather than
 * guessed at — a wrong unsettle would silently move a client-visible balance.
 */
export async function findInvoiceMirrorOfEstimateSchedule(
    tx: Tx,
    schedule: ScheduleRef,
): Promise<{ id: string; invoiceId: string } | null> {
    const linked = await tx.paymentSchedule.findMany({
        where: { sourceScheduleId: schedule.id, status: "Paid" },
        select: { id: true, invoiceId: true, stripePaymentIntentId: true },
    });
    if (schedule.stripePaymentIntentId) {
        // Same-charge only. A clone carrying a DIFFERENT non-null intent was
        // settled by another payment and must never be released by this refund,
        // so it is excluded rather than accepted as a sole fallback.
        const sameCharge = linked.filter((row) =>
            row.stripePaymentIntentId === schedule.stripePaymentIntentId
            || row.stripePaymentIntentId === null
        );
        const exact = sameCharge.filter((row) => row.stripePaymentIntentId === schedule.stripePaymentIntentId);
        if (exact.length === 1) return { id: exact[0].id, invoiceId: exact[0].invoiceId };
        if (exact.length > 1) return null;
        return sameCharge.length === 1 ? { id: sameCharge[0].id, invoiceId: sameCharge[0].invoiceId } : null;
    }
    return linked.length === 1 ? { id: linked[0].id, invoiceId: linked[0].invoiceId } : null;
}

/**
 * Unsettle a located invoice-side mirror and recompute its invoice. The caller
 * must already hold the Invoice row lock (canonical Estimate → Invoice order).
 */
export async function mirrorEstimateUnsettleToInvoice(
    tx: Tx,
    mirror: { id: string; invoiceId: string },
): Promise<boolean> {
    const claim = await tx.paymentSchedule.updateMany({
        where: { id: mirror.id, invoiceId: mirror.invoiceId, status: "Paid" },
        // Stripe ids left in place for the same reason as the estimate-side
        // unsettle above.
        data: { status: "Pending", paidAt: null, paymentDate: null },
    });
    if (claim.count === 0) return false;
    await recomputeInvoice(tx, mirror.invoiceId);
    return true;
}
