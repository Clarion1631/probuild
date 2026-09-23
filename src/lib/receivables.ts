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
    /** Milestone ids claimed by a live progress billing — billed via the
     *  billing's own item above, not their own. Exposed so a caller can mark
     *  them "billed" on their own row (e.g. unpaidMilestones) without
     *  re-deriving the coverage rule. */
    coveredMilestoneIds: string[];
}

const EMPTY: InvoiceReceivable = {
    receivableCents: 0,
    overdueCents: 0,
    unbilledCents: 0,
    notRequestedCents: 0,
    ageDays: null,
    overdue: false,
    items: [],
    coveredMilestoneIds: [],
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

/**
 * The earliest RETAINED billing evidence among the given dates — not
 * necessarily the true earliest event, only the earliest the row still
 * holds. `qbSyncedAt` is written at link time but a drift reconcile can
 * rewrite it; `qbInvoiceSentAt` holds only the LAST send, so a resend moves
 * it forward; breaking a QuickBooks link clears `qbSyncedAt` entirely
 * (`claimQBInvoiceUnlink` in quickbooks-payments.ts keeps `qbInvoiceSentAt`
 * on purpose, which is why the milestone loop below still finds it). None of
 * that is visible here — `billedAt` can only ever reflect what survives.
 */
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
    // "covered" assumes single ownership: a milestone is never referenced by
    // two live billings at once, and a covered milestone never separately
    // holds its own live QBO link. Both are enforced in the app, not here —
    // this module is pure and has no way to check them itself:
    //   (a) one milestone, two active billings — createProgressBillingCore's
    //       consumption guard (src/lib/progress-billing.ts, "Consumption
    //       guard" section) sums every non-Void billing's claim on the
    //       milestone before allowing a new one, and the claim itself is a
    //       CAS write pinned to the amount read under the lock. Not
    //       currently pinned by a behavioural test — see the source tripwire
    //       in tests/progress-billing-stage.test.ts ("C4: the consumption
    //       guard...").
    //   (b) a covered milestone also getting its own QBO invoice — every
    //       individual-milestone QBO push in the app funnels through the one
    //       chokepoint pushMilestoneToQuickBooks (quickbooks-payments.ts),
    //       which refuses via claimMilestonePreCreateUnderLock before the
    //       push and re-checks immediately before the link write, both
    //       querying ProgressBillingLine for a live (non-Void) claim on the
    //       same scheduleId. Pinned by tests/qbo-payments-outage.test.ts
    //       ("already covered by progress invoice ...").
    // If either guard is ever weakened, this function would silently drop a
    // milestone's money (covered here, but never actually billed anywhere)
    // or double-count it (its own item here plus the billing's) — it has no
    // way to detect that on its own.

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

    // Backlog: summed directly from Pending-but-unbilled milestones below,
    // not from balanceDue minus receivable. A residual subtraction would
    // silently absorb any drift between balanceDue and the milestones that
    // make it up (rounding, a stale total) into "backlog", which is a
    // different claim than "this scheduled work was never billed". Legacy
    // zero-milestone invoices (below) add nothing here — their whole balance
    // becomes one billed item instead, never backlog.
    let unbilledCents = 0;

    for (const m of inv.payments) {
        if (m.status !== "Pending") continue; // Paid/Canceled never count
        if (covered.has(m.id)) continue; // its money is the progress billing's
        const cents = toCents(m.amount);
        if (cents <= 0) continue; // legacy $0 placeholder rows
        const requested = m.qbInvoiceSentAt != null;
        const inQbo = isLiveQboLink(m.qbInvoiceId, m.qbSyncError);
        if (!requested && !inQbo) {
            // Scheduled, not billed: backlog. A Draft invoice isn't final,
            // so it contributes no backlog (matches the legacy branch below).
            if (inv.status !== "Draft") unbilledCents += cents;
            continue;
        }
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
    // Oldest open billed item — standard AR aging, and how collections work.
    const ageDays = billedItems.length === 0 ? null : Math.max(...billedItems.map(it => it.ageDays));
    const overdue = billedItems.some(it => it.overdue);

    return {
        receivableCents, overdueCents, unbilledCents, notRequestedCents, ageDays, overdue,
        items: billedItems,
        coveredMilestoneIds: [...covered],
    };
}
