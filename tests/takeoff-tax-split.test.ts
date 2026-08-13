/**
 * splitTakeoffTax pulls the AI takeoff's `99-TAX` pass-through row(s) out of the item list and
 * derives the rate they imply, so a takeoff-converted Estimate lands in the app's canonical tax
 * shape (pre-tax line items + `taxRatePercent`) instead of the takeoff's own shape (tax baked
 * into a line item, `taxRatePercent` left null).
 *
 * The headline test below is the regression this exists to fix: left in the takeoff's own shape,
 * a null `taxRatePercent` reads downstream as "tax-exclusive, gross up by the default rate" — both
 * the portal display and the approval gross-up in actions.ts do this — which double-taxes an
 * already tax-inclusive total. `approvalGrossUp` and `portalDisplayTotal` below are small local
 * models of those two call sites, not imports, so this test pins the CONTRACT rather than
 * reaching into unrelated modules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTakeoffTax, rmc, numOrNull } from "../src/lib/takeoff-costing";

// Mirrors src/lib/actions.ts's approval-time gross-up (ensureProjectAndDepositInvoiceForEstimate).
function approvalGrossUp(total: number, taxRatePercent: number | null, taxExempt: boolean, defaultRate: number): number {
    if (taxExempt || taxRatePercent != null) return total;
    return rmc(total * (1 + defaultRate / 100));
}

// Mirrors src/app/portal/estimates/[id]/PortalEstimateClient.tsx's displayed total.
function portalDisplayTotal(items: Array<{ total: number }>, taxRatePercent: number | null, defaultRate: number): number {
    const subtotal = items.reduce((s, i) => s + i.total, 0);
    const rate = taxRatePercent ?? defaultRate;
    return rmc(subtotal + subtotal * (rate / 100));
}

test("canonical case: tax row stripped, subtotal/tax/rate derived correctly", () => {
    const items = [
        { costCode: "01-DEMO", total: 40000 },
        { costCode: "02-FRAME", total: 35000 },
        { costCode: "03-FINISH", total: 25000 },
        { costCode: "99-TAX", total: 8400 },
    ];
    const result = splitTakeoffTax(items);
    assert.equal(result.items.length, 3);
    assert.ok(result.items.every((i: any) => i.costCode !== "99-TAX"));
    assert.equal(result.preTaxSubtotal, 100000);
    assert.equal(result.taxAmount, 8400);
    assert.equal(result.taxRatePercent, 8.4);
    assert.equal(rmc(result.preTaxSubtotal + result.taxAmount), 108400);
});

test("THE DOUBLE-TAX REGRESSION: old shape double-taxes, new shape does not", () => {
    const defaultRate = 8.4;

    // OLD SHAPE: tax row left in the items, taxRatePercent left null (today's behavior pre-fix).
    const oldItems = [
        { costCode: "01-DEMO", total: 40000 },
        { costCode: "02-FRAME", total: 35000 },
        { costCode: "03-FINISH", total: 25000 },
        { costCode: "99-TAX", total: 8400 },
    ];
    const oldTotal = oldItems.reduce((s, i) => s + i.total, 0); // 108400, already tax-inclusive
    // Approval grosses it up again because taxRatePercent is null.
    assert.equal(approvalGrossUp(oldTotal, null, false, defaultRate), 117505.6);
    // Portal display adds default tax on top of a subtotal that already includes the tax row.
    assert.equal(portalDisplayTotal(oldItems, null, defaultRate), 117505.6);

    // NEW SHAPE: split applied.
    const split = splitTakeoffTax(oldItems);
    assert.equal(split.taxRatePercent, 8.4);
    const newTotal = rmc(split.preTaxSubtotal + split.taxAmount);
    assert.equal(newTotal, 108400);
    assert.equal(approvalGrossUp(newTotal, split.taxRatePercent, false, defaultRate), 108400);
    assert.equal(portalDisplayTotal(split.items as Array<{ total: number }>, split.taxRatePercent, defaultRate), 108400);
});

test("no tax row: items unchanged, rate null, approval gross-up still fires", () => {
    const items = [
        { costCode: "01-DEMO", total: 40000 },
        { costCode: "02-FRAME", total: 35000 },
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
    assert.equal(result.preTaxSubtotal, 75000);
    assert.equal(result.taxAmount, 0);
    // Must NOT regress: the approval gross-up still needs to apply for a genuinely untaxed takeoff.
    assert.equal(approvalGrossUp(75000, result.taxRatePercent, false, 8.4), 81300);
});

test("multiple tax rows (99-TAX and 99-TAX-STATE) sum into one rate", () => {
    const items = [
        { costCode: "01-DEMO", total: 50000 },
        { costCode: "02-FRAME", total: 50000 },
        { costCode: "99-TAX", total: 5000 },
        { costCode: "99-TAX-STATE", total: 3400 },
    ];
    const result = splitTakeoffTax(items);
    assert.equal(result.items.length, 2);
    assert.equal(result.preTaxSubtotal, 100000);
    assert.equal(result.taxAmount, 8400);
    assert.equal(result.taxRatePercent, 8.4);
});

test("99-TAXABLE is not treated as a tax row", () => {
    const items = [
        { costCode: "01-DEMO", total: 50000 },
        { costCode: "99-TAXABLE", total: 25000 },
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
    assert.equal(result.preTaxSubtotal, 75000);
});

test("bail-out: zero pre-tax subtotal returns items unchanged and a null rate", () => {
    const items = [
        { costCode: "99-TAX", total: 100 },
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
});

test("bail-out: a tax row implying a rate above 30% returns items unchanged and a null rate", () => {
    const items = [
        { costCode: "01-DEMO", total: 1000 },
        { costCode: "99-TAX", total: 400 }, // implies 40%
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
});

test("bail-out: a non-numeric/absent total on the tax row returns items unchanged and a null rate", () => {
    const itemsNonNumeric = [
        { costCode: "01-DEMO", total: 1000 },
        { costCode: "99-TAX", total: "not-a-number" as any },
    ];
    const resultNonNumeric = splitTakeoffTax(itemsNonNumeric);
    assert.deepEqual(resultNonNumeric.items, itemsNonNumeric);
    assert.equal(resultNonNumeric.taxRatePercent, null);

    const itemsAbsent = [
        { costCode: "01-DEMO", total: 1000 },
        { costCode: "99-TAX" } as any,
    ];
    const resultAbsent = splitTakeoffTax(itemsAbsent);
    assert.deepEqual(resultAbsent.items, itemsAbsent);
    assert.equal(resultAbsent.taxRatePercent, null);
});

test("a non-round rate (8.3775%) round-trips at 4 decimal places", () => {
    const items = [
        { costCode: "01-DEMO", total: 100000 },
        { costCode: "99-TAX", total: 8377.5 },
    ];
    const result = splitTakeoffTax(items);
    assert.equal(result.taxRatePercent, 8.3775);
});

test("bail-out: a non-numeric/absent total on a NON-tax row also returns items unchanged and a null rate", () => {
    // A garbage non-tax total must not silently shrink preTaxSubtotal via numOr's 0-fallback,
    // which would otherwise inflate the rate the (perfectly fine) tax row implies.
    const itemsNonNumeric = [
        { costCode: "01-DEMO", total: "garbage" as any },
        { costCode: "02-FRAME", total: 50000 },
        { costCode: "99-TAX", total: 4200 },
    ];
    const resultNonNumeric = splitTakeoffTax(itemsNonNumeric);
    assert.deepEqual(resultNonNumeric.items, itemsNonNumeric);
    assert.equal(resultNonNumeric.taxRatePercent, null);

    const itemsAbsent = [
        { costCode: "01-DEMO" } as any,
        { costCode: "02-FRAME", total: 50000 },
        { costCode: "99-TAX", total: 4200 },
    ];
    const resultAbsent = splitTakeoffTax(itemsAbsent);
    assert.deepEqual(resultAbsent.items, itemsAbsent);
    assert.equal(resultAbsent.taxRatePercent, null);
});

test("a rate that doesn't round-trip at 4dp keeps the exact (unrounded) rate so the stored total reconciles", () => {
    // Exact rate is 8.37754%; rounding to 4dp (8.3775%) reproduces 8377.50, four cents short of the
    // real 8377.54 tax amount — so the exact rate must be kept instead of the rounded one.
    const items = [
        { costCode: "01-DEMO", total: 100000 },
        { costCode: "99-TAX", total: 8377.54 },
    ];
    const result = splitTakeoffTax(items);
    // Compare against the exact (not the rounded-to-4dp) rate — floating-point division doesn't
    // land on the clean literal 8.37754, so pin the reconciliation property instead of the exact
    // float bits.
    assert.ok(Math.abs(result.taxRatePercent! - 8.37754) < 1e-9);
    assert.notEqual(result.taxRatePercent, 8.3775); // the rounded-4dp value that would NOT reconcile
    assert.equal(rmc((result.preTaxSubtotal * result.taxRatePercent!) / 100), result.taxAmount);
});

test("a zero-total tax row on a positive subtotal is a real answer: rate 0, row stripped", () => {
    const items = [
        { costCode: "01-DEMO", total: 40000 },
        { costCode: "02-FRAME", total: 35000 },
        { costCode: "99-TAX", total: 0 },
    ];
    const result = splitTakeoffTax(items);
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((i: any) => i.costCode !== "99-TAX"));
    assert.equal(result.preTaxSubtotal, 75000);
    assert.equal(result.taxAmount, 0);
    assert.equal(result.taxRatePercent, 0);
    // A rate of 0 must suppress the approval gross-up, same as any other real rate.
    assert.equal(approvalGrossUp(75000, result.taxRatePercent, false, 8.4), 75000);
});

test("a zero-total tax row on a NEGATIVE subtotal is also a real answer: rate 0, row stripped (sign-independent)", () => {
    const items = [
        { costCode: "01-DEMO", total: -40000 },
        { costCode: "99-TAX", total: 0 },
    ];
    const result = splitTakeoffTax(items);
    assert.equal(result.items.length, 1);
    assert.ok(result.items.every((i: any) => i.costCode !== "99-TAX"));
    assert.equal(result.preTaxSubtotal, -40000);
    assert.equal(result.taxAmount, 0);
    assert.equal(result.taxRatePercent, 0);
    // A rate of 0 must suppress the approval gross-up here too — otherwise the credit gets MORE
    // negative, not less.
    assert.equal(approvalGrossUp(-40000, result.taxRatePercent, false, 8.4), -40000);
});

test("credit estimate: negative subtotal + negative tax row derives the same rate as the positive pair", () => {
    const items = [
        { costCode: "01-DEMO", total: -40000 },
        { costCode: "02-FRAME", total: -35000 },
        { costCode: "03-FINISH", total: -25000 },
        { costCode: "99-TAX", total: -8400 },
    ];
    const result = splitTakeoffTax(items);
    assert.equal(result.items.length, 3);
    assert.equal(result.preTaxSubtotal, -100000);
    assert.equal(result.taxAmount, -8400);
    assert.equal(result.taxRatePercent, 8.4);
    // The credit total (subtotal + tax, both negative) is more negative, not less.
    assert.equal(rmc(result.preTaxSubtotal + result.taxAmount), -108400);
});

test("credit estimate: a derived credit rate above 30% still bails out", () => {
    const items = [
        { costCode: "01-DEMO", total: -1000 },
        { costCode: "99-TAX", total: -400 }, // implies 40%
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
});

test("mismatched signs (positive subtotal, negative tax row) bail out rather than guess", () => {
    const items = [
        { costCode: "01-DEMO", total: 100000 },
        { costCode: "99-TAX", total: -8400 },
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
});

test("mismatched signs (negative subtotal, positive tax row) bail out rather than guess", () => {
    const items = [
        { costCode: "01-DEMO", total: -100000 },
        { costCode: "99-TAX", total: 8400 },
    ];
    const result = splitTakeoffTax(items);
    assert.deepEqual(result.items, items);
    assert.equal(result.taxRatePercent, null);
});

// --- numOrNull ----------------------------------------------------------------------------------

test("numOrNull: plain numbers pass through, non-finite numbers are null", () => {
    assert.equal(numOrNull(12.5), 12.5);
    assert.equal(numOrNull(0), 0);
    assert.equal(numOrNull(-3), -3);
    assert.equal(numOrNull(NaN), null);
    assert.equal(numOrNull(Infinity), null);
});

test("numOrNull: numeric strings parse, with surrounding whitespace trimmed first", () => {
    assert.equal(numOrNull("12.5"), 12.5);
    assert.equal(numOrNull(" 12.5 "), 12.5);
    assert.equal(numOrNull("\t8400\n"), 8400);
    assert.equal(numOrNull("-40000"), -40000);
});

test("numOrNull: empty and whitespace-only strings are null, not a false zero", () => {
    assert.equal(numOrNull(""), null);
    assert.equal(numOrNull("   "), null);
    assert.equal(numOrNull("\t\n"), null);
});

test("numOrNull: junk strings are null, not parseFloat's partial-parse leniency", () => {
    assert.equal(numOrNull("12junk"), null);
    assert.equal(numOrNull("not-a-number"), null);
});

test("numOrNull: null/undefined are null", () => {
    assert.equal(numOrNull(null), null);
    assert.equal(numOrNull(undefined), null);
});

test("numOrNull: booleans and non-primitive inputs are null, not Number()'s coercion", () => {
    // Number(true) === 1, Number(false) === 0, Number([]) === 0, Number({}) === NaN — none of
    // these describe "the caller handed us a usable number", so none should parse.
    assert.equal(numOrNull(true), null);
    assert.equal(numOrNull(false), null);
    assert.equal(numOrNull([]), null);
    assert.equal(numOrNull([42]), null);
    assert.equal(numOrNull({}), null);
    assert.equal(numOrNull({ value: 5 }), null);
});
