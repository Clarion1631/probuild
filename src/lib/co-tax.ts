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
 * A section header has no place in a change order.
 *
 * `ChangeOrderItem` is flat — no `parentId` — so a row copied out of a sectioned estimate
 * keeps `type: "Section"` and the section's *rolled-up* unitCost, which is the sum of the leaf
 * rows copied beside it. Billing both double-counts the section.
 *
 * Nothing can legitimately produce such a row: the CO editor and the MCP both restrict `type`
 * to Labor / Material / Allowance / Subcontractor / Equipment / Other, and `createChangeOrder`
 * now resolves a section selection to its leaves. A header is therefore corrupt data, never a
 * standalone "bill this whole phase" line — which is why the money paths (write, send,
 * approve) reject it outright instead of guessing at what it was meant to charge. Flat rows
 * cannot tell a duplicate header apart from a standalone one, and a wrong guess is a wrong
 * invoice in either direction.
 */
export function coSectionRowNames<T extends { type?: string | null; name?: string | null }>(items: readonly T[]): string[] {
    return items.filter(item => item.type === "Section").map(item => item.name?.trim() || "(unnamed)");
}

/** Error text shared by every money path that refuses a change order carrying section headers. */
export function coSectionRowError(code: string, sectionNames: readonly string[]): string {
    return `Change order ${code} contains estimate section headers (${sectionNames.join(", ")}). `
        + `A header mirrors the total of the lines beneath it, so billing it would charge that work twice. `
        + `Delete those rows, or rebuild the change order from the estimate, before continuing.`;
}

/**
 * The change-order rows that carry money. Read paths (subtotals shown on screen, the budget
 * roll-up) use this so a corrupt legacy row inflates nothing while a human sorts it out; the
 * money paths refuse the change order entirely rather than render a number from it.
 */
export function billableCoItems<T extends { type?: string | null }>(items: readonly T[]): readonly T[] {
    return items.filter(item => item.type !== "Section");
}

export function coItemsSubtotal(items: Array<{ type?: string | null; quantity?: number | string | null; unitCost?: number | string | null }>): number {
    return billableCoItems(items).reduce((cents, item) => cents + coLineCents(
        parseFloat(String(item.quantity)) || 0,
        parseFloat(String(item.unitCost)) || 0,
    ), 0) / 100;
}

export type CoTotalVerdict =
    | "ok" | "tax-inflated" | "drift" | "no-items" | "has-sections" | "cost-plus" | "unpriced";

/** Cents, rounded exactly the way the send and approve guards round before comparing. */
const toCents = (n: number) => Math.round((Number(n) || 0) * 100);

// The legacy editor wrote `subtotal * (1 + rate)` in one multiply, which can land a cent away
// from the guards' `round(subtotal) + round(subtotal * rate)`. Brute-forcing both formulas
// across every cent value at the rates this app uses puts the maximum divergence at exactly
// one cent, and the single multiply is always the LARGER of the two — so the slack is one
// cent and one-sided. It belongs to the tax-inflated *diagnosis* only, never to "ok".
const TAX_INFLATED_SLACK_CENTS = 1;

/**
 * Classify a stored change-order totalAmount against the subtotal its items produce.
 *
 * Every branch here answers one question: would the send and approve guards let this row
 * through? "ok" must mean yes and nothing weaker, so it is cents-exact —
 * `approveChangeOrderCore` and the send guard compare `storedSubtotalCents !==
 * renderedSubtotalCents` with no tolerance. While this tolerated a cent, a one-cent row was
 * reported healthy, refused by the repair POST as already-correct, and hard-blocked from
 * send and approve with no remediation path at all.
 *
 * The guards also skip the subtotal comparison entirely for COST_PLUS and reject nonpositive
 * cents outright, so those get their own verdicts rather than being scored against a
 * subtotal that means nothing for them.
 */
export function classifyCoTotal(
    stored: number,
    subtotal: number,
    expectedBilled: number,
    itemCount: number,
    sectionCount: number,
    pricingType: string = "FIXED",
): CoTotalVerdict {
    // A section header mirrors the total of the lines beneath it, so no subtotal derived from
    // these rows is trustworthy — including the one a repair would write back. Reported ahead of
    // every other verdict (as the money paths refuse it ahead of every other check) so the row
    // can never be recomputed to a number nobody can justify.
    if (sectionCount > 0) return "has-sections";
    // A cost-plus change order bills from actuals; its totalAmount is not derived from these
    // items and the guards exempt it. Resetting it to the item subtotal would destroy a
    // legitimate number, so it is reported and never repaired.
    if (pricingType === "COST_PLUS") return "cost-plus";
    if (itemCount === 0) return "no-items";
    const storedCents = toCents(stored);
    const subtotalCents = toCents(subtotal);
    // The guards reject nonpositive cents on their own ("no priced items yet"), so equality
    // here would be an "ok" that still cannot send. Repair cannot help either — writing a
    // zero subtotal back leaves the row just as unsendable.
    if (storedCents <= 0 || subtotalCents <= 0) return "unpriced";
    if (storedCents === subtotalCents) return "ok";
    const billedCents = toCents(expectedBilled);
    // Only meaningful when tax actually moves the number, and only above the subtotal. On a
    // tax-exempt CO expectedBilled *is* the subtotal, and a symmetric window would let a
    // stored value BELOW the subtotal — which the legacy tax-inclusive formula can never
    // produce — claim the tax-inflated verdict and skip the confirmation a drift row needs.
    // The window is [billed, billed + 1], not ±1: the single multiply is never SMALLER than
    // the staged one, so a value below expectedBilled is something else and must earn its
    // repair through force.
    const overBilled = storedCents - billedCents;
    if (billedCents > subtotalCents
        && storedCents > subtotalCents
        && overBilled >= 0 && overBilled <= TAX_INFLATED_SLACK_CENTS) {
        return "tax-inflated";
    }
    return "drift";
}

export function coTaxLabel(estimate: EstimateTaxInfo): string {
    if (estimate?.taxExempt) return "Tax Exempt";
    const pctDisplay = (coTaxRate(estimate) * 100).toFixed(1).replace(/\.0$/, "");
    return estimate?.taxRateName
        ? `${estimate.taxRateName} (${pctDisplay}%)`
        : `Estimated Tax (${pctDisplay}%)`;
}
