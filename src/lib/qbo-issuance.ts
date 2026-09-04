/**
 * The MONEY STATE a QuickBooks invoice was issued from, fingerprinted.
 *
 * `CreateIdentity` (qbo-create-markers.ts) answers "which QuickBooks document
 * did this create make?" — a DocNumber and a PrivateNote. That is enough to
 * FIND the invoice again, and it was all the ambiguous-create resolver checked
 * before linking. It is not enough to decide the invoice still DESCRIBES the
 * row, and those are different questions:
 *
 *   the create landed in QuickBooks
 *     → the post-create CAS lost, because the milestone was paid / canceled /
 *       repriced / renamed while the request was in flight
 *     → the compensating delete also failed (out of budget, or QuickBooks
 *       refused it), so the invoice is still sitting there
 *     → the row stays parked with its marker
 *     → later, an operator opens the resolver. DocNumber and PrivateNote still
 *       match — neither carries the amount — so the resolver happily links a
 *       $12,000 QuickBooks invoice to a milestone that is now $4,000, or Paid,
 *       or Canceled.
 *
 * So the marker also carries a hash of the fields the invoice was BUILT from.
 * The resolver recomputes it against the row as it stands now and refuses to
 * link on any difference. Fail closed: a stale link is a wrong bill to a real
 * client, and the manual path (find it in QuickBooks, fix it there) is always
 * still open.
 *
 * Server-side on purpose. It uses node:crypto, and `qbo-create-markers.ts` is
 * imported by a client component (InvoiceEditor) — the hash has to live
 * somewhere that never reaches the browser bundle. The markers module only
 * CARRIES the hash as an opaque string; this is the only place that computes
 * one.
 */
import { createHash } from "node:crypto";

import { toNum } from "./prisma-helpers";

/**
 * The milestone columns that decide WHAT THE CLIENT OWES.
 *
 * A subset of what `pushMilestoneToQuickBooks` pins in its post-create CAS, and
 * the difference is deliberate: `name` is excluded. A milestone rename changes
 * the QuickBooks invoice's Description and nothing else — the money is
 * identical — and refusing to adopt a real, correct invoice because someone
 * tidied a label would strand it exactly the way the recovery exists to
 * prevent. (There is a test for that case: "the queried identity does not move
 * when a sibling is deleted or the project renamed".) The push CAS is stricter
 * because it can afford to be: losing that race deletes the invoice it just
 * made, so nothing is stranded.
 *
 * What IS here is every field a wrong link would misbill on: the amount, the
 * TAX ALLOCATION that amount is split into, the customer it is billed to, the
 * status (Paid/Canceled), the due date, and whether a payment is already
 * attached.
 *
 * The tax split and the customer were added after a gate found the hash
 * covering only the grand total. Both change the invoice PAYLOAD without
 * changing `amount`: a milestone whose `pretaxAmount`/`taxAmount` columns were
 * filled in (or whose invoice's `taxRate` moved) re-issues the same dollars as
 * a different liability split, and a client re-pointed at another QuickBooks
 * customer bills the same dollars to someone else. Either one leaves an
 * identity-matching invoice in QuickBooks that no longer describes the row, and
 * without them in the hash the resolver would adopt it.
 */
export interface MilestoneIssuanceState {
    status: string | null;
    amount: unknown;
    dueDate: Date | string | null;
    qbPaymentId: string | null;
    /**
     * The pre-tax/tax split actually sent, as `milestoneTaxSplit` computes it —
     * `null` when the invoice carries no separate tax line.
     */
    tax: { preTaxAmount: number; taxAmount: number } | null;
    /** The QuickBooks `CustomerRef` id the invoice is billed to. */
    customerId: string | null;
}

/**
 * The progress-billing equivalent — and it DOES include `description`, which is
 * the one place the two rails deliberately diverge.
 *
 * On the milestone rail `name` is excluded because nothing can edit it while a
 * create is parked: the only way to change it is through the invoice editor,
 * which refuses a row carrying a create marker. A progress billing has a
 * dedicated edit path (`updateProgressBillingCore`) whose ONLY editable field
 * is `description`, so it is the single payload field a human can move while an
 * invoice for the old text may already exist in QuickBooks. It is also what the
 * stage sends as the QBO line Description. Excluding it would leave exactly one
 * unguarded way to adopt an invoice that no longer describes the row.
 *
 * `taxAmount` and `customerId` are here for the same reason they are on the
 * milestone state: the stage payload's tax line is `{ preTaxAmount: subtotal,
 * taxAmount }`, so a tax-only edit that leaves `subtotal` and `total` alone
 * still re-issues a different invoice; and the customer decides who is billed.
 */
export interface ProgressBillingIssuanceState {
    status: string | null;
    subtotal: unknown;
    total: unknown;
    taxAmount: unknown;
    description: string | null;
    customerId: string | null;
}

/**
 * The pre-tax/tax split one milestone's QuickBooks invoice carries.
 *
 * ONE definition, shared by `pushMilestoneToQuickBooks` (which sends it) and by
 * the issuance hash (which has to fingerprint exactly what was sent). The split
 * is NOT a stored column: it prefers the milestone's own `pretaxAmount`/
 * `taxAmount` when both are set and otherwise derives from the invoice's
 * `taxRate`, so a second copy of that rule would drift and the resolver would
 * recompute a hash the create never wrote.
 */
