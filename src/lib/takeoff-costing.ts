/**
 * Shared rules for the AI takeoff → estimate costing pipeline.
 *
 * The takeoff screen, the AI mapping route, and the convert-to-estimate route all have to agree
 * on which rows are sales tax: tax is a pass-through, so it carries no margin and must not move
 * when someone adjusts markup. They previously each decided this on their own — the UI matched
 * `/tax/i` against the code *or* the name while the server matched the cost code — so a line
 * merely named "…tax…" was excluded from markup in the UI and then marked up by the server.
 */

/** The reserved phase code the AI prompt assigns to the WA sales tax line. */
const TAX_COST_CODE = "99-TAX";

/**
 * Whether a cost code marks a sales-tax pass-through row.
 *
 * Matches the reserved code exactly, plus any `99-TAX-…` sub-code, so an unrelated code that
 * merely begins with those characters (`99-TAXABLE`) is not swept in.
 */
export function isTaxCostCode(costCode: unknown): boolean {
    const code = String(costCode ?? "").trim().toUpperCase();
    return code === TAX_COST_CODE || code.startsWith(`${TAX_COST_CODE}-`);
}

/** Whether a takeoff/estimate row is the sales-tax pass-through line. */
export function isTaxRow(row: { costCode?: unknown }): boolean {
    return isTaxCostCode(row?.costCode);
}

/**
 * Parse a value that arrived as JSON (or as a form string) into a finite number, or null.
 * Guards the money path against `parseFloat("12junk") === 12` and against stringy numbers
 * silently turning a `+` sum into string concatenation.
 *
 * Only `number` and `string` inputs are ever accepted — everything else (including `boolean` and
 * arrays/objects, which `Number()` coerces to `1`/`0`/`NaN` in ways that have nothing to do with
 * "is this a usable number") returns null. Strings are trimmed BEFORE the emptiness check, so a
 * whitespace-only string (`"   "`) is treated as absent rather than coercing through `Number("")`
 * to a false zero; a numeric string with surrounding whitespace (`" 12.5 "`) still parses normally.
 */
