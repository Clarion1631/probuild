import { bumpReceiptEvidenceEpoch, lockReceiptEvidence } from "@/lib/receipt-evidence-lock";
import { lockAttributionParents } from "@/lib/phase-invariant";
import { lockExpense } from "@/lib/expense-lock";
import { logAutomationEventInTx } from "@/lib/automation-events";

/**
 * Reverse booking: the one sanctioned way to take a receipt-booked Expense OUT
 * of the books (a customer check booked as cost, or a receipt-intake copy that
 * doubles a "[QuickBooks import]" expense). The generic DELETE guard stays as
 * it is; this path is separate, ADMIN only, and does everything in one
 * transaction.
 *
 * The receipt row ends in the terminal state REVERSED. It is deliberately NOT
 * DUPLICATE or VOID: the partial unique index on `dedupStrongKey` excludes
 * exactly those two states, so a DUPLICATE/VOID row hands its key back and a
 * re-sent copy of the same file would book again. REVERSED keeps the key (and
 * the weak key and the file hash) occupied, so a re-sent copy is stopped.
 * `state` is a plain string column, so this needs no schema change.
 *
 * QuickBooks is never touched, and neither is any QuickBooks-linked Expense.
 */
export const REVERSED_STATE = "REVERSED";

export type ReverseReasonKind = "customer-payment" | "duplicate-of-qbo";

export const REVERSE_MESSAGES = {
    notAllowed: "Only an admin can reverse a booking.",
    badInput: "Pick a reason and try again.",
    needsKept: "Pick the QuickBooks import expense this is a double of.",
    gone: "That receipt no longer exists. Refresh the page.",
    notBooked: "Only a booked receipt can be reversed.",
    noExpense: "That receipt has no expense to reverse.",
    qboLinked: "That expense is linked to a QuickBooks purchase, so it can't be reversed here.",
    billed: "This expense is already billed on an invoice, so it can't be reversed. Tell Justin.",
    keptInvalid: "The expense to keep must be a QuickBooks import on the same job with the same amount.",
    changed: "This receipt changed while you were reversing it. Refresh the page and try again.",
} as const;

/** Identity by NAME, not `instanceof` — same pattern as ReceiptMoveRefusedError. */
export class ReverseBookingRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReverseBookingRefusedError";
    }
}

export function isReverseBookingRefusedError(error: unknown): error is ReverseBookingRefusedError {
    return (
        error instanceof ReverseBookingRefusedError ||
        (error instanceof Error && error.name === "ReverseBookingRefusedError")
    );
}

interface ReverseExpenseRow {
    id: string;
    projectId: string | null;
    estimateId: string | null;
    costCodeId: string | null;
    costCode?: { code: string; name: string } | null;
    amount: unknown;
    vendor: string | null;
    date: Date | null;
    qbPurchaseId: string | null;
    invoiceId: string | null;
    invoicedAt: Date | null;
}

interface ReverseIntakeRow {
    id: string;
    state: string;
    expenseId: string | null;
    qbPurchaseId: string | null;
    refNumber: string | null;
    expense: ReverseExpenseRow | null;
}

