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

/**
 * BANK CLEARANCE, as QuickBooks itself reports it.
 *
 * "Reconciled" — the row was matched during a completed bank reconciliation.
 * "Cleared"    — marked cleared but not yet in a finished reconciliation.
 * "Uncleared"  — QuickBooks has it as open from a reconciliation point of view.
 * "Unknown"    — QuickBooks did not classify it either way, or we could not ask.
 *
 * "Unknown" is a real, common answer, not an error state: a Journal Entry
 * touching the bank account appears in NONE of the three `cleared` buckets
 * (verified against the live realm 2026-09-02 — GL row 6557, "Journal Entry",
 * was in neither the Reconciled nor the Uncleared TransactionList). A manually
 * entered journal is precisely the "fake bank truth" case, so it must read as
 * unknown rather than be quietly folded into either side.
 */
export type ClearedStatus = "Reconciled" | "Cleared" | "Uncleared" | "Unknown";

const CLEARED_STATUSES = new Set<string>(["Reconciled", "Cleared", "Uncleared", "Unknown"]);

/** Narrows an arbitrary string to a `ClearedStatus`. */
export function isClearedStatusValue(value: unknown): value is ClearedStatus {
    return typeof value === "string" && CLEARED_STATUSES.has(value);
}

/**
 * May a row in this state become a CANONICAL BankLine?
 *
 * Only a positively cleared row. Everything else — uncleared, unknown, a null
 * from a row stored before this column existed — stays an observation. The
 * predicate is POSITIVE on purpose: every absence of evidence lands on the
 * safe side, which is what keeps an uncleared check from minting fake bank
 * truth and starting a receipt chase for money that never left the account.
 */
export function isClearedForMint(value: string | null | undefined): boolean {
    return value === "Reconciled" || value === "Cleared";
}
