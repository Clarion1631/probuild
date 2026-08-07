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
 */
export function numOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : null;
}

/** `numOrNull` with a fallback for values that must end up numeric. */
export function numOr(value: unknown, fallback: number): number {
    return numOrNull(value) ?? fallback;
}

/** Round to cents. */
export const rmc = (n: number) => Math.round(n * 100) / 100;
