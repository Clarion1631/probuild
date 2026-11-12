// The tax and total a customer SEES on an estimate. Pure (no React, no database) so the portal
// page and the server-made PDF read one rule and cannot drift. The tax rule only: the processing fee is
// not here (the portal has no fee concept; the PDF adds its own fee, see pdf.ts). Extracted unchanged from
// PortalEstimateClient: display only. It never touches stored totals, approval math, invoices or QuickBooks.

export interface SalesTaxOption { name: string; rate: number; isDefault?: boolean }

/** The company's saved tax list (CompanySettings.salesTaxes JSON). Bad or empty input gives []. */
export function parseSalesTaxes(raw: unknown): SalesTaxOption[] {
    try {
        const parsed = raw ? JSON.parse(String(raw)) : [];
        if (!Array.isArray(parsed)) return [];
        // Keep only usable entries: a null or rate-less entry would crash the PDF or print "$NaN".
        return parsed.filter(
            (t) => t !== null && typeof t === 'object' && t.rate !== null && t.rate !== '' && Number.isFinite(Number(t.rate)),
        );
    } catch {
        return [];
    }
}

export interface EstimateDisplayTotalsInput {
    /** Each caller keeps its own subtotal rule (portal: top-level rows; PDF: leaf rows). */
    subtotal: number;
    taxExempt: boolean;
    /** Estimate.taxRatePercent, or null when no rate was ever saved. */
    savedRate: number | null;
    savedName: string | null;
    salesTaxes: SalesTaxOption[];
}

export interface EstimateDisplayTotals {
    effectiveRate: number;
    effectiveRateDisplay: number;
    effectiveName: string;
    /** "<name> (<rate>%)", or null when tax exempt. */
    taxLabel: string | null;
    tax: number;
    total: number;
}

export function computeEstimateDisplayTotals(input: EstimateDisplayTotalsInput): EstimateDisplayTotals {
    const { subtotal, taxExempt, savedRate, savedName, salesTaxes } = input;
    const defaultTax = salesTaxes.find((t) => t.isDefault) || salesTaxes[0] || null;
    const effectiveRate = savedRate ?? (defaultTax ? defaultTax.rate : 8.8);
    const effectiveRateDisplay = Number(parseFloat(String(effectiveRate)).toFixed(4));
    const effectiveName = savedName ?? (defaultTax ? defaultTax.name : "Tax");
    const taxRate = taxExempt ? 0 : effectiveRate / 100;
    const taxLabel = taxExempt ? null : `${effectiveName} (${effectiveRateDisplay}%)`;
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = subtotal + tax;
    return { effectiveRate, effectiveRateDisplay, effectiveName, taxLabel, tax, total };
}
