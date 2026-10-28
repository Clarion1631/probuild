import { bumpReceiptEvidenceEpoch, lockReceiptEvidence } from "@/lib/receipt-evidence-lock";
import { assertPhaseOfProjectTx, lockAttributionParents } from "@/lib/phase-invariant";
import { lockExpense } from "@/lib/expense-lock";
import { logAutomationEventInTx } from "@/lib/automation-events";
import { isReceiptUrlRef, receiptUrlRef } from "./receipt-url";

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
 * `state` is guarded by a DB CHECK constraint, so REVERSED needed a migration
 * (20261028000000_receipt_intake_reversed_state) and an apply script.
 *
 * QuickBooks is never touched, and no QuickBooks-linked Expense is deleted or
 * has an amount, vendor, date or link changed.
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
    askJustin: "Something about this receipt needs Justin. Tell Justin.",
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

/** A worker claim older than this is a dead run's, and not honoured (same lease as actions.ts). */
const WORKER_CLAIM_LEASE_MS = 10 * 60_000;

interface ReverseExpenseRow {
    id: string;
    projectId: string | null;
    estimateId: string | null;
    costCodeId: string | null;
    costCode?: { code: string; name: string } | null;
    amount: unknown;
    vendor: string | null;
    date: Date | null;
    receiptUrl: string | null;
    qbPurchaseId: string | null;
    invoiceId: string | null;
    invoicedAt: Date | null;
}

interface ReverseIntakeRow {
    id: string;
    state: string;
    expenseId: string | null;
    qbPurchaseId: string | null;
    postVoidQbPurchaseId: string | null;
    sendAttempted: boolean;
    claimToken: string | null;
    claimedAt: Date | null;
    refNumber: string | null;
    storagePath: string;
    expense: ReverseExpenseRow | null;
}