export interface ReverseBookingTxClient {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receiptIntake: { findUnique(args: any): Promise<ReverseIntakeRow | null>; updateMany(args: any): Promise<{ count: number }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expense: { findUnique(args: any): Promise<ReverseExpenseRow | null>; deleteMany(args: any): Promise<{ count: number }> };
    automationEvent: { create(args: { data: unknown }): Promise<unknown> };
}

export interface ReverseBookingDbClient {
    $transaction<T>(fn: (tx: ReverseBookingTxClient) => Promise<T>): Promise<T>;
}

export interface ReverseBookingResult {
    removedExpenseId: string;
    amount: number;
    projectId: string | null;
    /**
     * For duplicate-of-qbo: the phase the removed copy carried, handed back so a
     * person can set it on the kept QuickBooks import. NOT carried over here:
     * the kept expense is QuickBooks-linked, and the write guard
     * (assertExpenseMutableOutsideQbo) deliberately refuses every change to
     * those rows. Null when the removed copy had no phase, when the kept one
     * already has one, or for a customer payment.
     */
    phaseToSet: { keptExpenseId: string; costCodeId: string; code: string | null; name: string | null } | null;
}

const EXPENSE_SELECT = {
    id: true,
    projectId: true,
    estimateId: true,
    costCodeId: true,
    costCode: { select: { code: true, name: true } },
    amount: true,
    vendor: true,
    date: true,
    qbPurchaseId: true,
    invoiceId: true,
    invoicedAt: true,
} as const;

const cents = (v: unknown) => Math.round(Number(v) * 100);

export async function reverseReceiptBookingCore(
    db: ReverseBookingDbClient,
    input: {
        receiptIntakeId: string;
        reasonKind: ReverseReasonKind;
        keptExpenseId?: string | null;
        actor: { id: string | null; email: string };
    },
): Promise<ReverseBookingResult> {
    const { receiptIntakeId, reasonKind, actor } = input;
    const keptExpenseId = input.keptExpenseId ?? null;
    if (reasonKind !== "customer-payment" && reasonKind !== "duplicate-of-qbo") {
        throw new ReverseBookingRefusedError(REVERSE_MESSAGES.badInput);
    }
    if (reasonKind === "duplicate-of-qbo" && !keptExpenseId) {
        throw new ReverseBookingRefusedError(REVERSE_MESSAGES.needsKept);
    }

    return db.$transaction(async tx => {
        // The outermost lock, then the epoch bump: the same first two steps as
        // booking and Move to job.
        await lockReceiptEvidence(tx);
        await bumpReceiptEvidenceEpoch(tx);
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };

        const intake = await tx.receiptIntake.findUnique({
            where: { id: receiptIntakeId },
            select: {
                id: true,
                state: true,
                expenseId: true,
                qbPurchaseId: true,
                refNumber: true,
                expense: { select: EXPENSE_SELECT },
            },
        });
        if (!intake) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.gone);
        if (intake.state !== "BOOKED") throw new ReverseBookingRefusedError(REVERSE_MESSAGES.notBooked);
        const expense = intake.expense;
        if (!intake.expenseId || !expense) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.noExpense);
        // We never touch a QuickBooks-linked record.
        if (expense.qbPurchaseId) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.qboLinked);
        if (expense.invoiceId || expense.invoicedAt) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.billed);

        let kept: ReverseExpenseRow | null = null;
        if (reasonKind === "duplicate-of-qbo") {
            kept = await tx.expense.findUnique({ where: { id: keptExpenseId }, select: EXPENSE_SELECT });
            if (
                !kept ||
                kept.id === expense.id ||
                !kept.qbPurchaseId ||
                !kept.projectId ||
                kept.projectId !== expense.projectId ||
                cents(kept.amount) !== cents(expense.amount)
            ) {
                throw new ReverseBookingRefusedError(REVERSE_MESSAGES.keptInvalid);
            }
        }

        await lockAttributionParents(raw, {
            projectIds: [expense.projectId],
            estimateIds: [expense.estimateId],
            costCodeId: expense.costCodeId,
        });
        await lockExpense(raw, expense.id);

        const stateReason = reasonKind === "customer-payment"
            ? "reversed: customer payment"
            : `reversed: duplicate of QuickBooks import ${keptExpenseId}`;

        // Re-checked by the predicates: a row that moved since the read matches
        // nothing and the whole transaction rolls back (no double reversal).
        const closed = await tx.receiptIntake.updateMany({
            where: { id: intake.id, state: "BOOKED", expenseId: expense.id },
            // Dedup keys, file hash and bookedAt are deliberately NOT touched.
            data: { state: REVERSED_STATE, stateReason, expenseId: null, lastError: null, nextRetryAt: null },
        });
        if (closed.count !== 1) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);

        const removed = await tx.expense.deleteMany({
            where: { id: expense.id, qbPurchaseId: null, invoiceId: null, invoicedAt: null },
        });
        if (removed.count !== 1) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);

        const phaseToSet = kept && expense.costCodeId && !kept.costCodeId
            ? {
                keptExpenseId: kept.id,
                costCodeId: expense.costCodeId,
                code: expense.costCode?.code ?? null,
                name: expense.costCode?.name ?? null,
            }
            : null;

        await logAutomationEventInTx(tx, {
            kind: "receipt-reversed",
            status: "reversed",
            reason: stateReason,
            source: "time-expenses",
            vendor: expense.vendor ?? undefined,
            amountCents: cents(expense.amount),
            detail: {
                intakeId: intake.id,
                expenseId: expense.id,
                reasonKind,
                keptExpenseId,
                amount: String(expense.amount),
                projectId: expense.projectId,
                costCodeId: expense.costCodeId,
                date: expense.date ? expense.date.toISOString().slice(0, 10) : null,
                vendor: expense.vendor,
                refNumber: intake.refNumber,
                intakeQbPurchaseId: intake.qbPurchaseId,
                phaseToSet,
                actor: actor.email,
                actorId: actor.id,
                at: new Date().toISOString(),
            },
        });

        return {
            removedExpenseId: expense.id,
            amount: Number(expense.amount),
            projectId: expense.projectId,
            phaseToSet,
        };
    });
}

export type ReverseBookingOutcome =
    | { ok: true; amount: number; projectId: string | null; phaseToSet: ReverseBookingResult["phaseToSet"] }
    | { ok: false; message: string };

/**
 * The gate plus the core, as one value-returning call: ADMIN only (MANAGER is
 * deliberately not enough, unlike Move to job), and every refusal comes back
 * as a plain message instead of a throw.
 */
export async function reverseReceiptBookingForUser(
    db: ReverseBookingDbClient,
    user: { id?: string | null; role: string; email: string },
    input: { receiptIntakeId: string; reasonKind: ReverseReasonKind; keptExpenseId?: string | null },
): Promise<ReverseBookingOutcome> {
    if (user.role !== "ADMIN") return { ok: false, message: REVERSE_MESSAGES.notAllowed };
    if (typeof input.receiptIntakeId !== "string" || !input.receiptIntakeId) {
        return { ok: false, message: REVERSE_MESSAGES.badInput };
    }
    try {
        const result = await reverseReceiptBookingCore(db, { ...input, actor: { id: user.id ?? null, email: user.email } });
        return { ok: true, amount: result.amount, projectId: result.projectId, phaseToSet: result.phaseToSet };
    } catch (error) {
        if (isReverseBookingRefusedError(error)) return { ok: false, message: error.message };
        throw error;
    }
}
