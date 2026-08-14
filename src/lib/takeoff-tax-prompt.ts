/**
 * Sales tax for the AI takeoff: the prompt paragraphs that keep the model OUT of the tax math, and
 * the server-side tax row that replaces what the model used to invent.
 *
 * History. The prompt hardcoded "Clark County WA sales tax rate is 8.4%" while the company's
 * configured default was 8.8%, so every AI-generated estimate quoted the client a tax amount the
 * rest of the app disagreed with. The obvious fix — interpolate the configured rate and let the
 * model multiply — still leaves deterministic money arithmetic to an LLM that can ignore the rate,
 * miscalculate it, or invent a tax line on a job that carries none. So the model is now told NOT to
 * emit a tax line at all, and the route appends one computed here.
 *
 * Two consequences worth stating, because they close known holes rather than being incidental:
 *  - The configured jurisdiction NAME never enters the prompt. It is operator-entered free text,
 *    and text in a prompt that produces client-facing line items is an injection surface no amount
 *    of character-stripping fully closes. The name is applied to the row server-side instead, where
 *    it is data, not instructions.
 *  - An untaxed job gets an explicit ZERO tax row rather than no row. `splitTakeoffTax` treats a
 *    zero tax row as a real answer (`taxRatePercent: 0`) and an absent one as "unknown"
 *    (`taxRatePercent: null`) — and null is read downstream as "gross this up by the default rate",
 *    which the portal resolves to a hardcoded 8.8% when no tax is configured
 *    (PortalEstimateClient.tsx). Quoting a job untaxed and then displaying it +8.8% is exactly the
 *    class of disagreement this file exists to end.
 */

/** The company's default sales tax, as returned by `getDefaultSalesTax()`. */
export type DefaultSalesTax = { name: string | null; rate: number } | null;

/**
 * Upper bound on a usable rate, in percent.
 *
 * Matches the ceiling `splitTakeoffTax` will accept when it derives a rate back out of the tax row
 * (src/lib/takeoff-costing.ts), which in turn mirrors the `taxRatePercent` validation in
 * gpt-estimate.ts. A configured rate above this would produce a tax row the converter then REFUSES
 * to recognize, leaving tax buried in the line items with a null rate — the double-tax shape. Fail
 * loudly instead; the settings table has no server-side validation of its own today.
 */
export const MAX_SALES_TAX_RATE = 30;

export type ResolvedSalesTax =
    /** A usable configuration. `rate: 0` means explicitly untaxed, which is an answer, not an absence. */
    | { ok: true; rate: number; name: string }
    /** The configured rate cannot be used; the caller must surface this rather than guess. */
    | { ok: false; error: string };

/**
 * Validate the configured default into something the tax row can be built from.
 *
 * "No tax configured at all" resolves to rate 0 — the company charges no sales tax — rather than to
 * an error, because an unconfigured settings table is an ordinary state for a new company, not a
 * misconfiguration. A rate that is present but nonsensical (negative, non-finite, above the
 * converter's ceiling) IS a misconfiguration and fails.
 */
export function resolveSalesTax(defaultTax: DefaultSalesTax): ResolvedSalesTax {
    if (!defaultTax) return { ok: true, rate: 0, name: "Sales Tax" };

    const { rate } = defaultTax;
    if (!Number.isFinite(rate)) {
        return { ok: false, error: "The configured default sales tax has no usable rate. Fix it in Settings → Sales Taxes." };
    }
    if (rate < 0) {
        return { ok: false, error: `The configured default sales tax rate (${rate}%) is negative. Fix it in Settings → Sales Taxes.` };
    }
    if (rate > MAX_SALES_TAX_RATE) {
        return {
            ok: false,
            error: `The configured default sales tax rate (${rate}%) is above the supported maximum of ${MAX_SALES_TAX_RATE}%. Fix it in Settings → Sales Taxes.`,
        };
    }

    const trimmed = typeof defaultTax.name === "string" ? defaultTax.name.trim() : "";
    return { ok: true, rate, name: trimmed === "" ? "Sales Tax" : trimmed };
}

/**
 * Render a rate the way the row label and the prompt should carry it.
 *
 * JS number-to-string is already shortest-round-trip, so `8.8` renders "8.8" and `8.375` renders
 * "8.375". No `toFixed`: a display-rounded rate would no longer be the configured rate.
 */
export function formatRate(rate: number): string {
    return String(rate);
}

/** The client-facing label for the tax row: `Clark County WA (8.8%)`. */
export function salesTaxLineName(tax: { rate: number; name: string }): string {
    return `${tax.name} (${formatRate(tax.rate)}%)`;
}

/** The tax row's dollar amount, rounded to cents, for a given pre-tax subtotal. */
export function salesTaxAmount(rate: number, preTaxSubtotal: number): number {
    return Math.round(((preTaxSubtotal * rate) / 100) * 100) / 100;
}

export type SalesTaxPromptSections = {
    /** One bullet inside the prompt's LOCATION CONTEXT block. */
    salesTaxContextLine: string;
    /** The "IMPORTANT — SALES TAX" block. */
    salesTaxSection: string;
    /** The "ESTIMATE STRUCTURE" block. */
    estimateStructureSection: string;
};

/**
 * Build the prompt's tax paragraphs. Only the RATE is ever interpolated — a number, never
 * operator-entered text — and only so the model prices the rest of the job with the right tax
 * context in mind. It is told explicitly not to compute or emit the line.
 */
export function buildSalesTaxPromptSections(tax: { rate: number; name: string }): SalesTaxPromptSections {
    const pct = formatRate(tax.rate);

    if (tax.rate === 0) {
        return {
            salesTaxContextLine: "- Washington State has NO income tax, but higher property taxes",
            salesTaxSection: `IMPORTANT — SALES TAX:
- This job carries NO sales tax
- Do NOT add a sales tax line item, and do NOT use the "99-TAX" phase at all
- Every line item is a pre-tax construction cost`,
            estimateStructureSection: `ESTIMATE STRUCTURE:
  Construction line items (phases 00-15, with O&P already baked into each price)
  = TOTAL ESTIMATE (this is totalEstimate — no sales tax line)`,
        };
    }

    return {
        salesTaxContextLine: `- Washington State has NO income tax, but higher property taxes and a retail sales tax (this job's rate is ${pct}%)`,
        salesTaxSection: `IMPORTANT — SALES TAX:
- In Washington State, residential remodeling/construction is classified as a RETAIL SALE, and ${pct}% sales tax applies to the ENTIRE CONTRACT PRICE
- Do NOT add a sales tax line item yourself, and do NOT use the "99-TAX" phase — the system appends the tax line and recomputes totalEstimate and the milestone amounts after you respond
- Every line item you return is therefore PRE-TAX`,
        estimateStructureSection: `ESTIMATE STRUCTURE:
  Construction line items (phases 00-15, with O&P already baked into each price) — this is what you return
  + ${pct}% sales tax line — appended by the system, not by you
  = TOTAL ESTIMATE`,
    };
}
