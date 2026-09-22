/**
 * What a client actually owes, computed per BILLED item rather than read off
 * `Invoice.balanceDue`.
 *
 * `balanceDue` means "whole contract minus paid milestones" — it includes
 * milestones that are merely scheduled and were never billed. The AR digest
 * used to sum it directly, which reported unbilled backlog as money owed
 * (prod: INV-00319 showed 189,800 outstanding with 0 ever billed). A milestone
 * is billed once the client was asked for it (`qbInvoiceSentAt` set) or a live
 * QuickBooks invoice exists for it (`qbInvoiceId` set, and not voided, not
 * notFound, not pending deletion) — the same predicate the client portal
 * already uses to decide what counts as "due" (src/app/portal/projects/[id]/
 * page.tsx, src/app/portal/page.tsx, PortalInvoiceClient.tsx).
 *
 * Pure — no Prisma, no fetch, no session — so the Open Invoices report and the
 * company-charts AR aging can reuse it later, and so this can be unit tested
 * without a database. The only import is `isPendingDeletion`, itself pure by
 * its own header.
 */

import { isPendingDeletion } from "./qbo-create-markers";

export const RECEIVABLE_NET_TERMS_DAYS = 30;
export const DUE_DATE_GRACE_MS = 86_400_000;

const DAY_MS = 86_400_000;

type Money = number | string | { toString(): string };

export interface ReceivableMilestone {
    id: string;
    name: string;
    amount: Money;
    status: string;
    dueDate: Date | null;
    createdAt: Date;
    qbInvoiceId: string | null;
    qbInvoiceSentAt: Date | null;
    qbSyncError: string | null;
    qbSyncedAt: Date | null;
}

export interface ReceivableProgressBilling {
    id: string;
    code: string;
    status: string;
    total: Money;
    qbInvoiceId: string | null;
    qbSyncError: string | null;
    qbSyncedAt: Date | null;
    qbInvoiceSentAt: Date | null;
    sentAt: Date | null;
    createdAt: Date;
    lines: Array<{ scheduleId: string | null }>;
}

export interface ReceivableInvoiceInput {
    status: string;
    balanceDue: Money;
    issueDate: Date | null;
    sentAt: Date | null;
    createdAt: Date;
    milestoneCount: number;
    payments: ReceivableMilestone[];
    progressBillings: ReceivableProgressBilling[];
}

export interface BilledItem {
    kind: "milestone" | "progressBilling" | "legacyInvoice";
    id: string | null;
    label: string;
    cents: number;
    billedAt: Date;
    dueDate: Date | null;
    ageDays: number;
    overdue: boolean;
    requested: boolean;
    inQuickBooks: boolean;
}

export interface InvoiceReceivable {
    receivableCents: number;
    overdueCents: number;
    unbilledCents: number;
    notRequestedCents: number;
    ageDays: number | null;
    overdue: boolean;
    items: BilledItem[];
}

const EMPTY: InvoiceReceivable = {
    receivableCents: 0,
    overdueCents: 0,
    unbilledCents: 0,
    notRequestedCents: 0,
    ageDays: null,
    overdue: false,
    items: [],
};

function toCents(v: Money): number {
    return Math.round(Number(v) * 100);
}

/** A QuickBooks invoice link that still points at a real, live document —
 *  not voided, not gone, and not queued for deletion. `paylink-pending`/
 *  `paylink-missing` are NOT excluded: the invoice itself is fine, only the
 *  convenience pay link is. */
export function isLiveQboLink(qbInvoiceId: string | null, qbSyncError: string | null): boolean {
    return !!qbInvoiceId && qbSyncError !== "voided" && qbSyncError !== "notFound" && !isPendingDeletion(qbSyncError);
}

function earliest(...dates: Array<Date | null | undefined>): Date | null {
    let min: Date | null = null;
    for (const d of dates) {
        if (d == null) continue;
        if (min == null || d.getTime() < min.getTime()) min = d;
    }
    return min;
}

/**
 * Per-invoice receivable: which billed items are still open, their age and
 * overdue status, and how much of `balanceDue` is unbilled backlog rather
 * than money owed.
 */
