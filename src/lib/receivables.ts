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
    kind: "milestone" | "legacyInvoice";
    id: string | null;
    label: string;
    cents: number;
    billedAt: Date;
    dueDate: Date | null;
    ageDays: number;
    overdue: boolean;
    requested: boolean;
    inQuickBooks: boolean;
    /** The live progress billing(s) this milestone is covered by, if any —
     *  evidence only; the amount counted is always the milestone's own. */
    progressBillingCode: string | null;
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

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Money value -> exact integer cents, without a lossy float multiply.
 * `Math.round(Number(v) * 100)` gets values like 1.005 wrong:
 * `1.005 * 100 === 100.49999999999999` as a double, so it rounds DOWN to
 * 100 while `formatCurrency` (a decimal-string-aware Intl formatter) shows
 * $1.01 for the same value — the digest's sum and its own email would
 * disagree. This rounds the value's own shortest round-trip decimal string
 * instead: for a number, `String(n)` (e.g. "1.005", not the double's full
 * binary expansion) IS that string; for a string or Decimal-like object, the
 * value is already decimal text. register-merge.ts's `decimalToCents` uses
 * the same string-parsing idea but is the wrong tool here — it refuses plain
 * numbers and fails to `null` on anything with more than 2 fractional
 * digits, which is exactly the half-cent case this exists to round, not
 * reject (right for a reconciliation match/no-match, wrong for a digest
 * total that must always produce a number). Round-half-up only ever needs
 * ONE digit beyond the kept two: digits 3+ can't change which side of that
 * digit the true value falls on. Falls back to the float multiply only when
 * the value's string form isn't plain decimal (exponent notation) — a real
 * money amount never legitimately needs it.
 */
function toCents(v: Money): number {
    const str = typeof v === "string" ? v.trim() : String(v);
    const match = DECIMAL_PATTERN.exec(str);
    if (!match) return Math.round(Number(v) * 100); // e.g. exponent notation
    const [, sign, intPart, fracPart = ""] = match;
    const frac3 = (fracPart + "000").slice(0, 3);
    const kept = frac3.slice(0, 2);
    const roundUp = frac3[2] >= "5";
    let cents = BigInt(intPart) * BigInt(100) + BigInt(kept);
    if (roundUp) cents += BigInt(1);
    return sign === "-" ? -Number(cents) : Number(cents);
}

/** A QuickBooks invoice link that still points at a real, live document —
 *  not voided, not gone, and not queued for deletion. `paylink-pending`/
 *  `paylink-missing` are NOT excluded: the invoice itself is fine, only the
 *  convenience pay link is.
 *
 *  For a ProgressBilling specifically: the hourly QBO poller does not yet
 *  persist `voided`/`notFound` onto ProgressBilling rows (it only logs them,
 *  quickbooks-payments.ts ~3533) — only onto PaymentSchedule. So a billing
 *  voided in QuickBooks keeps passing this check, and keeps counting as live
 *  evidence, until it is voided in ProBuild too. Deferred: fixing it means
 *  changing the hourly poller, a money-path writer outside this fix; there
 *  are 0 progress billings in prod today. This check stays as the correct
 *  rule for whenever the poller does persist it. */
export function isLiveQboLink(qbInvoiceId: string | null, qbSyncError: string | null): boolean {
    return !!qbInvoiceId && qbSyncError !== "voided" && qbSyncError !== "notFound" && !isPendingDeletion(qbSyncError);
}

/** Prisma `select` for the progress billings computeInvoiceReceivable needs
 *  (plain object so client-safe code can share it with server pages). */
export const PROGRESS_BILLING_EVIDENCE_SELECT = {
    id: true, code: true, status: true,
    qbInvoiceId: true, qbSyncError: true, qbSyncedAt: true, qbInvoiceSentAt: true, sentAt: true, createdAt: true,
    lines: { select: { scheduleId: true } },
} as const;

type PbEvidence = { requested: boolean; billedAt: Date; codes: string[] };

/** Merged progress-billing evidence per covered milestone id: live (Staged/
 *  Sent, live QuickBooks link) billings only. If a milestone is covered by
 *  more than one live billing this still produces ONE entry for it: OR the
 *  requested flags, take the earliest billedAt, join the codes. */
export function buildProgressBillingEvidence(progressBillings: ReceivableProgressBilling[]): Map<string, PbEvidence> {
    const livePBs = progressBillings.filter(
        pb => (pb.status === "Staged" || pb.status === "Sent") && isLiveQboLink(pb.qbInvoiceId, pb.qbSyncError),
    );
    const pbEvidence = new Map<string, PbEvidence>();
    for (const pb of livePBs) {
        const requested = !!(pb.qbInvoiceSentAt || pb.sentAt);
        const billedAt = earliest(pb.qbSyncedAt, pb.qbInvoiceSentAt, pb.sentAt) ?? pb.createdAt;
        for (const line of pb.lines) {
            // A Staged/Sent billing's lines always carry a real scheduleId
            // (createProgressBillingCore materializes every custom line into
            // a Pending PaymentSchedule before the billing row is persisted),
            // so this check is just defensive.
            if (!line.scheduleId) continue;
            const existing = pbEvidence.get(line.scheduleId);
            if (!existing) {
                pbEvidence.set(line.scheduleId, { requested, billedAt, codes: [pb.code] });
            } else {
                existing.requested = existing.requested || requested;
                if (billedAt.getTime() < existing.billedAt.getTime()) existing.billedAt = billedAt;
                existing.codes.push(pb.code);
            }
        }
    }
    return pbEvidence;
}

