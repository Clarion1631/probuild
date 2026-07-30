export const QBO_MANAGED_EXPENSE_MESSAGE =
    "Finalized QuickBooks expenses are read-only in ProBuild; make the change in QuickBooks.";

export class QboManagedExpenseError extends Error {
    constructor() {
        super(QBO_MANAGED_EXPENSE_MESSAGE);
        this.name = "QboManagedExpenseError";
    }
}

export function assertExpenseMutableOutsideQbo(
    expense: { qbPurchaseId?: string | null } | null,
): void {
    if (expense?.qbPurchaseId) throw new QboManagedExpenseError();
}
