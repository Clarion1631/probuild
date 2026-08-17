import { Prisma, PrismaClient } from "@prisma/client";
import { withTxRetry, lockMoneyParentsMany } from "@/lib/tx-retry";
import { recomputeEstimate, recomputeInvoice } from "@/lib/payment-mirror";
import { toNum } from "@/lib/prisma-helpers";

/**
 * Row identity for refunds.
 *
 * `stripePaymentIntentId` is NOT unique on either schedule table. One Stripe
 * charge can be recorded on many rows:
 *
 *  - `convertEstimateToInvoice` (billing-core.ts) copies the intent onto every
 *    invoice-side clone it makes of an already-paid estimate milestone, and an
 *    estimate can be converted more than once;
 *  - the estimate-side original keeps the intent as well;
 *  - `mirrorInvoiceSettleToEstimate` writes the intent onto the mirror it
 *    settles.
 *
 * The old `charge.refunded` handler picked ONE of those rows and unwound it.
 * PR #371 made that pick deterministic, but deterministic is not correct: the
 * other Paid rows kept showing money the client no longer has, and their
 * parents kept a wrong balanceDue.
 *
 * The fix here is to treat the charge, not the row, as the unit of a refund. A
 * row carrying intent X exists only because charge X settled it (nothing else
 * ever writes that column), so a FULL refund of X must release every such row
 * and recompute every document that holds one.
 *
 * We deliberately do NOT stop copying the intent onto clones. Several callers
 * read it as "this row records a Stripe payment" rather than as an identity —
 * the in-flight/settled guards in `billing-core.ts` and `progress-billing.ts`,
 * the schedule-delete guard in `actions.ts`, and the `hasStripeIntent` undo
 * affordance in the estimate/invoice editors. Dropping it from clones would
 * silently reopen all of those. Making the refund group-complete fixes the bug
 * without touching what any of them see.
 *
 * ── Why a NULL intent is never a match ──────────────────────────────────────
 *
 * Manual, QuickBooks and pre-mirror legacy settlements leave the column null,
 * so a Paid mirror partner carrying no intent MIGHT be the same money. But it
 * might equally be a genuinely separate payment: once the estimate milestone is
 * Paid, a mirror claim on it fails, so an invoice clone settled by cheque also
 * ends up Paid with a null intent. Releasing that on a refund of X would raise
 * a balance the client has already paid — the exact class of error this module
 * exists to prevent.
 *
 * A first attempt adopted such a partner where the mirror was 1:1, on the
 * theory that a single clone leaves nothing to confuse it with. That is wrong:
 * cardinality is not payment identity, and a lone cheque-paid mirror is
 * indistinguishable from a lone legacy Stripe mirror (Codex round 2). Nothing
 * on these rows records WHICH payment a null-intent settlement was, so there is
 * no honest way to decide.
 *
 * So: only rows carrying the intent are released. Paid mirror partners with no
 * intent are collected as `unattributable` — never written, always reported —
 * so a human resolves them instead of the code guessing. The cost is that a
 * genuinely legacy 1:1 mirror is no longer auto-unwound; the office is told
 * about it by name in the refund email, which is the honest trade.
 */

/** Anything with the schedule delegates — the client or a transaction client. */
type Db = Prisma.TransactionClient;

export type ChargeGroupRow = {
    id: string;
    name: string;
    /** Estimate id for estimate schedules, Invoice id for invoice schedules. */
    parentId: string;
    parentCode: string | null;
};

export type ChargeGroup = {
    /** Rows a full refund of this charge releases. */
    estimateSchedules: ChargeGroupRow[];
    invoiceSchedules: ChargeGroupRow[];
    /**
     * Paid mirror partners carrying no PaymentIntent. They may or may not
     * record this charge and nothing on the row says which, so they are never
     * touched — only surfaced, so the office can reconcile them by hand.
     */
    unattributable: ChargeGroupRow[];
    estimateIds: string[];
    invoiceIds: string[];
};