export function computeInvoiceReceivable(inv: ReceivableInvoiceInput, now: number): InvoiceReceivable {
    if (inv.status === "Canceled") return EMPTY;

    type OpenItem = Omit<BilledItem, "ageDays" | "overdue">;
    const items: OpenItem[] = [];

    // A live Staged/Sent progress billing counts once, at its own total; the
    // milestones it covers are skipped below so nothing is counted twice.
    // Staging never writes PaymentSchedule.qbInvoiceId, so a covered milestone
    // otherwise looks unbilled on its own row.
    const livePBs = inv.progressBillings.filter(
        pb => (pb.status === "Staged" || pb.status === "Sent") && isLiveQboLink(pb.qbInvoiceId, pb.qbSyncError),
    );
    const covered = new Set<string>();
    for (const pb of livePBs) {
        for (const line of pb.lines) {
            if (line.scheduleId) covered.add(line.scheduleId);
        }
    }

    for (const pb of livePBs) {
        const cents = toCents(pb.total);
        if (cents <= 0) continue;
        items.push({
            kind: "progressBilling",
            id: pb.id,
            label: pb.code,
            cents,
            dueDate: null,
            billedAt: earliest(pb.qbSyncedAt, pb.qbInvoiceSentAt, pb.sentAt) ?? pb.createdAt,
            requested: !!(pb.qbInvoiceSentAt || pb.sentAt),
            inQuickBooks: true,
        });
    }

    for (const m of inv.payments) {
        if (m.status !== "Pending") continue; // Paid/Canceled never count
        if (covered.has(m.id)) continue; // its money is the progress billing's
        const cents = toCents(m.amount);
        if (cents <= 0) continue; // legacy $0 placeholder rows
        const requested = m.qbInvoiceSentAt != null;
        const inQbo = isLiveQboLink(m.qbInvoiceId, m.qbSyncError);
        if (!requested && !inQbo) continue; // scheduled, not billed: backlog
        items.push({
            kind: "milestone",
            id: m.id,
            label: m.name,
            cents,
            dueDate: m.dueDate,
            billedAt: earliest(inQbo ? m.qbSyncedAt : null, m.qbInvoiceSentAt) ?? inv.issueDate ?? inv.sentAt ?? m.createdAt,
            requested,
            inQuickBooks: inQbo,
        });
    }

    // Legacy Houzz-import invoices only: every live creation path writes at
    // least one milestone, so this only ever fires for that vintage.
    if (inv.milestoneCount === 0 && inv.progressBillings.length === 0 && inv.status !== "Draft") {
        const cents = toCents(inv.balanceDue);
        if (cents > 0) {
            items.push({
                kind: "legacyInvoice",
                id: null,
                label: "Invoice balance",
                cents,
                dueDate: null,
                billedAt: inv.issueDate ?? inv.sentAt ?? inv.createdAt,
                requested: true,
                inQuickBooks: false,
            });
        }
    }

    const billedItems: BilledItem[] = items.map(it => {
        const ageDays = Math.floor((now - it.billedAt.getTime()) / DAY_MS);
        // With a due date, the due date governs outright (even a long-billed
        // item isn't overdue if its due date is still ahead). Without one,
        // net-30 from billing.
        const overdue = it.dueDate
            ? it.dueDate.getTime() + DUE_DATE_GRACE_MS < now
            : ageDays > RECEIVABLE_NET_TERMS_DAYS;
        return { ...it, ageDays, overdue };
    });

    const receivableCents = billedItems.reduce((s, it) => s + it.cents, 0);
    const overdueCents = billedItems.filter(it => it.overdue).reduce((s, it) => s + it.cents, 0);
    const notRequestedCents = billedItems.filter(it => !it.requested).reduce((s, it) => s + it.cents, 0);
    // A Draft invoice's balance isn't final, so it contributes no backlog.
    const unbilledCents = inv.status === "Draft" ? 0 : Math.max(0, toCents(inv.balanceDue) - receivableCents);
    // Oldest open billed item — standard AR aging, and how collections work.
    const ageDays = billedItems.length === 0 ? null : Math.max(...billedItems.map(it => it.ageDays));
    const overdue = billedItems.some(it => it.overdue);

    return { receivableCents, overdueCents, unbilledCents, notRequestedCents, ageDays, overdue, items: billedItems };
}
