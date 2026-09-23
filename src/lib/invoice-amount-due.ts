/**
 * What a whole-invoice send email may ask the client for right now: the sum
 * of items already billed and unpaid — never `Invoice.balanceDue`, which
 * also includes milestones that are merely scheduled and were never billed
 * (see src/lib/receivables.ts's own header for why that distinction exists).
 *
 * Pure and client-safe (imports only from ./receivables, itself pure) so it
 * can be shared by the server send path and, later, any client-side preview
 * without dragging Prisma into the browser bundle.
 */

import { computeInvoiceReceivable, type ReceivableInvoiceInput } from "./receivables";

export interface InvoiceAmountDue {
    dueCents: number;
    items: Array<{ kind: "milestone" | "legacyInvoice"; id: string | null; label: string; cents: number }>;
}

/**
 * Built on computeInvoiceReceivable(): billed-and-unpaid = its `items`
 * (Pending milestones that were requested via qbInvoiceSentAt OR have a live
 * QuickBooks invoice, plus the legacy zero-milestone "legacyInvoice" item).
 * `dueCents` is `receivableCents`, which is always the sum of `items[].cents`.
 *
 * The invoice is being sent right now, so a Draft is evaluated as though
 * already issued: computeInvoiceReceivable only suppresses backlog and the
 * legacy zero-milestone item for a Draft invoice, both because a Draft isn't
 * final yet — but sending IS what finalizes it (sendInvoiceToClientCore flips
 * Draft to Issued as part of the same send), so what the email may ask for
 * must be computed as if that flip already happened.
 */
export function computeInvoiceAmountDue(inv: ReceivableInvoiceInput, now: number): InvoiceAmountDue {
    const evaluated: ReceivableInvoiceInput = inv.status === "Draft"
        ? { ...inv, status: "Issued", issueDate: inv.issueDate ?? new Date(now), sentAt: inv.sentAt ?? new Date(now) }
        : inv;
    const receivable = computeInvoiceReceivable(evaluated, now);
    return {
        dueCents: receivable.receivableCents,
        items: receivable.items.map(it => ({ kind: it.kind, id: it.id, label: it.label, cents: it.cents })),
    };
}
