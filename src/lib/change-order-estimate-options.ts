/**
 * Pure helper for the "New change order" estimate picker. No database access.
 *
 * The billing target mirrors `findChangeOrderInvoice` in src/lib/billing-core.ts:
 * the newest invoice (by createdAt, any status) whose estimateId is the CO's
 * estimate, else the newest invoice on the project. Keep the two in step.
 */

export type ChangeOrderEstimateRow = {
    id: string;
    code: string;
    title: string;
    status: string;
    createdAt: Date;
    /** Newest invoice with this estimateId, any status (Draft included). */
    newestInvoice: { code: string; createdAt: Date } | null;
};

export type ChangeOrderEstimateOption = {
    id: string;
    code: string;
    title: string;
    status: string;
    /** This estimate's own newest invoice code. */
    invoiceCode: string | null;
    /** Where Mark approved would bill: own newest invoice, else the project's newest invoice, else null. */
    billsToInvoiceCode: string | null;
    /** True when billsToInvoiceCode came from the project fallback. */
    billsToProjectFallback: boolean;
};

function byNewestCreated(a: ChangeOrderEstimateRow, b: ChangeOrderEstimateRow): number {
    const diff = b.createdAt.getTime() - a.createdAt.getTime();
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareRows(a: ChangeOrderEstimateRow, b: ChangeOrderEstimateRow): number {
    if (a.newestInvoice && b.newestInvoice) {
        const diff = b.newestInvoice.createdAt.getTime() - a.newestInvoice.createdAt.getTime();
        if (diff !== 0) return diff;
        return byNewestCreated(a, b);
    }
    if (a.newestInvoice) return -1;
    if (b.newestInvoice) return 1;
    const aApproved = a.status === "Approved" ? 0 : 1;
    const bApproved = b.status === "Approved" ? 0 : 1;
    if (aApproved !== bApproved) return aApproved - bApproved;
    return byNewestCreated(a, b);
}

export function buildChangeOrderEstimateOptions(
    rows: ChangeOrderEstimateRow[],
    projectNewestInvoice: { code: string } | null,
): { options: ChangeOrderEstimateOption[]; defaultEstimateId: string | null } {
    const options = [...rows].sort(compareRows).map((row): ChangeOrderEstimateOption => {
        const invoiceCode = row.newestInvoice?.code ?? null;
        const fallbackCode = invoiceCode ? null : projectNewestInvoice?.code ?? null;
        return {
            id: row.id,
            code: row.code,
            title: row.title,
            status: row.status,
            invoiceCode,
            billsToInvoiceCode: invoiceCode ?? fallbackCode,
            billsToProjectFallback: fallbackCode !== null,
        };
    });
    return { options, defaultEstimateId: options[0]?.id ?? null };
}
