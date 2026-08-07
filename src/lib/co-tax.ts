// Single source of the change-order tax rule, shared by billing (billing-core),
// the MCP send preview, the staff CO editor, and the customer signature page.
// Client-safe: no prisma, pure functions.
//
// Rule: the CO inherits its estimate's tax treatment (which mirrors the
// customer's QuickBooks tax setup) — tax-exempt estimates add no tax; otherwise
// the estimate's rate applies, falling back to the historical 8.8% default.

export const DEFAULT_CO_TAX_RATE = 0.088;

export type EstimateTaxInfo = {
    taxExempt?: boolean | null;
    taxRatePercent?: number | string | { toString(): string } | null;
    taxRateName?: string | null;
} | null | undefined;

export function coTaxRate(estimate: EstimateTaxInfo): number {
    if (estimate?.taxExempt) return 0;
    const pct = estimate?.taxRatePercent != null ? Number(estimate.taxRatePercent) : NaN;
    return Number.isFinite(pct) ? pct / 100 : DEFAULT_CO_TAX_RATE;
}

// Match billing-core's invoice math exactly: totalAmount is the pre-tax signed
// subtotal, then both subtotal and tax are rounded to cents before addition.
export function coSignedAmount(totalAmount: number, estimate: EstimateTaxInfo): number {
    const subtotal = Math.round((Number(totalAmount) || 0) * 100) / 100;
    const taxAmount = Math.round(subtotal * coTaxRate(estimate) * 100) / 100;
    return Math.round((subtotal + taxAmount) * 100) / 100;
}

// Integer-cents line math shared by the CO editor, the portal signature page,
// and the item sync in updateChangeOrder, so the amount the customer sees is
// bit-identical to the amount persisted and billed. toPrecision strips float
// dust before rounding (0.29 * 5000 = 14.499999999999998 must round as 14.5).
export function coLineCents(quantity: number, unitCost: number): number {
    const unitCents = Math.round((unitCost || 0) * 100);
    return Math.round(Number(((quantity || 0) * unitCents).toPrecision(12)));
}

/**
 * The change-order rows that actually carry money.
 *
 * `ChangeOrderItem` is flat — no `parentId` — so a row copied from a sectioned estimate keeps
 * `type: "Section"` and the section's *rolled-up* unitCost, which is the sum of the leaf rows
 * sitting right beside it. Billing both double-counts the section. `createChangeOrder` now
 * expands a section selection to its leaves so new COs never contain a header at all; this
 * guard covers rows written before that fix and any connector payload that sends one.
 *
 * A CO whose rows are *all* headers passes through untouched: it carries no leaves to
 * double-count, and filtering it would silently total the change order to zero.
 */
export function billableCoItems<T extends { type?: string | null }>(items: readonly T[]): readonly T[] {
    const billable = items.filter(item => item.type !== "Section");
    return billable.length === 0 ? items : billable;
}

export function coItemsSubtotal(items: Array<{ type?: string | null; quantity?: number | string | null; unitCost?: number | string | null }>): number {
    return billableCoItems(items).reduce((cents, item) => cents + coLineCents(
        parseFloat(String(item.quantity)) || 0,
        parseFloat(String(item.unitCost)) || 0,
    ), 0) / 100;
}

export function coTaxLabel(estimate: EstimateTaxInfo): string {
    if (estimate?.taxExempt) return "Tax Exempt";
    const pctDisplay = (coTaxRate(estimate) * 100).toFixed(1).replace(/\.0$/, "");
    return estimate?.taxRateName
        ? `${estimate.taxRateName} (${pctDisplay}%)`
        : `Estimated Tax (${pctDisplay}%)`;
}
