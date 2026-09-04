export const QBO_MANAGED_EXPENSE_MESSAGE =
    "Finalized QuickBooks expenses are read-only in ProBuild; make the change in QuickBooks.";

export class QboManagedExpenseError extends Error {
    constructor() {
        super(QBO_MANAGED_EXPENSE_MESSAGE);
        this.name = "QboManagedExpenseError";
    }
}

/**
 * Identity by NAME, not `instanceof` (the same rule
 * `isEstimateAttributionPairConflict` states in expense-attribution.ts).
 * Node 20 + tsx can load this module twice under different specifiers, which
 * makes `instanceof` false for an error this very file threw — and a handler
 * that misses it answers 500 instead of the 409 the caller can act on.
 */
export function isQboManagedExpenseError(error: unknown): error is QboManagedExpenseError {
    return (
        error instanceof QboManagedExpenseError ||
        (error instanceof Error && error.name === "QboManagedExpenseError")
    );
}

export function assertExpenseMutableOutsideQbo(
    expense: { qbPurchaseId?: string | null } | null,
): void {
    if (expense?.qbPurchaseId) throw new QboManagedExpenseError();
}
