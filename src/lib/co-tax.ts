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

export function coTaxLabel(estimate: EstimateTaxInfo): string {
    if (estimate?.taxExempt) return "Tax Exempt";
    const pctDisplay = (coTaxRate(estimate) * 100).toFixed(1).replace(/\.0$/, "");
    return estimate?.taxRateName
        ? `${estimate.taxRateName} (${pctDisplay}%)`
        : `Estimated Tax (${pctDisplay}%)`;
}