export interface MilestoneClassification {
    cents: number;
    /** billed and unpaid: counted as owed (AR digest, invoice email, portal). */
    billed: boolean;
    requested: boolean;
    inQuickBooks: boolean;
    ownInQbo: boolean;
    pbEv: PbEvidence | undefined;
}

/** THE per-milestone "is it billed" decision. computeInvoiceReceivable (AR
 *  digest, invoice email) and the client portal both call this, so they agree
 *  by construction. Returns null for a milestone that never counts at all
 *  (not Pending, or a zero/negative/rounds-to-zero amount). A billed
 *  milestone was either requested (its own `qbInvoiceSentAt`, or a live
 *  progress billing that was sent) or is in QuickBooks (its own live invoice
 *  or a live progress billing line). Anything else is scheduled backlog. */
export function classifyMilestone(
    m: { amount: Money; status: string; qbInvoiceId?: string | null; qbInvoiceSentAt?: Date | string | null; qbSyncError?: string | null },
    pbEvidence: Map<string, PbEvidence>,
    id: string,
): MilestoneClassification | null {
    if (m.status !== "Pending") return null; // Paid/Canceled/Processing never count
    const cents = toCents(m.amount);
    if (cents <= 0) return null; // legacy $0 placeholder rows
    const pbEv = pbEvidence.get(id);
    // Being on a LIVE billing's line means a real, live QuickBooks document
    // already represents this milestone's money, regardless of its own
    // qbInvoiceId (staging never writes one onto the milestone itself).
    const ownInQbo = isLiveQboLink(m.qbInvoiceId ?? null, m.qbSyncError ?? null);
    const inQuickBooks = ownInQbo || !!pbEv;
    const requested = m.qbInvoiceSentAt != null || !!pbEv?.requested;
    return { cents, billed: requested || inQuickBooks, requested, inQuickBooks, ownInQbo, pbEv };
}

/** Ids of the milestones the client portal treats as billed and unpaid (due
 *  now, Pay button offered): exactly the ones computeInvoiceReceivable counts. */
export function billedMilestoneIds(
    payments: Array<{ id: string; amount: Money; status: string; qbInvoiceId?: string | null; qbInvoiceSentAt?: Date | string | null; qbSyncError?: string | null }>,
    progressBillings: ReceivableProgressBilling[],
): string[] {
    const ev = buildProgressBillingEvidence(progressBillings);
    return payments.filter(p => classifyMilestone(p, ev, p.id)?.billed).map(p => p.id);
}

/** The QuickBooks-hosted pay page for a milestone, or null (the Pay button
 *  then falls back to its other methods). Offered only for a billed milestone
 *  (see billedMilestoneIds), never one that is not Pending, and never one whose
 *  QuickBooks invoice carries a sync-error marker. */
export function milestonePayLink(
    m: { status: string; qbInvoiceLink?: string | null; qbSyncError?: string | null },
    billed: boolean,
): string | null {
    if (!billed || m.status !== "Pending" || m.qbSyncError) return null;
    return m.qbInvoiceLink || null;
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

    // A live Staged/Sent progress billing is BILLING EVIDENCE for the
    // milestones on its lines — never counted as an item of its own. Each
    // covered milestone still counts once below, at its own current
    // PaymentSchedule.amount, merged with whichever evidence (its own or the
    // billing's) is stronger. Counting the billing separately at its own
    // frozen `total` double-counted once a covered milestone's amount
    // changed after staging — "Edit amounts" (updatePendingMilestoneAmountsCore,
    // billing-core.ts) rebalances every Pending milestone on an invoice to a
    // new split of the SAME total without knowing a progress billing exists,
    // so a covered milestone's amount can move while the billing's `total`
    // stays exactly what it was at staging time. Counting each Pending
    // milestone once, at whatever it currently says, means the sum can never
    // exceed Σ Pending — no invariant about single ownership of a milestone
    // by one billing is needed for that to hold.
    //
    // This reports the ProBuild milestone amount everywhere, covered or not.
    // A live billing's own QBO total can differ from the sum of what it
    // claimed (tax) — same as for any regular milestone (§5.4 of the spec
    // this module implements: QBO invoices run ~0.1% over their ProBuild
    // milestone on a tax-rate mismatch) — so this and QuickBooks's own total
    // are expected to disagree by exactly that, not a bug to chase here.
    const pbEvidence = buildProgressBillingEvidence(inv.progressBillings);

    // Backlog: summed directly from Pending-but-unbilled milestones below,
    // not from balanceDue minus receivable. A residual subtraction would
    // silently absorb any drift between balanceDue and the milestones that
    // make it up (rounding, a stale total) into "backlog", which is a
    // different claim than "this scheduled work was never billed". Legacy
    // zero-milestone invoices (below) add nothing here — their whole balance
    // becomes one billed item instead, never backlog.
    let unbilledCents = 0;

    for (const m of inv.payments) {
        const c = classifyMilestone(m, pbEvidence, m.id);
        if (!c) continue; // not Pending, or a $0 placeholder row
        const { cents, requested, ownInQbo, pbEv } = c;
        if (!c.billed) {
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
            billedAt: earliest(ownInQbo ? m.qbSyncedAt : null, m.qbInvoiceSentAt, pbEv?.billedAt) ?? inv.issueDate ?? inv.sentAt ?? m.createdAt,
            requested,
            inQuickBooks: c.inQuickBooks,
            progressBillingCode: pbEv ? pbEv.codes.join(", ") : null,
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
                // No milestone to carry qbInvoiceSentAt: sentAt is the only
                // evidence this vintage has that the client was ever asked.
                requested: inv.sentAt != null,
                inQuickBooks: false,
                progressBillingCode: null,
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

    return { receivableCents, overdueCents, unbilledCents, notRequestedCents, ageDays, overdue, items: billedItems };
}