export function numOrNull(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

/** `numOrNull` with a fallback for values that must end up numeric. */
export function numOr(value: unknown, fallback: number): number {
    return numOrNull(value) ?? fallback;
}

/** Round to cents. */
export const rmc = (n: number) => Math.round(n * 100) / 100;

/**
 * Result of splitting the AI takeoff's tax pass-through row(s) out of an item list.
 *
 * Three distinct outcomes, and the caller must treat them differently:
 *  - `taxRatePercent: null` — "no usable tax line": either there was no tax row at all, or the
 *    row(s) present did not imply a sane rate. `items` is returned UNCHANGED so the caller keeps
 *    today's legacy behavior (tax stays in the line items, no rate is set).
 *  - `taxRatePercent: 0` — the takeoff is explicitly UNTAXED (a tax row totalling exactly zero).
 *    This is an answer, not an absence: storing it suppresses the approval-time gross-up that a
 *    null would let fire. `items` has the tax row(s) removed.
 *  - `taxRatePercent > 0` — the derived rate. `items` has the tax row(s) removed.
 */
export type TakeoffTaxSplit = {
    items: unknown[]; // input items with the tax pass-through rows removed
    preTaxSubtotal: number;
    taxAmount: number;
    taxRatePercent: number | null; // null => no usable tax line; caller must not set a rate
};

/**
 * Separate the AI takeoff's sales-tax pass-through row(s) from the rest of the items, and derive
 * the tax rate they imply.
 *
 * The AI takeoff prompt emits sales tax as a `99-TAX` line item, and `totalEstimate` sums every
 * item's total — so the takeoff total is TAX-INCLUSIVE while every consumer downstream of the
 * converted Estimate treats line items as pre-tax and expects `taxRatePercent` to carry the rate.
 * Left alone, the tax pass-through both sits in the line items AND gets grossed up again by the
 * portal display and the approval flow's default-rate gross-up — a double tax. This function
 * un-does the takeoff's shape into the app's canonical one: strip the tax row(s), derive the rate
 * they imply, and hand back a pre-tax subtotal + tax amount the caller can recombine.
 *
 * Bails out (returns `items` UNCHANGED and `taxRatePercent: null`) whenever the tax row(s) don't
 * imply a rate we can trust: a zero pre-tax subtotal, ANY row (tax or non-tax) whose total isn't a
 * usable number, a subtotal and tax amount with opposite signs, or a derived rate outside (0, 30].
 * A nonsense ratio means we cannot prove the line is really a rate-based pass-through — silently
 * inventing a rate on the money path is worse than leaving the legacy (pre-existing, already
 * shipped) shape alone. 30 mirrors the taxRatePercent validation bound in gpt-estimate.ts.
 *
 * KNOWN LIMIT: the rate is derived as taxAmount / preTaxSubtotal, which assumes the AI taxed the
 * WHOLE subtotal — which is exactly what the prompt instructs ("the 8.4% tax applies to the ENTIRE
 * CONTRACT PRICE"). If a takeoff ever taxes only part of the base, the derived rate is a BLENDED
 * rate: the stored total still ties out to the penny today, but a later edit reprices tax at the
 * blended rate. That is accepted deliberately — bailing out would restore a guaranteed
 * full-default-rate overcharge on every such estimate, which is strictly worse than a rate that is
 * exactly right today and only approximate after an edit.
 */
export function splitTakeoffTax<T extends { costCode?: unknown; total?: unknown }>(
    items: T[],
): { items: T[]; preTaxSubtotal: number; taxAmount: number; taxRatePercent: number | null } {
    // Single pass so we don't run isTaxRow twice per item across two .filter calls.
    const nonTaxRows: T[] = [];
    const taxRows: T[] = [];
    for (const item of items) {
        if (isTaxRow(item)) taxRows.push(item);
        else nonTaxRows.push(item);
    }

    const preTaxSubtotal = rmc(nonTaxRows.reduce((sum, item) => sum + numOr(item.total, 0), 0));

    if (taxRows.length === 0) {
        return { items, preTaxSubtotal, taxAmount: 0, taxRatePercent: null };
    }

    // EVERY row's total — tax AND non-tax — must be a usable number before we trust anything
    // derived from them. A non-tax row with a garbage total would otherwise silently shrink
    // preTaxSubtotal via numOr's 0-fallback (inflating whatever rate a fixed tax amount implies,
    // and understating the stored total); a tax row with a garbage total tells us nothing about
    // the rate either, and can't be told apart from a genuine zero-tax answer (see the
    // `taxAmount === 0` branch below) without this check. One gate covers both directions of the
    // same failure: a partial base silently reprices tax.
    const hasUsableTotals =
        nonTaxRows.every((item) => numOrNull(item.total) !== null) &&
        taxRows.every((item) => numOrNull(item.total) !== null);
    const taxAmount = rmc(taxRows.reduce((sum, item) => sum + numOr(item.total, 0), 0));

    // A zero pre-tax subtotal can never imply a rate (division by zero) regardless of sign, and an
    // unusable total (on either side) tells us nothing either way.
    if (preTaxSubtotal === 0 || !hasUsableTotals) {
        return { items, preTaxSubtotal, taxAmount, taxRatePercent: null };
    }

    // A tax row present with a total of exactly zero is a real, storable answer — the takeoff is
    // explicitly untaxed, not "unknown" — which suppresses the approval-time default-rate gross-up
    // instead of leaving it to fire. This is sign-independent: a credit takeoff (negative subtotal)
    // that is explicitly untaxed is just as real an answer as a positive one, and leaving it to
    // bail out would let the approval gross-up make the credit MORE negative. (preTaxSubtotal is
    // already known non-zero here, since the check above returned otherwise.)
    if (taxAmount === 0) {
        return { items: nonTaxRows, preTaxSubtotal, taxAmount, taxRatePercent: 0 };
    }

    // Credit / negative estimates: a negative subtotal with a negative tax row implies the same
    // rate a positive pair would (dividing two negatives is positive), so derive it the same way.
    // Mismatched signs (e.g. a positive subtotal with a negative tax row, or vice versa) are not a
    // rate-based pass-through — bail out rather than guess.
    const sameSign = (preTaxSubtotal > 0 && taxAmount > 0) || (preTaxSubtotal < 0 && taxAmount < 0);
    if (!sameSign) {
        return { items, preTaxSubtotal, taxAmount, taxRatePercent: null };
    }

    // Round to 4dp for the common case (a clean "8.4" reads better than "8.40000000000001"), but
    // only keep the rounded value if it actually reproduces the stored tax amount to the penny when
    // re-applied to the subtotal — e.g. subtotal 100000 / tax 8377.54 has an exact rate of
    // 8.37754%, which rounds to 8.3775%, but 100000 * 8.3775% = 8377.50, four cents off the real
    // total. In that case keep the UNROUNDED exact rate instead, so the portal's recomputed
    // `subtotal * rate/100` always agrees with the persisted total to the penny.
    // `Estimate.taxRatePercent` is an unbounded Prisma `Decimal?`, so the extra precision persists
    // fine either way.
    const exactRate = (taxAmount / preTaxSubtotal) * 100;
    const rounded4 = Math.round(exactRate * 10000) / 10000;
    const rounded4ReproducesTax = rmc((preTaxSubtotal * rounded4) / 100) === taxAmount;
    const derivedRate = rounded4ReproducesTax ? rounded4 : exactRate;

    if (!Number.isFinite(derivedRate) || derivedRate <= 0 || derivedRate > 30) {
        return { items, preTaxSubtotal, taxAmount, taxRatePercent: null };
    }

    return { items: nonTaxRows, preTaxSubtotal, taxAmount, taxRatePercent: derivedRate };
}
