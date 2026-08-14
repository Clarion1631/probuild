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
 * ── Why a NULL intent is not a match ────────────────────────────────────────
 *
 * Manual, QuickBooks and pre-mirror legacy settlements leave the column null,
 * so a Paid mirror partner carrying no intent MIGHT be the same money. But it
 * might equally be a genuinely separate payment: once the estimate milestone is
 * Paid, a mirror claim on it fails, so a second invoice clone settled by cheque
 * also ends up Paid with a null intent. Releasing that on a refund of X would
 * raise a balance the client has already paid — the exact class of error this
 * module exists to prevent (Codex round 1).
 *
 * So a null-intent partner is adopted ONLY where the mirror is genuinely 1:1
 * (the estimate milestone has exactly one Paid clone). In a one-to-many group
 * it cannot be attributed to a charge, so it is left alone and reported to the
 * office instead of guessed at.
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
     * Paid mirror partners carrying no intent that sit in a one-to-many group,
     * so they cannot be attributed to this charge. Never touched; surfaced so
     * the office can reconcile them by hand.
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

    const adoptedEst: ChargeGroupRow[] = [];
    const adoptedInv: ChargeGroupRow[] = [];
    const unattributable: ChargeGroupRow[] = [];

    // ── estimate → invoice ──────────────────────────────────────────────────
    // A Paid clone with a null intent is this charge's mirror only when it is
    // the milestone's ONLY Paid clone.
    for (const est of directEst) {
        const clones = await db.paymentSchedule.findMany({
            where: { sourceScheduleId: est.id, status: "Paid" },
            select: INV_SELECT,
        });
        const nulls = clones.filter((c) => c.stripePaymentIntentId === null);
        if (nulls.length === 0) continue;
        if (clones.length === 1) adoptedInv.push(invRow(nulls[0]));
        else unattributable.push(...nulls.map(invRow));
    }

    // ── invoice → estimate ──────────────────────────────────────────────────
    for (const inv of directInv) {
        if (inv.sourceScheduleId) {
            const source = await db.estimatePaymentSchedule.findFirst({
                where: { id: inv.sourceScheduleId, status: "Paid", stripePaymentIntentId: null },
                select: EST_SELECT,
            });
            if (!source) continue;
            // Same 1:1 test from the estimate's side: if the milestone has other
            // Paid clones, this null-intent original cannot be attributed.
            const paidClones = await db.paymentSchedule.count({
                where: { sourceScheduleId: source.id, status: "Paid" },
            });
            if (paidClones === 1) adoptedEst.push(estRow(source));
            else unattributable.push(estRow(source));
            continue;
        }
        // Pre-link legacy row: no `sourceScheduleId`, so fall back to the same
        // name+amount uniqueness rule the removed per-row unsettle helper used.
        // A 1:1 legacy pair has no second clone to confuse it with.
        const estimateId = inv.invoice?.estimateId;
        if (!estimateId) continue;
        const candidates = await db.estimatePaymentSchedule.findMany({
            where: {
                estimateId, name: inv.name, status: "Paid",
                OR: [{ stripePaymentIntentId: paymentIntentId }, { stripePaymentIntentId: null }],
            },
            select: EST_SELECT,
        });
        const matching = candidates.filter((c) => toNum(c.amount) === toNum(inv.amount));
        if (matching.length === 1) adoptedEst.push(estRow(matching[0]));
    }

    const estimateSchedules = dedupeById([...directEst.map(estRow), ...adoptedEst]);
    const invoiceSchedules = dedupeById([...directInv.map(invRow), ...adoptedInv]);
    const claimed = new Set([...estimateSchedules, ...invoiceSchedules].map((r) => r.id));

    return {
        estimateSchedules,
        invoiceSchedules,
        // A row adopted via one path must never also be reported as unresolved
        // via another.
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
     * True when the group was already empty under the locks — an earlier
     * delivery of the same refund had done the work. Distinguishes "nothing to
     * do" from "we tried and failed", which the office email must not conflate.
     */
    alreadyUnwound: boolean;
};

/**
 * Release every member of a resolved group and recompute each affected parent.
 * Must run inside a transaction that already holds all of the group's parent
 * locks (`lockMoneyParentsMany`) — `unwindRefundedCharge` is the wrapper that
 * guarantees that.
 *
 * The Stripe ids stay on the released rows, matching the single-row reset this
 * replaces: they are how a redelivered `charge.refunded` re-finds the group.
 * Re-running on an already-unwound group is a no-op, because the group only
 * ever contains Paid rows.
 *
 * The resets are two batched `updateMany` calls rather than one per row: the
 * whole unwind shares a single transaction with a bounded timeout, and a wide
 * mirror group would otherwise put a hundred-odd sequential statements inside
 * it.
 */
export async function unwindChargeGroup(tx: Db, group: ChargeGroup): Promise<Omit<UnwindResult, "alreadyUnwound">> {
    const estIds = group.estimateSchedules.map((r) => r.id);
    const invIds = group.invoiceSchedules.map((r) => r.id);

    let estimateSchedules = group.estimateSchedules;
    if (estIds.length > 0) {
        const reset = await tx.estimatePaymentSchedule.updateMany({
            where: { id: { in: estIds }, status: "Paid" },
            data: { status: "Pending", paidAt: null, paymentDate: null },
        });
        // The group was resolved under the parent locks, so every member should
        // still be Paid. Re-read only if something slipped past a writer that
        // does not take those locks, so the report never over-claims.
        if (reset.count !== estIds.length) {
            const still = await tx.estimatePaymentSchedule.findMany({
                where: { id: { in: estIds }, status: "Paid" }, select: { id: true },
            });
            const stuck = new Set(still.map((r) => r.id));
            estimateSchedules = estimateSchedules.filter((r) => !stuck.has(r.id));
        }
    }

    let invoiceSchedules = group.invoiceSchedules;
    if (invIds.length > 0) {
        const reset = await tx.paymentSchedule.updateMany({
            where: { id: { in: invIds }, status: "Paid" },
            data: { status: "Pending", paidAt: null, paymentDate: null },
        });
        if (reset.count !== invIds.length) {
            const still = await tx.paymentSchedule.findMany({
                where: { id: { in: invIds }, status: "Paid" }, select: { id: true },
            });
            const stuck = new Set(still.map((r) => r.id));
            invoiceSchedules = invoiceSchedules.filter((r) => !stuck.has(r.id));
        }
    }

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
                result: { ...unwound, alreadyUnwound: chargeGroupIsEmpty(group) },
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
