import { Prisma, PrismaClient } from "@prisma/client";
import { withTxRetry, lockMoneyParentsMany } from "@/lib/tx-retry";
import { recomputeEstimate, recomputeInvoice } from "@/lib/payment-mirror";

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
 */

/** Anything with the two schedule delegates — the client or a transaction client. */
type Db = Prisma.TransactionClient;

export type ChargeGroupRow = {
    id: string;
    name: string;
    /** Estimate id for estimate schedules, Invoice id for invoice schedules. */
    parentId: string;
    parentCode: string | null;
};

export type ChargeGroup = {
    estimateSchedules: ChargeGroupRow[];
    invoiceSchedules: ChargeGroupRow[];
    estimateIds: string[];
    invoiceIds: string[];
};

const distinct = (ids: string[]): string[] => [...new Set(ids)].sort();

export const chargeGroupIsEmpty = (group: ChargeGroup): boolean =>
    group.estimateSchedules.length === 0 && group.invoiceSchedules.length === 0;

/**
 * Every Paid milestone row that records `paymentIntentId`, on both sides.
 *
 * Direct match is the intent column itself. On top of that we follow the
 * `sourceScheduleId` mirror link to Paid partners that carry NO intent: manual
 * and pre-mirror legacy settlements leave the column null, and
 * `findEstimateMirror` in payment-mirror.ts already treats a null-intent linked
 * partner as the same payment when it unsettles. A partner carrying a
 * DIFFERENT non-null intent was settled by another charge and is never
 * included.
 */
export async function resolveChargeGroup(db: Db, paymentIntentId: string): Promise<ChargeGroup> {
    const estRows = await db.estimatePaymentSchedule.findMany({
        where: { stripePaymentIntentId: paymentIntentId, status: "Paid" },
        select: { id: true, name: true, estimateId: true, estimate: { select: { code: true } } },
    });
    const invRows = await db.paymentSchedule.findMany({
        where: { stripePaymentIntentId: paymentIntentId, status: "Paid" },
        select: {
            id: true, name: true, invoiceId: true, sourceScheduleId: true,
            invoice: { select: { code: true } },
        },
    });

    // Link expansion, one hop in each direction. One hop is enough: a partner
    // reached this way is Paid with a null intent, so it can only lead back to
    // rows already in the direct sets.
    const linkedInv = estRows.length
        ? await db.paymentSchedule.findMany({
            where: {
                sourceScheduleId: { in: estRows.map((r) => r.id) },
                status: "Paid",
                stripePaymentIntentId: null,
            },
            select: { id: true, name: true, invoiceId: true, invoice: { select: { code: true } } },
        })
        : [];
    const sourceIds = invRows.map((r) => r.sourceScheduleId).filter((id): id is string => !!id);
    const linkedEst = sourceIds.length
        ? await db.estimatePaymentSchedule.findMany({
            where: { id: { in: sourceIds }, status: "Paid", stripePaymentIntentId: null },
            select: { id: true, name: true, estimateId: true, estimate: { select: { code: true } } },
        })
        : [];

    const estimateSchedules = dedupeById([...estRows, ...linkedEst].map((r) => ({
        id: r.id, name: r.name, parentId: r.estimateId, parentCode: r.estimate?.code ?? null,
    })));
    const invoiceSchedules = dedupeById([...invRows, ...linkedInv].map((r) => ({
        id: r.id, name: r.name, parentId: r.invoiceId, parentCode: r.invoice?.code ?? null,
    })));

    return {
        estimateSchedules,
        invoiceSchedules,
        estimateIds: distinct(estimateSchedules.map((r) => r.parentId)),
        invoiceIds: distinct(invoiceSchedules.map((r) => r.parentId)),
    };
}

function dedupeById(rows: ChargeGroupRow[]): ChargeGroupRow[] {
    const byId = new Map<string, ChargeGroupRow>();
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type UnwindResult = {
    estimateSchedules: ChargeGroupRow[];
    invoiceSchedules: ChargeGroupRow[];
};

/**
 * Release every member of a resolved group and recompute each affected parent.
 * Must run inside a transaction that already holds all of the group's parent
 * locks (`lockMoneyParentsMany`) — `unwindRefundedCharge` below is the wrapper
 * that guarantees that.
 *
 * The Stripe ids stay on the released rows, matching the single-row reset this
 * replaces: they are how a redelivered `charge.refunded` re-finds the group.
 * Re-running on an already-unwound group is a no-op, because the group only
 * ever contains Paid rows.
 */
export async function unwindChargeGroup(tx: Db, group: ChargeGroup): Promise<UnwindResult> {
    const estimateSchedules: ChargeGroupRow[] = [];
    for (const row of group.estimateSchedules) {
        const reset = await tx.estimatePaymentSchedule.updateMany({
            where: { id: row.id, status: "Paid" },
            data: { status: "Pending", paidAt: null, paymentDate: null },
        });
        if (reset.count > 0) estimateSchedules.push(row);
    }
    const invoiceSchedules: ChargeGroupRow[] = [];
    for (const row of group.invoiceSchedules) {
        const reset = await tx.paymentSchedule.updateMany({
            where: { id: row.id, status: "Paid" },
            data: { status: "Pending", paidAt: null, paymentDate: null },
        });
        if (reset.count > 0) invoiceSchedules.push(row);
    }

    // Recompute only the parents that actually lost a payment.
    for (const estimateId of distinct(estimateSchedules.map((r) => r.parentId))) {
        await recomputeEstimate(tx, estimateId, "restore");
    }
    for (const invoiceId of distinct(invoiceSchedules.map((r) => r.parentId))) {
        await recomputeInvoice(tx, invoiceId);
    }
    return { estimateSchedules, invoiceSchedules };
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
            return { missingParents: null, result: await unwindChargeGroup(tx, group) };
        }));
        if (outcome.result) return outcome.result;
        outcome.missingParents?.estimateIds.forEach((id) => estimateIds.add(id));
        outcome.missingParents?.invoiceIds.forEach((id) => invoiceIds.add(id));
    }

    throw new Error(
        `Refund group for ${paymentIntentId} kept growing under lock after ${attempts} attempts — nothing was unwound.`,
    );
}
