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

// Integer-cents line math shared by the CO editor, the portal signature page,
// and the item sync in updateChangeOrder, so the amount the customer sees is
// bit-identical to the amount persisted and billed. toPrecision strips float
// dust before rounding (0.29 * 5000 = 14.499999999999998 must round as 14.5).
export function coLineCents(quantity: number, unitCost: number): number {
    const unitCents = Math.round((unitCost || 0) * 100);
    return Math.round(Number(((quantity || 0) * unitCents).toPrecision(12)));
}

export function coItemsSubtotal(items: Array<{ quantity?: number | string | null; unitCost?: number | string | null }>): number {
    return items.reduce((cents, item) => cents + coLineCents(
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

// The amount the customer signs (and billing invoices): the PRE-TAX subtotal
// plus tax at the estimate's rate. Same cents-rounding steps billing-core's
// billChangeOrderCore uses, so a projected amount matches the later billed
// amount bit-for-bit. Used by the CO→schedule zero-row milestone projection.
export function coSignedAmount(totalAmount: number, estimate: EstimateTaxInfo): number {
    const subtotal = Math.round(totalAmount * 100) / 100;
    const taxAmount = Math.round(subtotal * coTaxRate(estimate) * 100) / 100;
    return Math.round((subtotal + taxAmount) * 100) / 100;
}
