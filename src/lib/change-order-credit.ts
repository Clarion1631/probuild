// Credit (negative) change orders: the pure rules, shared by billing-core, the
// approval and send guards, the CO editor, and the tests. Client-safe: no prisma,
// no server imports.
//
// A credit CO (FIXED, subtotal < 0) never creates a milestone. Approving it LOWERS
// one existing unpaid milestone on the CO's invoice by the credit including tax.
// No negative milestones, no QuickBooks credit memos, no spreading in v1.

import { formatCurrency } from "./utils";

export type CoCreditCents = { pretaxCents: number; taxCents: number; totalCents: number };

/**
 * The credit in integer cents, computed with EXACTLY the formula the editor, the
 * portal signature page, the PDF and the send email display (coSignedAmount in
 * co-tax.ts): `tax = Math.round(subtotal * rate * 100) / 100`.
 *
 * billChangeOrderInTx taxes a positive CO as `Math.round(subtotalCents * rate)`.
 * For negative cents the two disagree by a cent at several of the app's rates
 * (float error lands on the other side of the .5 boundary), so a credit must
 * never use the billing formula: shown = signed = billed, to the cent. The
 * brute-force proof is in tests/change-order-credit.test.ts.
 */
export function coCreditCents(totalAmount: unknown, rate: number): CoCreditCents {
    const subtotal = Math.round((Number(totalAmount) || 0) * 100) / 100;
    const pretaxCents = Math.round(subtotal * 100);
    // `+ 0` turns the -0 a tax-exempt credit produces into 0.
    const taxCents = Math.round(subtotal * rate * 100) + 0;
    return { pretaxCents, taxCents, totalCents: pretaxCents + taxCents };
}

/** A milestone row as the credit rules see it. Decimals arrive as Prisma Decimal or number. */
export type CreditMilestoneInput = {
    id: string;
    name: string;
    invoiceId: string;
    amount: unknown;
    pretaxAmount?: unknown;
    taxAmount?: unknown;
    status: string;
    qbInvoiceId?: string | null;
    qbSyncError?: string | null;
    qbInvoiceSentAt?: Date | string | null;
    lastReminderAt?: Date | string | null;
    stripeSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    paidAt?: Date | string | null;
    sourceChangeOrderId?: string | null;
    sourceCoScheduleId?: string | null;
    sourceScheduleId?: string | null;
    coBilling?: { id: string } | null;
    createdAt: Date | string;
};

/**
 * Why this milestone cannot take a credit, or null when it can. Only a milestone
 * nobody has billed, sent, reminded, synced, paid or started paying is lowered:
 * anything the customer may already have seen keeps its amount.
 */
export function creditIneligibleReason(row: CreditMilestoneInput): string | null {
    if (row.status !== "Pending") return `it is ${row.status}`;
    if (row.paidAt != null) return "it has a payment recorded";
    if (row.stripeSessionId != null || row.stripePaymentIntentId != null) return "a card or bank payment is in progress on it";
    if (row.qbInvoiceId != null) return "it is already in QuickBooks";
    if (row.qbSyncError != null) return "it has an unresolved QuickBooks marker";
    if (row.qbInvoiceSentAt != null) return "it was already sent to the customer";
    if (row.lastReminderAt != null) return "the customer was already sent a reminder for it";
    if (row.sourceChangeOrderId != null || row.sourceCoScheduleId != null || row.coBilling) return "it bills another change order";
    return null;
}

const time = (value: Date | string) => new Date(value).getTime();

/**
 * Rank an invoice's milestones; the LAST eligible one is the default credit target.
 *
 * Estimate-linked rows (sourceScheduleId with a known EstimatePaymentSchedule.order)
 * sort by that order and come AFTER every unlinked row; unlinked rows (hand-added
 * extra charges) sort by createdAt. Ties fall back to createdAt, then id (the
 * estimate's milestones are cloned in one transaction, so createdAt can tie).
 * That keeps the contract's Final milestone as the default even when a later
 * extra charge is eligible: the credit comes off the contract, not off an
 * unrelated add-on.
 */