export function milestoneTaxSplit(row: {
    pretaxAmount: unknown;
    taxAmount: unknown;
    amount: unknown;
    invoiceTaxRate: unknown;
}): { preTaxAmount: number; taxAmount: number } | null {
    if (row.pretaxAmount != null && row.taxAmount != null) {
        return { preTaxAmount: toNum(row.pretaxAmount), taxAmount: toNum(row.taxAmount) };
    }
    const amount = toNum(row.amount);
    const taxRate = toNum(row.invoiceTaxRate);
    const preTaxAmount = Math.round((amount / (1 + taxRate / 100)) * 100) / 100;
    const taxAmount = Math.round((amount - preTaxAmount) * 100) / 100;
    if (taxRate > 0 && taxAmount > 0) return { preTaxAmount, taxAmount };
    return null;
}

/**
 * Money to a stable string.
 *
 * These arrive as Prisma `Decimal` on a real row and as plain numbers in a
 * test, and `String(decimal)` vs `String(number)` disagree on trailing zeros
 * ("4000.00" vs "4000"). Fixing the scale first means the same money always
 * hashes the same however it was loaded.
 */
function money(value: unknown): string {
    if (value === null || value === undefined) return "";
    return toNum(value).toFixed(2);
}

/** Dates likewise: a Date and its own ISO string must not hash differently. */
function when(value: Date | string | null | undefined): string {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? `?${String(value)}` : date.toISOString();
}

/**
 * 16 hex characters (64 bits) of SHA-256 over the field list.
 *
 * Not a security boundary — nobody is attacking their own marker column — so
 * the only requirement is that an ACCIDENTAL collision between two different
 * money states is impossible in practice, which 64 bits comfortably is. The
 * marker rides in a text column alongside a DocNumber and a PrivateNote, so
 * length is not free.
 *
 * Each field is LENGTH-PREFIXED rather than joined with a delimiter: a
 * milestone name or a billing description is free text and could contain any
 * separator we picked, so ("ab", "c") and ("a", "bc") would otherwise hash
 * alike and a rename could slip past the check.
 */
function hashFields(fields: string[]): string {
    const encoded = fields.map((f) => `${f.length}:${f}`).join("");
    return createHash("sha256").update(encoded).digest("hex").slice(0, 16);
}

export function milestoneIssuanceHash(row: MilestoneIssuanceState): string {
    return hashFields([
        "milestone",
        row.status ?? "",
        money(row.amount),
        when(row.dueDate),
        row.qbPaymentId ?? "",
        // An ABSENT tax line and a $0 one are different answers, so they must
        // not hash alike: "" vs "0.00|0.00". Same reasoning as the takeoff
        // tax-split fix.
        row.tax ? `${money(row.tax.preTaxAmount)}/${money(row.tax.taxAmount)}` : "",
        row.customerId ?? "",
    ]);
}

export function progressBillingIssuanceHash(row: ProgressBillingIssuanceState): string {
    return hashFields([
        "progressBilling",
        row.status ?? "",
        money(row.subtotal),
        money(row.total),
        money(row.taxAmount),
        row.description ?? "",
        row.customerId ?? "",
    ]);
}

/**
 * The DOCUMENT rail (POST /api/quickbooks/sync): a whole estimate or invoice,
 * not one milestone of it.
 *
 * Same job as the two states above and a wider net, because this rail sends a
 * whole document: every line, the totals, the text QuickBooks displays, and the
 * customer it is billed to. The claim used to pin only "id, unlinked,
 * unclaimed", so an edit landing between the read and the link — a line added,
 * a price changed, the title rewritten, the client re-pointed — left the record
 * linked to a QuickBooks document describing something else entirely.
 *
 * `itemsRevision` is in here deliberately even though the line digest below
 * would catch most edits on its own: it is the canonical optimistic-concurrency
 * token for estimate items (#327), it moves on ANY item write including ones
 * that happen to preserve every field this hashes, and it is the value the
 * finalize CAS pins. Hashing it too means the marker and the CAS are asking the
 * same question.
 */
export interface DocumentIssuanceState {
    kind: "estimate" | "invoice";
    /** The ProBuild code, which is also the QuickBooks DocNumber. */
    code: string;
    /** Estimate: `itemsRevision`. Invoice: null (it has no such column). */
    itemsRevision: number | null;
    total: unknown;
    /** Invoice only; estimates carry no separate tax column on the document. */
    taxAmount: unknown;
    /** The PrivateNote / display text the payload carries. */
    title: string | null;
    projectName: string | null;
    /** The QuickBooks CustomerRef the payload bills. */
    customerId: string | null;
    /**
     * One entry per line the payload will carry, already flattened. Hashed in
     * order: reordering lines reorders the QuickBooks document, so it is a
     * different document.
     */
    lines: Array<{ id?: string; name?: string | null; quantity?: unknown; unitCost?: unknown; total?: unknown }>;
}

export function documentIssuanceHash(row: DocumentIssuanceState): string {
    // Each line contributes its own length-prefixed group, so two lines cannot
    // be re-cut into one another the way a plain join would allow.
    const lines = row.lines.map((l) => hashFields([
        l.id ?? "",
        l.name ?? "",
        money(l.quantity),
        money(l.unitCost),
        money(l.total),
    ])).join("");
    return hashFields([
        "document",
        row.kind,
        row.code,
        row.itemsRevision == null ? "" : String(row.itemsRevision),
        money(row.total),
        money(row.taxAmount),
        row.title ?? "",
        row.projectName ?? "",
        row.customerId ?? "",
        String(row.lines.length),
        lines,
    ]);
}