const distinct = (ids: string[]): string[] => [...new Set(ids)].sort();

export const chargeGroupIsEmpty = (group: ChargeGroup): boolean =>
    group.estimateSchedules.length === 0
    && group.invoiceSchedules.length === 0
    && group.unattributable.length === 0;

function dedupeById(rows: ChargeGroupRow[]): ChargeGroupRow[] {
    const byId = new Map<string, ChargeGroupRow>();
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const estRow = (r: { id: string; name: string; estimateId: string; estimate?: { code: string | null } | null }): ChargeGroupRow =>
    ({ id: r.id, name: r.name, parentId: r.estimateId, parentCode: r.estimate?.code ?? null });
const invRow = (r: { id: string; name: string; invoiceId: string; invoice?: { code: string | null } | null }): ChargeGroupRow =>
    ({ id: r.id, name: r.name, parentId: r.invoiceId, parentCode: r.invoice?.code ?? null });

const EST_SELECT = {
    id: true, name: true, amount: true, estimateId: true,
    stripePaymentIntentId: true, estimate: { select: { code: true } },
} as const;
const INV_SELECT = {
    id: true, name: true, amount: true, invoiceId: true, sourceScheduleId: true,
    stripePaymentIntentId: true, invoice: { select: { code: true, estimateId: true } },
} as const;

/** Every Paid milestone row that records `paymentIntentId`, on both sides. */
export async function resolveChargeGroup(db: Db, paymentIntentId: string): Promise<ChargeGroup> {
    const directEst = await db.estimatePaymentSchedule.findMany({
        where: { stripePaymentIntentId: paymentIntentId, status: "Paid" },
        select: EST_SELECT,
    });
    const directInv = await db.paymentSchedule.findMany({
        where: { stripePaymentIntentId: paymentIntentId, status: "Paid" },
        select: INV_SELECT,
    });

    // Nothing below is ever released. These are the Paid mirror partners that
    // carry no PaymentIntent — possibly this charge, possibly a cheque — which
    // the office is asked to resolve by hand.
    const unattributable: ChargeGroupRow[] = [];

    // ── invoice → estimate: null-intent originals of a released clone ───────
    const sourceIds = directInv.map((r) => r.sourceScheduleId).filter((id): id is string => !!id);
    const nullSources = sourceIds.length > 0
        ? await db.estimatePaymentSchedule.findMany({
            where: { id: { in: sourceIds }, status: "Paid", stripePaymentIntentId: null },
            select: EST_SELECT,
        })
        : [];
    unattributable.push(...nullSources.map(estRow));

    // ── estimate → invoice: null-intent clones of a milestone in the group ──
    // The source set is the released milestones PLUS the null-intent originals
    // just found. Walking only the released ones missed the shape where the
    // estimate row carries no intent: E(null) with clones A(intent X) and
    // B(null) reports E but never reached B, so a Paid mirror went unmentioned
    // in a report that claims to name them all (Codex round 3).
    const mirrorSourceIds = distinct([...directEst.map((r) => r.id), ...nullSources.map((r) => r.id)]);
    if (mirrorSourceIds.length > 0) {
        const clones = await db.paymentSchedule.findMany({
            where: {
                sourceScheduleId: { in: mirrorSourceIds },
                status: "Paid",
                stripePaymentIntentId: null,
            },
            select: INV_SELECT,
        });
        unattributable.push(...clones.map(invRow));
    }

    // ── pre-link legacy rows: no `sourceScheduleId` to follow ───────────────
    // Same name+amount shape the removed per-row helper matched on, but used
    // only to NAME a candidate for the office. Every plausible candidate is
    // reported, including an ambiguous set — dropping those silently would let
    // the invoice reset while its estimate quietly kept the money (round 2).
    for (const inv of directInv) {
        if (inv.sourceScheduleId) continue;
        const estimateId = inv.invoice?.estimateId;
        if (!estimateId) continue;
        const candidates = await db.estimatePaymentSchedule.findMany({
            where: { estimateId, name: inv.name, status: "Paid", stripePaymentIntentId: null },
            select: EST_SELECT,
        });
        unattributable.push(
            ...candidates.filter((c) => toNum(c.amount) === toNum(inv.amount)).map(estRow),
        );
    }

    const estimateSchedules = dedupeById(directEst.map(estRow));
    const invoiceSchedules = dedupeById(directInv.map(invRow));
    // A row carrying the intent is released, so it can never also be reported
    // as unresolved by one of the link paths above.
    const claimed = new Set([...estimateSchedules, ...invoiceSchedules].map((r) => r.id));

    return {
        estimateSchedules,
        invoiceSchedules,
        unattributable: dedupeById(unattributable).filter((r) => !claimed.has(r.id)),
        estimateIds: distinct(estimateSchedules.map((r) => r.parentId)),
        invoiceIds: distinct(invoiceSchedules.map((r) => r.parentId)),
    };
}

export type UnwindResult = {
    estimateSchedules: ChargeGroupRow[];
    invoiceSchedules: ChargeGroupRow[];
    unattributable: ChargeGroupRow[];
    /**
     * True when nothing recording this charge was still Paid once the locks
     * were held. That is all it means: usually a redelivery of the same refund,
     * but a staff `unrecordPayment` winning the locks first looks identical, so
     * the office wording must not credit an earlier refund delivery for it
     * (Codex round 2). It exists to separate "there was nothing left to do"
     * from "we tried and could not".
     */
    nothingLeftPaid: boolean;
};

/**
 * Release every member of a resolved group and recompute each affected parent.
 * Must run inside a transaction that already holds all of the group's parent
 * locks (`lockMoneyParentsMany`) — `unwindRefundedCharge` is the wrapper that
 * guarantees that.
 *
 * The Stripe rail ids are CLEARED along with the status. A released row is a
 * milestone the office still has to collect, and every path that would collect
 * it reads a non-null `stripeSessionId`/`stripePaymentIntentId` on a non-Paid
 * row as "a payment is in flight on this row, refuse to touch it": the
 * progress-billing validation and its pinned claim (`progress-billing.ts`), the
 * rebalance, delete and re-split guards (`billing-core.ts`), the schedule-delete
 * filter in `saveEstimate` (`actions.ts`), and the portal's pay-in-full
 * affordance. Leaving a dead charge reference behind therefore left the
 * milestone Pending but permanently un-billable — the money could not be
 * re-collected without editing the row by hand.
 *
 * Clearing them does NOT weaken redelivery. `resolveChargeGroup` only ever
 * matches rows whose status is still "Paid", so a second `charge.refunded` for
 * the same intent already resolved to an empty group and returned before this
 * function ran — the ids were never what made redelivery safe. What they cost
 * is provenance: the released row no longer names the charge that settled it.
 * The refund notification still names every milestone and the intent, and
 * `paymentMethod`/`referenceNumber`/`notes` are left as they were.
 *
 * Each side resets in ONE statement rather than one per row: the whole unwind
 * shares a single transaction with a bounded timeout, and a wide mirror group
 * would otherwise put a hundred-odd sequential statements inside it.
 *
 * The statements are raw so they can use `RETURNING id`, which reports exactly
 * the rows THIS update changed. An `updateMany` count plus a re-read cannot:
 * a row another writer had already moved off Paid reads back as not-Paid and
 * would be counted as reset by us (Codex round 2).
 */
export async function unwindChargeGroup(tx: Db, group: ChargeGroup): Promise<Omit<UnwindResult, "nothingLeftPaid">> {
    const resetRows = async (table: "EstimatePaymentSchedule" | "PaymentSchedule", ids: string[]) => {
        if (ids.length === 0) return new Set<string>();
        const rows = await tx.$queryRaw<{ id: string }[]>`
            UPDATE ${Prisma.raw(`"${table}"`)}
               SET "status" = 'Pending', "paidAt" = NULL, "paymentDate" = NULL,
                   "stripeSessionId" = NULL, "stripePaymentIntentId" = NULL
             WHERE "id" = ANY(${ids}) AND "status" = 'Paid'
         RETURNING "id"`;
        return new Set(rows.map((r) => r.id));
    };

    const estDone = await resetRows("EstimatePaymentSchedule", group.estimateSchedules.map((r) => r.id));
    const invDone = await resetRows("PaymentSchedule", group.invoiceSchedules.map((r) => r.id));
    const estimateSchedules = group.estimateSchedules.filter((r) => estDone.has(r.id));
    const invoiceSchedules = group.invoiceSchedules.filter((r) => invDone.has(r.id));

    // Recompute only the parents that actually lost a payment.
    for (const estimateId of distinct(estimateSchedules.map((r) => r.parentId))) {
        await recomputeEstimate(tx, estimateId, "restore");
    }
    for (const invoiceId of distinct(invoiceSchedules.map((r) => r.parentId))) {
        await recomputeInvoice(tx, invoiceId);
    }
    return { estimateSchedules, invoiceSchedules, unattributable: group.unattributable };
}

/**
 * Unwind a fully-refunded charge across every document that recorded it.
 *
 * The group has to be resolved before its parents can be locked, so it is
 * re-resolved UNDER the locks and compared: if a concurrent conversion or
 * backfill added a member on a document we don't hold, nothing is written and
 * the whole transaction re-runs with that document added to the lock set. The
 * lock set only ever grows, so this converges; the attempt cap is a backstop
 * against a pathological writer, and exhausting it raises rather than doing a
 * partial unwind.
 *
 * That check only sees rows a concurrent writer has COMMITTED. The writer that
 * can insert a brand-new Paid clone carrying this intent —
 * `convertEstimateToInvoice` — therefore takes the Estimate row lock too, so it
 * either commits before this transaction resolves (and is seen) or waits until
 * after it commits (and clones a milestone that is already Pending).
 */
export async function unwindRefundedCharge(
    db: PrismaClient,
    paymentIntentId: string,
    attempts = 4,
): Promise<UnwindResult> {
    const seed = await resolveChargeGroup(db, paymentIntentId);
    const estimateIds = new Set(seed.estimateIds);
    const invoiceIds = new Set(seed.invoiceIds);

    for (let attempt = 0; attempt < attempts; attempt++) {
        const outcome: {
            missingParents: { estimateIds: string[]; invoiceIds: string[] } | null;
            result: UnwindResult | null;
        } = await withTxRetry(() => db.$transaction(async (tx) => {
            await lockMoneyParentsMany(tx, {
                estimateIds: [...estimateIds],
                invoiceIds: [...invoiceIds],
            });
            const group = await resolveChargeGroup(tx, paymentIntentId);
            const missingParents = {
                estimateIds: group.estimateIds.filter((id) => !estimateIds.has(id)),
                invoiceIds: group.invoiceIds.filter((id) => !invoiceIds.has(id)),
            };
            if (missingParents.estimateIds.length > 0 || missingParents.invoiceIds.length > 0) {
                return { missingParents, result: null };
            }
            const unwound = await unwindChargeGroup(tx, group);
            return {
                missingParents: null,
                result: {
                    ...unwound,
                    nothingLeftPaid: group.estimateSchedules.length === 0
                        && group.invoiceSchedules.length === 0,
                },
            };
        // Locks, two batched resets and a recompute per parent. The 5s default
        // is tight once a wide group also has to wait on a busy Invoice lock,
        // and a timeout here strands the refund: the webhook has already
        // answered Stripe 200 and nothing re-drains a FAILED StripeEvent.
        }, { timeout: 15_000 }));
        if (outcome.result) return outcome.result;
        outcome.missingParents?.estimateIds.forEach((id) => estimateIds.add(id));
        outcome.missingParents?.invoiceIds.forEach((id) => invoiceIds.add(id));
    }

    throw new Error(
        `Refund group for ${paymentIntentId} kept growing under lock after ${attempts} attempts — nothing was unwound.`,
    );
}
