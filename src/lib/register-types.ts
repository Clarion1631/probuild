/**
 * Pure leaf module: shared type-classification constants for the QuickBooks
 * bank register / unified money register (docs/UNIFIED-REGISTER-PLAN.md §1,
 * §2). No imports of anything stateful (no Prisma, no fetch, no I/O) — both
 * `qbo-bank-register.ts` (which pulls in Prisma/QBO) and `register-merge.ts`
 * (which must stay pure for unit testing) import from here so the two never
 * drift apart the way byte-for-byte-mirrored copies previously could.
 */

/** GL type labels whose underlying entity is a QBO Purchase (deep-linkable
 * as /app/expense and joinable to ProBuild via Expense.qbPurchaseId).
 * Module-private — if these Sets were exported, callers could `.add()`/
 * `.delete()` and silently change classification behavior everywhere. Use
 * the exported predicate functions below instead. */
const PURCHASE_TYPES = new Set(["Expense", "Check", "Cash Expense", "Cash Purchase", "Credit Card Expense"]);
// Refund/Refund Receipt deliberately NOT here: a refund receipt pays money
// OUT of the account — the sign check at each call site decides, never the
// label alone.
const MONEY_IN_TYPES = new Set(["Deposit", "Payment", "Sales Receipt"]);

/** True when `t` is a GL type label whose underlying entity is a QBO Purchase (see `PURCHASE_TYPES`). */
export function isPurchaseType(t: string): boolean {
    return PURCHASE_TYPES.has(t);
}

/** True when `t` is a GL type label representing money coming into the account (see `MONEY_IN_TYPES`). */
export function isMoneyInType(t: string): boolean {
    return MONEY_IN_TYPES.has(t);
}
