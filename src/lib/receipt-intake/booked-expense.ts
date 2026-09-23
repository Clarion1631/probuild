import { isReceiptBookedExpense, MOVE_MESSAGES } from "./booked-expense-rules";
import { bumpReceiptEvidenceEpoch, lockReceiptEvidence } from "@/lib/receipt-evidence-lock";
import { assertPhaseOfProjectTx, lockAttributionParents } from "@/lib/phase-invariant";
import { lockExpense } from "@/lib/expense-lock";
import { reattributeExpense } from "@/lib/expense-attribution";
import { logAutomationEventInTx } from "@/lib/automation-events";
import { OPEN_PROJECT_STATUSES } from "@/lib/project-status";

/**
 * Move to job's refusal — everything in `MOVE_MESSAGES` from
 * `booked-expense-rules.ts`. Identity by NAME, not `instanceof`, the same
 * pattern `QboManagedExpenseError` uses (qbo-expense-guard.ts): Node 20 + tsx
 * can load this module twice under different specifiers, which makes
 * `instanceof` false for an error this very file threw.
 */
export class ReceiptMoveRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReceiptMoveRefusedError";
    }
}

export function isReceiptMoveRefusedError(error: unknown): error is ReceiptMoveRefusedError {
    return (
        error instanceof ReceiptMoveRefusedError ||
        (error instanceof Error && error.name === "ReceiptMoveRefusedError")
    );
}

/** The Expense row `moveReceiptExpenseToJobCore` reasons about, read once with no lock. */
interface MovableExpenseRow {
    id: string;
    projectId: string | null;
    estimateId: string | null;
    costCodeId: string | null;
    amount: unknown;
    vendor: string | null;
    qbPurchaseId: string | null;
    invoiceId: string | null;
    invoicedAt: Date | null;
    changeOrderId: string | null;
    receiptIntake: {
        id: string;
        state: string;
        sendAttempted: boolean;
        qbPurchaseId: string | null;
        postVoidQbPurchaseId: string | null;
        claimToken: string | null;
    } | null;
}

/**
 * The transaction-client subset this file needs. Structural, not
 * `Pick<Prisma.TransactionClient>` — the same reason `BookPrismaClient`
 * (receipt-intake/book.ts) is hand-written: it keeps a test double small.
 */