export interface ReverseBookingTxClient {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receiptIntake: { findUnique(args: any): Promise<ReverseIntakeRow | null>; updateMany(args: any): Promise<{ count: number }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expense: { findUnique(args: any): Promise<ReverseExpenseRow | null>; updateMany(args: any): Promise<{ count: number }>; deleteMany(args: any): Promise<{ count: number }> };
    automationEvent: { create(args: { data: unknown }): Promise<unknown> };
}

export interface ReverseBookingDbClient {
    $transaction<T>(fn: (tx: ReverseBookingTxClient) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

export interface ReverseBookingResult {
    removedExpenseId: string;
    amount: number;
    projectId: string | null;
    /** duplicate-of-qbo only: the phase was written onto the kept QuickBooks import. */
    phaseCarried: boolean;
    /**
     * Set only when the removed copy had a phase that could NOT be carried (the
     * code stopped being a phase of the job, or the write lost a race) and the
     * kept copy has none, so a person can set it by hand. Null otherwise.
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
    receiptUrl: true,
    qbPurchaseId: true,
    invoiceId: true,
    invoicedAt: true,
} as const;

const INTAKE_SELECT = {
    id: true,
    state: true,
    expenseId: true,
    qbPurchaseId: true,
    postVoidQbPurchaseId: true,
    sendAttempted: true,
    claimToken: true,
    claimedAt: true,
    refNumber: true,
    storagePath: true,
    expense: { select: EXPENSE_SELECT },
} as const;

const cents = (v: unknown) => Math.round(Number(v) * 100);

export async function reverseReceiptBookingCore(
    db: ReverseBookingDbClient,
    input: {
        receiptIntakeId: string;
        /** What the dialog showed. The write is pinned to these, like Move to job. */
        expectedExpenseId: string;
        expectedProjectId: string;
        reasonKind: ReverseReasonKind;
        keptExpenseId?: string | null;
        actor: { id: string | null; email: string };
        now?: Date;
    },
): Promise<ReverseBookingResult> {
    const { receiptIntakeId, expectedExpenseId, expectedProjectId, reasonKind, actor } = input;
    const keptExpenseId = input.keptExpenseId ?? null;
    if (reasonKind !== "customer-payment" && reasonKind !== "duplicate-of-qbo") {
        throw new ReverseBookingRefusedError(REVERSE_MESSAGES.badInput);
    }
    if (!receiptIntakeId || !expectedExpenseId || !expectedProjectId) {
        throw new ReverseBookingRefusedError(REVERSE_MESSAGES.badInput);
    }
    if (reasonKind === "duplicate-of-qbo" && !keptExpenseId) {
        throw new ReverseBookingRefusedError(REVERSE_MESSAGES.needsKept);
    }
    const now = input.now ?? new Date();

    /** Every check on a freshly read intake row; used before AND after the locks. */
    const check = (intake: ReverseIntakeRow | null): ReverseExpenseRow => {
        if (!intake) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.gone);
        if (intake.state !== "BOOKED") throw new ReverseBookingRefusedError(REVERSE_MESSAGES.notBooked);
        const expense = intake.expense;
        if (!intake.expenseId || !expense) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.noExpense);
        // What the dialog showed is what gets deleted.
        if (intake.expenseId !== expectedExpenseId || expense.projectId !== expectedProjectId) {
            throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);
        }
        // We never touch a QuickBooks-linked record.
        if (expense.qbPurchaseId) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.qboLinked);
        if (expense.invoiceId || expense.invoicedAt) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.billed);
        // Anything that says QuickBooks may hold, or the worker may be touching,
        // this document is for a person (same refusals as Move to job).
        const claimLive = intake.claimToken !== null
            && (intake.claimedAt === null || intake.claimedAt.getTime() > now.getTime() - WORKER_CLAIM_LEASE_MS);
        if (intake.sendAttempted || intake.qbPurchaseId || intake.postVoidQbPurchaseId || claimLive) {
            throw new ReverseBookingRefusedError(REVERSE_MESSAGES.askJustin);
        }
        return expense;
    };
    const checkKept = (kept: ReverseExpenseRow | null, expense: ReverseExpenseRow): ReverseExpenseRow => {
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
        return kept;
    };

    return db.$transaction(async tx => {
        // The outermost lock, then the epoch bump: the same first two steps as
        // booking and Move to job.
        await lockReceiptEvidence(tx);
        await bumpReceiptEvidenceEpoch(tx);
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };

        // 1. Read with no lock, only to learn WHICH rows to lock.
        const first = await tx.receiptIntake.findUnique({ where: { id: receiptIntakeId }, select: INTAKE_SELECT });
        const firstExpense = check(first);
        const firstKept = reasonKind === "duplicate-of-qbo"
            ? checkKept(await tx.expense.findUnique({ where: { id: keptExpenseId }, select: EXPENSE_SELECT }), firstExpense)
            : null;

        // 2. Canonical lock order: Project -> Estimate -> EstimateItem -> CostCode -> Expense.
        await lockAttributionParents(raw, {
            projectIds: [firstExpense.projectId],
            estimateIds: [firstExpense.estimateId, firstKept?.estimateId ?? null],
            costCodeId: firstExpense.costCodeId,
        });
        // Expenses in id order, so two reversals touching the same pair cannot deadlock.
        for (const id of [firstExpense.id, firstKept?.id].filter((v): v is string => !!v).sort()) {
            await lockExpense(raw, id);
        }

        // 3. Re-read UNDER the locks; every check and the audit row use these.
        const intake = await tx.receiptIntake.findUnique({ where: { id: receiptIntakeId }, select: INTAKE_SELECT });
        const expense = check(intake);
        if (expense.estimateId !== firstExpense.estimateId || expense.costCodeId !== firstExpense.costCodeId) {
            // Re-attributed in the gap: the parents locked above are not this row's.
            throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);
        }
        let kept: ReverseExpenseRow | null = null;
        if (reasonKind === "duplicate-of-qbo") {
            kept = checkKept(await tx.expense.findUnique({ where: { id: keptExpenseId }, select: EXPENSE_SELECT }), expense);
            if (kept.estimateId !== firstKept?.estimateId) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);
        }

        const stateReason = reasonKind === "customer-payment"
            ? "reversed: customer payment"
            : `reversed: duplicate of QuickBooks import ${keptExpenseId}`;

        // 4. Close the receipt row. The predicate re-checks at write time; a row
        // that moved matches nothing and the whole transaction rolls back (no
        // double reversal).
        const closed = await tx.receiptIntake.updateMany({
            where: {
                id: receiptIntakeId,
                state: "BOOKED",
                expenseId: expectedExpenseId,
                sendAttempted: false,
                qbPurchaseId: null,
                postVoidQbPurchaseId: null,
            },
            // Dedup keys, file hash and bookedAt are deliberately NOT touched.
            data: { state: REVERSED_STATE, stateReason, expenseId: null, lastError: null, nextRetryAt: null },
        });
        if (closed.count !== 1) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);

        // 5. Remove the expense, pinned to the job the dialog showed.
        const removed = await tx.expense.deleteMany({
            where: { id: expectedExpenseId, projectId: expectedProjectId, qbPurchaseId: null, invoiceId: null, invoicedAt: null },
        });
        if (removed.count !== 1) throw new ReverseBookingRefusedError(REVERSE_MESSAGES.changed);

        // 6. Carry the phase (and the receipt file) over to the kept QuickBooks
        // import. ONLY costCodeId (+ its provenance) and receiptUrl are written:
        // ProBuild-only columns that nothing syncs to QuickBooks (no QBO write
        // path reads them; the QBO sync deliberately leaves them alone, and the
        // PATCH correction path in api/expenses/[id] edits costCodeId on
        // QuickBooks-linked rows for the same reason). Every other field of a
        // QuickBooks-linked expense stays read-only, and
        // assertExpenseMutableOutsideQbo is untouched.
        let phaseCarried = false;
        let receiptCarried = false;
        let phaseToSet: ReverseBookingResult["phaseToSet"] = null;
        if (kept) {
            if (expense.costCodeId && !kept.costCodeId) {
                // The same phase proof the PATCH path takes before stamping a code.
                const verdict = await assertPhaseOfProjectTx(raw, kept.projectId, expense.costCodeId);
                if (verdict.ok) {
                    const carried = await tx.expense.updateMany({
                        where: { id: kept.id, projectId: kept.projectId, costCodeId: null, qbPurchaseId: kept.qbPurchaseId },
                        data: { costCodeId: expense.costCodeId, costCodeSource: "manual", costCodeConfidence: null },
                    });
                    phaseCarried = carried.count === 1;
                }
                if (!phaseCarried) {
                    phaseToSet = {
                        keptExpenseId: kept.id,
                        costCodeId: expense.costCodeId,
                        code: expense.costCode?.code ?? null,
                        name: expense.costCode?.name ?? null,
                    };
                }
            }
            if (expense.receiptUrl && !kept.receiptUrl) {
                // The receipt file keeps counting as evidence for the bank line:
                // the reversed receipt row is a dead state, so without this the
                // chaser would ask for a receipt we already hold.
                //
                // A pipeline reference is rebuilt from the intake row's CURRENT
                // storagePath, not copied: the copied one may be stale (the object
                // is sealed and archived after booking), and resolveReceiptUrl's
                // moved-file fallback finds the intake THROUGH its linked Expense,
                // a link this reversal has just cut. A reference to where the bytes
                // are now resolves directly. An absolute URL (Drive) is copied as is.
                const carriedUrl = isReceiptUrlRef(expense.receiptUrl) && intake?.storagePath
                    ? receiptUrlRef(intake.storagePath)
                    : expense.receiptUrl;
                // "" counts as empty here exactly as in the check above.
                const wrote = await tx.expense.updateMany({
                    where: {
                        id: kept.id,
                        projectId: kept.projectId,
                        qbPurchaseId: kept.qbPurchaseId,
                        OR: [{ receiptUrl: null }, { receiptUrl: "" }],
                    },
                    data: { receiptUrl: carriedUrl },
                });
                receiptCarried = wrote.count === 1;
            }
        }

        await logAutomationEventInTx(tx, {
            kind: "receipt-reversed",
            status: "reversed",
            reason: stateReason,
            source: "time-expenses",
            vendor: expense.vendor ?? undefined,
            amountCents: cents(expense.amount),
            detail: {
                intakeId: receiptIntakeId,
                expenseId: expense.id,
                reasonKind,
                keptExpenseId,
                amount: String(expense.amount),
                projectId: expense.projectId,
                costCodeId: expense.costCodeId,
                date: expense.date ? expense.date.toISOString().slice(0, 10) : null,
                vendor: expense.vendor,
                receiptUrl: expense.receiptUrl,
                refNumber: intake?.refNumber ?? null,
                phaseCarried,
                phaseToSet,
                receiptCarried,
                actor: actor.email,
                actorId: actor.id,
                at: now.toISOString(),
            },
        });

        return {
            removedExpenseId: expense.id,
            amount: Number(expense.amount),
            projectId: expense.projectId,
            phaseCarried,
            phaseToSet,
        };
    }, { timeout: 15000, maxWait: 15000 });
}