export function rankCreditMilestones<T extends { id: string; createdAt: Date | string; sourceScheduleId?: string | null }>(
    rows: readonly T[],
    scheduleOrder: ReadonlyMap<string, number>,
): T[] {
    const orderOf = (row: T) => (row.sourceScheduleId != null ? scheduleOrder.get(row.sourceScheduleId) : undefined);
    return [...rows].sort((a, b) => {
        const oa = orderOf(a);
        const ob = orderOf(b);
        const la = oa === undefined ? 0 : 1;
        const lb = ob === undefined ? 0 : 1;
        if (la !== lb) return la - lb;
        if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
        const ta = time(a.createdAt);
        const tb = time(b.createdAt);
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

const cents = (value: unknown) => Math.round((Number(value) || 0) * 100);
const hasSplit = (row: { pretaxAmount?: unknown; taxAmount?: unknown }) => row.pretaxAmount != null && row.taxAmount != null;

export type CreditReductionPlan = {
    fits: boolean;
    /** Why the credit does not fit this milestone; null when it fits. */
    reason: string | null;
    amountCents: number;
    newAmountCents: number;
    /** Null when the milestone has no stored pretax/tax split (legacy rows): only `amount` changes. */
    before: { pretaxCents: number | null; taxCents: number | null };
    after: { pretaxCents: number | null; taxCents: number | null };
};

/**
 * What lowering this milestone by the credit does. The milestone keeps its
 * pretax/tax split when it has one (both move by the credit's own parts), and a
 * legacy row with no split changes only its amount.
 *
 * Refused when the new amount would be zero or less (a credit equal to the
 * milestone is refused too: no $0 milestone), and, on a split row, when the
 * pre-tax part would reach $0 or less or the tax part would go negative.
 * QuickBooks receives the stored split verbatim (milestoneTaxSplit), so a
 * negative tax part would reach QuickBooks as a negative tax line.
 */
export function planCreditReduction(
    row: { name: string; amount: unknown; pretaxAmount?: unknown; taxAmount?: unknown },
    credit: CoCreditCents,
): CreditReductionPlan {
    const amountCents = cents(row.amount);
    const newAmountCents = amountCents + credit.totalCents;
    const split = hasSplit(row);
    const before = split
        ? { pretaxCents: cents(row.pretaxAmount), taxCents: cents(row.taxAmount) }
        : { pretaxCents: null, taxCents: null };
    const after = split
        ? { pretaxCents: before.pretaxCents! + credit.pretaxCents, taxCents: before.taxCents! + credit.taxCents }
        : { pretaxCents: null, taxCents: null };
    let reason: string | null = null;
    if (credit.totalCents >= 0) {
        reason = "this change order is not a credit";
    } else if (newAmountCents <= 0) {
        reason = coCreditTooBigError(credit.totalCents, row.name, amountCents);
    } else if (split && after.pretaxCents! <= 0) {
        reason = coCreditPretaxTooBigError(credit.pretaxCents, row.name, before.pretaxCents!);
    } else if (split && after.taxCents! < 0) {
        reason = coCreditTaxTooBigError(credit.taxCents, row.name, before.taxCents!);
    }
    return { fits: reason === null, reason, amountCents, newAmountCents, before, after };
}

export type CreditTargetRow = {
    id: string;
    name: string;
    amountCents: number;
    eligible: boolean;
    reason: string | null;
    newAmountCents: number;
    fits: boolean;
};

/** The invoice totals a credit moves (subtotal and tax drop by its parts). */
export type CreditInvoiceTotals = { code: string; subtotalCents: number; taxCents: number };

/**
 * Why the credit can't come off this invoice at all, or null. Checked for every
 * target, legacy and split alike: the invoice's subtotal and tax drop by the
 * credit's own parts, and neither may go below $0. (A legacy milestone carries no
 * split, so on a tax-exempt invoice reached through the project-invoice fallback
 * a taxed credit would otherwise pass the milestone check and drive the invoice's
 * tax negative.)
 */
export function creditInvoiceTotalsError(credit: CoCreditCents, invoice: CreditInvoiceTotals | null | undefined): string | null {
    if (!invoice) return null;
    if (invoice.subtotalCents + credit.pretaxCents < 0) {
        return coCreditInvoiceSubtotalError(credit.pretaxCents, invoice.code, invoice.subtotalCents);
    }
    if (invoice.taxCents + credit.taxCents < 0) {
        return coCreditInvoiceTaxError(credit.taxCents, invoice.code, invoice.taxCents);
    }
    return null;
}

/**
 * Eligibility, ranking, and fit for every milestone on the credit's invoice, in
 * ranked order, plus the default target (the last eligible row). When the
 * invoice's own totals can't absorb the credit, no row fits and each carries
 * that reason.
 */
export function buildCreditTargets(
    milestones: readonly CreditMilestoneInput[],
    scheduleOrder: ReadonlyMap<string, number>,
    credit: CoCreditCents,
    invoiceTotals?: CreditInvoiceTotals | null,
): { rows: CreditTargetRow[]; defaultId: string | null } {
    const ranked = rankCreditMilestones(milestones, scheduleOrder);
    const invoiceError = creditInvoiceTotalsError(credit, invoiceTotals);
    const rows = ranked.map((row) => {
        const ineligible = creditIneligibleReason(row);
        const plan = planCreditReduction(row, credit);
        const fits = ineligible === null && plan.fits && invoiceError === null;
        return {
            id: row.id,
            name: row.name,
            amountCents: plan.amountCents,
            eligible: ineligible === null,
            reason: ineligible ?? plan.reason ?? invoiceError,
            newAmountCents: plan.newAmountCents,
            fits,
        };
    });
    const eligible = rows.filter((row) => row.eligible);
    return { rows, defaultId: eligible.at(-1)?.id ?? null };
}

/**
 * The refusal for a target, or null when the credit can land on it. The same
 * text serves the editor, the offline apply (picked target), and the signed
 * path and send guard (default target).
 */
export function creditTargetError(
    code: string,
    targets: { invoice: { code: string } | null; rows: readonly CreditTargetRow[]; defaultId: string | null },
    targetId: string | null | undefined,
): string | null {
    const id = targetId ?? targets.defaultId;
    if (!targets.invoice) return coCreditNoInvoiceError(code);
    if (!id) return coCreditNoEligibleMilestoneError(code, targets.invoice.code);
    const row = targets.rows.find((candidate) => candidate.id === id);
    if (!row) return coCreditTargetNotOnInvoiceError(targets.invoice.code);
    if (!row.eligible) return coCreditTargetIneligibleError(row.name, row.reason ?? "it is not eligible");
    if (!row.fits) return row.reason ?? coCreditTooBigError(row.newAmountCents - row.amountCents, row.name, row.amountCents);
    return null;
}

// ── Shared refusal strings ───────────────────────────────────────────────────

const money = (centsValue: number) => formatCurrency(Math.abs(centsValue) / 100);

/** $0 is refused on every path: an unpriced change order must never be signed or approved. */
export function coZeroSubtotalError(code: string): string {
    return `Change order ${code} has a $0 subtotal. Price it before it can be approved.`;
}

export function coCreditScheduleRowsError(code?: string): string {
    return `${code ? `Change order ${code}` : "This change order"} is a credit (its total is negative), so it can't have a payment schedule. `
        + "Remove the payment rows, then try again.";
}

export function coCreditCostPlusError(code: string): string {
    return `Change order ${code} has a negative total. A cost-plus change order can't be a credit; make it a fixed-price change order instead.`;
}

export function coCreditNoInvoiceError(code: string): string {
    return `Change order ${code} is a credit, but the project has no invoice to take it off. Create the invoice first.`;
}

export function coCreditNoEligibleMilestoneError(code: string, invoiceCode: string): string {
    return `Change order ${code} is a credit, but invoice ${invoiceCode} has no unpaid milestone it can come off. `
        + "A credit only lowers a Pending milestone that hasn't been sent, reminded, synced to QuickBooks, paid, or tied to another change order.";
}

export function coCreditTooBigError(creditTotalCents: number, milestoneName: string, milestoneCents: number): string {
    return `The credit (${money(creditTotalCents)} incl. tax) is not smaller than ${milestoneName} (${money(milestoneCents)}). Pick a larger unpaid milestone.`;
}

export function coCreditPretaxTooBigError(creditPretaxCents: number, milestoneName: string, milestonePretaxCents: number): string {
    return `The credit would take ${milestoneName}'s pre-tax amount to $0 or less (${money(creditPretaxCents)} before tax against ${money(milestonePretaxCents)}). Pick another unpaid milestone.`;
}

export function coCreditInvoiceSubtotalError(creditPretaxCents: number, invoiceCode: string, invoiceSubtotalCents: number): string {
    return `The credit (${money(creditPretaxCents)} before tax) is more than invoice ${invoiceCode}'s pre-tax subtotal (${money(invoiceSubtotalCents)}). A credit can't take an invoice's subtotal below $0.`;
}

export function coCreditInvoiceTaxError(creditTaxCents: number, invoiceCode: string, invoiceTaxCents: number): string {
    return `The credit's tax (${money(creditTaxCents)}) is more than the tax on invoice ${invoiceCode} (${money(invoiceTaxCents)}). A credit can't take an invoice's tax below $0; check the change order's tax rate against the invoice.`;
}

export function coCreditTaxTooBigError(creditTaxCents: number, milestoneName: string, milestoneTaxCents: number): string {
    return `The credit's tax (${money(creditTaxCents)}) is more than the tax on ${milestoneName} (${money(milestoneTaxCents)}). Pick another unpaid milestone.`;
}

export function coCreditTargetNotOnInvoiceError(invoiceCode: string): string {
    return `That milestone isn't on invoice ${invoiceCode}. Pick one of its unpaid milestones.`;
}

export function coCreditTargetIneligibleError(milestoneName: string, reason: string): string {
    return `${milestoneName} can't take this credit: ${reason}. Pick another unpaid milestone.`;
}

/**
 * v1 refuses to split or delete a milestone a credit was taken off: a split rewrites its
 * estimate row to the lowered amount (losing the credit's add-back), and a delete leaves
 * the credit's marker pointing at a row that no longer exists.
 */
export function coCreditedMilestoneError(milestoneName: string, action: "split" | "deleted"): string {
    return action === "split"
        ? `"${milestoneName}" has a change-order credit taken off it, so it can't be split. Bill the whole milestone, or bill a different one.`
        : `"${milestoneName}" has a change-order credit taken off it, so it can't be deleted. The credit would be left pointing at a milestone that no longer exists.`;
}

export const CO_CREDIT_CHANGED_ERROR = "This milestone changed while applying the credit. Refresh and try again.";