export interface MoveReceiptExpenseTxClient {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expense: { findUnique(args: any): Promise<MovableExpenseRow | null>; updateMany(args: any): Promise<{ count: number }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    project: { findUnique(args: any): Promise<{ name: string; status: string } | null> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receiptIntake: { updateMany(args: any): Promise<{ count: number }> };
    automationEvent: { create(args: { data: unknown }): Promise<unknown> };
}

/** The client `moveReceiptExpenseToJobCore` is handed — `prisma` in production, a fake in tests. */
export interface MoveReceiptExpenseDbClient {
    $transaction<T>(fn: (tx: MoveReceiptExpenseTxClient) => Promise<T>): Promise<T>;
}

/**
 * Move to job (design spec §6.2): move a receipt-booked Expense to another
 * project, in place, with its receipt.
 *
 * ONE TRANSACTION, owned here. It has to own it because the evidence lock
 * (below) must be the OUTERMOST lock, and `tests/receipt-evidence-lock.test.ts`
 * requires `lockReceiptEvidence(` in any file that writes `receiptIntake`.
 *
 * Every refusal throws `ReceiptMoveRefusedError`, which rolls back everything
 * in this transaction, including the epoch bump — a refused move changes
 * nothing.
 */
export async function moveReceiptExpenseToJobCore(
    db: MoveReceiptExpenseDbClient,
    input: { expenseId: string; fromProjectId: string; toProjectId: string; actor: string },
): Promise<{ toProjectName: string; phaseCleared: boolean }> {
    const { expenseId, fromProjectId, toProjectId, actor } = input;

    return db.$transaction(async tx => {
        // 1-2. THE OUTERMOST LOCK, then the epoch bump — the same first two
        // steps as booking (book.ts:1154) and every other Expense writer.
        await lockReceiptEvidence(tx);
        await bumpReceiptEvidenceEpoch(tx);

        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };

        // 3. Read the Expense, no lock yet.
        const row = await tx.expense.findUnique({
            where: { id: expenseId },
            select: {
                id: true,
                projectId: true,
                estimateId: true,
                costCodeId: true,
                amount: true,
                vendor: true,
                qbPurchaseId: true,
                invoiceId: true,
                invoicedAt: true,
                changeOrderId: true,
                receiptIntake: {
                    select: {
                        id: true,
                        state: true,
                        sendAttempted: true,
                        qbPurchaseId: true,
                        postVoidQbPurchaseId: true,
                        claimToken: true,
                    },
                },
            },
        });

        // 4. Pure checks, in order.
        if (!row) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.gone);
        if (!isReceiptBookedExpense(row)) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.notFromReceipt);
        // Native rows always carry `projectId`, so a mismatch means a stale page.
        if (row.projectId !== fromProjectId) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.changed);
        if (toProjectId === fromProjectId) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.sameJob);
        if (row.invoiceId || row.invoicedAt) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.billed);
        const intake = row.receiptIntake!;
        if (intake.state === "ARCHIVED") throw new ReceiptMoveRefusedError(MOVE_MESSAGES.archived);
        if (
            intake.state !== "BOOKED" ||
            intake.sendAttempted ||
            intake.qbPurchaseId ||
            intake.postVoidQbPurchaseId ||
            intake.claimToken
        ) {
            throw new ReceiptMoveRefusedError(MOVE_MESSAGES.askJustin);
        }

        // 5. ONE canonical pass: both Projects, then every Estimate of both
        // jobs, then every EstimateItem of both jobs, then the CostCode.
        await lockAttributionParents(raw, {
            projectIds: [fromProjectId, toProjectId],
            estimateIds: [row.estimateId],
            costCodeId: row.costCodeId,
        });

        // 6. Re-read under the lock. A disagreement means the row moved in the
        // gap between step 3 and this lock.
        const reread = await tx.expense.findUnique({
            where: { id: expenseId },
            select: { projectId: true, estimateId: true },
        });
        if (!reread || reread.projectId !== row.projectId || reread.estimateId !== row.estimateId) {
            throw new ReceiptMoveRefusedError(MOVE_MESSAGES.changed);
        }

        // 7. The target job must exist and be open.
        const target = await tx.project.findUnique({
            where: { id: toProjectId },
            select: { name: true, status: true },
        });
        if (!target || !OPEN_PROJECT_STATUSES.includes(target.status)) {
            throw new ReceiptMoveRefusedError(MOVE_MESSAGES.jobNotOpen);
        }

        // 8. Keep the phase only if it is also a phase of the new job.
        const phase = await assertPhaseOfProjectTx(raw, toProjectId, row.costCodeId);
        const keepPhase = phase.ok;

        // 9. The per-expense advisory lock, last — the global order is
        // Project -> Estimate -> EstimateItem -> CostCode -> Expense.
        await lockExpense(raw, expenseId);

        // 10. The move itself — the one sanctioned way to change an Expense's
        // job. No `eligibleEstimateStatuses`: it then picks the target job's
        // newest non-archived estimate, matching booking's newest-estimate
        // rule (book.ts:622-637).
        const moved = await reattributeExpense(tx as never, { expenseId, toProjectId });
        if (!moved.moved) {
            if (moved.reason === "no-such-expense") throw new ReceiptMoveRefusedError(MOVE_MESSAGES.gone);
            if (moved.reason === "already-there") throw new ReceiptMoveRefusedError(MOVE_MESSAGES.sameJob);
            throw new ReceiptMoveRefusedError(MOVE_MESSAGES.changed);
        }
        if (moved.estimateId === null) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.noEstimate);

        // 11. Clear the links that belonged to the old job. Same row, already
        // locked. Leave everything else alone: amount, vendor, date,
        // description, receiptUrl, status, every tax column, sourceFileId.
        const linksData: Record<string, unknown> = {
            itemId: null,
            changeOrderId: null,
            isBillable: false,
            purchaseOrderId: null,
        };
        if (!keepPhase) {
            linksData.costCodeId = null;
            linksData.costCodeSource = null;
            linksData.costCodeConfidence = null;
        }
        const linksResult = await tx.expense.updateMany({
            where: {
                id: expenseId,
                projectId: toProjectId,
                estimateId: moved.estimateId,
                qbPurchaseId: null,
                invoiceId: null,
                invoicedAt: null,
            },
            data: linksData,
        });
        if (linksResult.count !== 1) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.changed);

        // 12. Move the receipt row with its Expense. It stays BOOKED. Never
        // touch state, bookedAt, expenseId, the dedup keys or the booked
        // values.
        const intakeData: Record<string, unknown> = {
            projectId: toProjectId,
            costCodeId: keepPhase ? row.costCodeId : null,
            suggestedCostCodeId: null,
            suggestedConfidence: null,
        };
        if (!keepPhase) intakeData.costCodeSource = null;
        const intakeResult = await tx.receiptIntake.updateMany({
            where: {
                id: intake.id,
                expenseId,
                state: "BOOKED",
                qbPurchaseId: null,
                postVoidQbPurchaseId: null,
                sendAttempted: false,
                claimToken: null,
            },
            data: intakeData,
        });
        if (intakeResult.count !== 1) throw new ReceiptMoveRefusedError(MOVE_MESSAGES.changed);

        // 13. The audit row, in the same transaction.
        await logAutomationEventInTx(tx, {
            kind: "receipt-moved",
            status: "moved",
            source: "time-expenses",
            vendor: row.vendor ?? undefined,
            projectName: target.name,
            amountCents: Math.round(Number(row.amount) * 100),
            detail: {
                expenseId,
                intakeId: intake.id,
                fromProjectId,
                toProjectId,
                fromEstimateId: row.estimateId,
                toEstimateId: moved.estimateId,
                costCodeId: row.costCodeId,
                phaseKept: keepPhase,
                clearedChangeOrderId: row.changeOrderId,
                actor,
            },
        });

        // 14.
        return { toProjectName: target.name, phaseCleared: !keepPhase && row.costCodeId !== null };
    });
}