export type ReverseBookingOutcome =
    | { ok: true; amount: number; projectId: string | null; phaseCarried: boolean; phaseToSet: ReverseBookingResult["phaseToSet"] }
    | { ok: false; message: string };

/**
 * The gate plus the core, as one value-returning call: ADMIN only (MANAGER is
 * deliberately not enough, unlike Move to job), and every refusal comes back
 * as a plain message instead of a throw.
 */
export async function reverseReceiptBookingForUser(
    db: ReverseBookingDbClient,
    user: { id?: string | null; role: string; email: string },
    input: {
        receiptIntakeId: string;
        expectedExpenseId: string;
        expectedProjectId: string;
        reasonKind: ReverseReasonKind;
        keptExpenseId?: string | null;
    },
): Promise<ReverseBookingOutcome> {
    if (user.role !== "ADMIN") return { ok: false, message: REVERSE_MESSAGES.notAllowed };
    if (typeof input.receiptIntakeId !== "string" || !input.receiptIntakeId) {
        return { ok: false, message: REVERSE_MESSAGES.badInput };
    }
    try {
        const result = await reverseReceiptBookingCore(db, { ...input, actor: { id: user.id ?? null, email: user.email } });
        return { ok: true, amount: result.amount, projectId: result.projectId, phaseCarried: result.phaseCarried, phaseToSet: result.phaseToSet };
    } catch (error) {
        if (isReverseBookingRefusedError(error)) return { ok: false, message: error.message };
        throw error;
    }
}
