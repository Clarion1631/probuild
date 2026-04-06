/**
 * Shared Prisma query helpers to avoid crashes from missing DB columns
 * and Prisma Decimal serialization issues.
 */

/**
 * Safe estimate select that omits columns not yet migrated to the database.
 * Use this instead of `include: { estimate: true }` in any query that joins Estimate.
 *
 * Missing columns: processingFeeMarkup, hideProcessingFee, expirationDate, archivedAt
 * Remove once: gh workflow run db-push.yml --repo Clarion1631/probuild succeeds.
 */
export const safeEstimateSelect = {
    id: true,
    number: true,
    title: true,
    projectId: true,
    leadId: true,
    code: true,
    status: true,
    privacy: true,
    createdAt: true,
    totalAmount: true,
    balanceDue: true,
    approvedBy: true,
    approvedAt: true,
    approvalIp: true,
    approvalUserAgent: true,
    signatureUrl: true,
    contractId: true,
    viewedAt: true,
} as const;

/**
 * Safe wrapper for including an estimate relation.
 * Use `{ estimate: safeEstimateInclude }` instead of `{ estimate: true }`.
 */
export const safeEstimateInclude = {
    select: safeEstimateSelect,
} as const;

/**
 * Safe estimate select that also loads items and payment schedules.
 * Use for pages that need line items but can't risk loading missing columns.
 */
export const safeEstimateWithItemsSelect = {
    ...safeEstimateSelect,
    items: {
        orderBy: { order: "asc" as const },
        include: { costCode: true, costType: true, expenses: true },
    },
    paymentSchedules: { orderBy: { order: "asc" as const } },
    expenses: true,
} as const;

/**
 * Convert a value that might be a Prisma Decimal to a plain number.
 * Safe to call on numbers, strings, null, undefined — always returns a number.
 */
export function toNum(value: unknown): number {
    if (value === null || value === undefined) return 0;
    const n = Number(value);
    return isNaN(n) ? 0 : n;
}
