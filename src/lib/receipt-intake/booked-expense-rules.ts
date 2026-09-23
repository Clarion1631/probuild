export const RECEIPT_EXPENSE_CODE = "RECEIPT_BOOKED_EXPENSE";
export const RECEIPT_EXPENSE_NO_DELETE = "This came from a receipt, so it can't be deleted. Use Move to job if it's on the wrong job. If it's a double, tell Justin.";
export const RECEIPT_EXPENSE_NO_EDIT = "This came from a receipt, so it can't be edited here. Use Tax & phase for the phase or tax, or Move to job for the job. If something else is wrong, tell Justin.";
export const RECEIPT_EXPENSE_NO_APPROVE = "This came from a receipt and is already reviewed.";
export const RECEIPT_EXPENSE_NO_RECEIPT_CHANGE = "This came from a receipt, so its receipt file can't be replaced. If the file is wrong, tell Justin.";
export const RECEIPT_EXPENSE_DOUBLE_NOTE = "This came from a receipt, so it can't be deleted. If it's a double, tell Justin.";
export const MOVE_MESSAGES = {
    notAllowed: "Only an admin or manager can move an expense.",
    gone: "That expense no longer exists. Refresh the page.",
    notFromReceipt: "Only expenses that came from a receipt can be moved here.",
    sameJob: "It's already on that job.",
    jobNotOpen: "Pick an open job.",
    noEstimate: "That job has no estimate yet, so it can't carry costs. Add an estimate to it or pick another job.",
    billed: "This expense is already billed on an invoice, so it can't be moved. Tell Justin.",
    archived: "This receipt is already filed in the Drive archive under its old job. Tell Justin.",
    askJustin: "Something about this receipt needs Justin. Tell Justin.",
    changed: "This expense changed while you were moving it. Refresh the page and try again.",
} as const;
export function isReceiptBookedExpense(row: { qbPurchaseId?: string | null; receiptIntake?: { id: string } | null }): boolean {
    return !row.qbPurchaseId && Boolean(row.receiptIntake);
}
