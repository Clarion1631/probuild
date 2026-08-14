/**
 * buildTaxOptions/resolveActiveTax/taxFieldsForSave pick the estimate editor's active sales-tax
 * rate out of two sources: the company's configured `CompanySettings.salesTaxes`, and the
 * estimate's OWN stored `taxRateName`/`taxRatePercent`. Identity is the option KEY, never the
 * display name — see the module doc comment for why a by-name lookup silently re-quotes the
 * client.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    SAVED_TAX_KEY,
    buildTaxOptions,
    resolveActiveTax,
    taxFieldsForSave,
    type CompanySalesTax,
} from "../src/lib/estimate-tax-options";

/**
 * One open-the-editor-and-save cycle, exactly as the editor performs it: build the options from
 * what is stored, select `initialKey`, resolve the active option, and write the fields back.
 * Returns what the save would persist, so a test can feed it straight into the next cycle.
 */
function openAndSave(
    salesTaxes: CompanySalesTax[],
    stored: { name: string | null; percent: number | string | null },
    opts: { taxExempt?: boolean; selectKey?: string } = {},
) {
    const set = buildTaxOptions(salesTaxes, { name: stored.name, percent: stored.percent });
    const key = opts.selectKey ?? set.initialKey;
    const activeTax = resolveActiveTax(set.options, key, set.defaultOption);
    const written = taxFieldsForSave(activeTax, !!opts.taxExempt);
    return { set, key, activeTax, written };
}

/**
 * The DB round trip: what a save wrote into `Estimate.taxRateName`/`taxRatePercent` is what the
 * next open reads back as the stored pair. Kept explicit because the two shapes use different
 * key names, and quietly passing one where the other is expected makes a re-rating bug look
 * like a pass.
 */
function reopen(written: { taxRateName: string | null; taxRatePercent: number | null }) {
    return { name: written.taxRateName, percent: written.taxRatePercent };
}

test("THE REGRESSION: a custom stored rate survives open+save untouched", () => {
    // A takeoff-converted estimate stores the literal name "Sales Tax" next to a rate the
    // company settings do not carry. Before the fix the editor resolved by name, found the
    // company's "Sales Tax" at 8.8%, and the first save re-quoted the client at 8.8% — silently
    // changing an already-issued total. The stored 9.15% must come back out byte-for-byte.
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const stored = { name: "Sales Tax", percent: 9.15 };

    const first = openAndSave(salesTaxes, stored);
    assert.equal(first.key, SAVED_TAX_KEY);
    assert.equal(first.activeTax?.rate, 9.15, "must not resolve to the company's 8.8%");
    assert.deepEqual(first.written, { taxRateName: "Sales Tax", taxRatePercent: 9.15 });

    // Reopening on what the first save wrote must be a fixed point, not a slow drift toward
    // the company default. Two further cycles, because a re-rating bug can take a save to show.
    const second = openAndSave(salesTaxes, reopen(first.written));
    assert.equal(second.activeTax?.rate, 9.15);
    assert.deepEqual(second.written, first.written);

    const third = openAndSave(salesTaxes, reopen(second.written));
    assert.deepEqual(third.written, first.written);
});

test("a matched company rate still resolves by name and stays on the company option", () => {
    const salesTaxes: CompanySalesTax[] = [
        { name: "WA Sales Tax", rate: 8.8, isDefault: true },
        { name: "Clark County", rate: 7.7 },
    ];
    const { set, key, activeTax, written } = openAndSave(salesTaxes, {
        name: "Clark County",
        percent: 7.7,
    });

    // No synthetic option: settings already carry this exact name+rate pair.
    assert.equal(set.savedOption, null);
    assert.equal(set.options.length, 2);
    assert.equal(key, "Clark County");
    assert.equal(activeTax?.orphaned, false);
    assert.deepEqual(written, { taxRateName: "Clark County", taxRatePercent: 7.7 });
});

test("switching to a company rate re-quotes deliberately, which is the whole point of the picker", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { written } = openAndSave(
        salesTaxes,
        { name: "Old City Tax", percent: 7.5 },
        { selectKey: "WA Sales Tax" },
    );
    assert.deepEqual(written, { taxRateName: "WA Sales Tax", taxRatePercent: 8.8 });
});

test("the exempt path clears both columns regardless of the resolved option", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { activeTax, written } = openAndSave(
        salesTaxes,
        { name: "Old City Tax", percent: 7.5 },
        { taxExempt: true },
    );

    // The option still resolves — exemption is applied at write time, not by unresolving it.
    assert.equal(activeTax?.rate, 7.5);
    assert.deepEqual(written, { taxRateName: null, taxRatePercent: null });
});

test("un-exempting an exempt estimate falls back to the company default, not a stale rate", () => {
    // What an exempt save left behind is a null/null pair, so the next open has nothing to
    // preserve and legitimately lands on the default.
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { key, written } = openAndSave(salesTaxes, { name: null, percent: null });
    assert.equal(key, "WA Sales Tax");
    assert.deepEqual(written, { taxRateName: "WA Sales Tax", taxRatePercent: 8.8 });
});

test("a saved rate with a null name is preserved verbatim, not synthesized", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { set, activeTax, written } = openAndSave(salesTaxes, { name: null, percent: 9.4 });

    assert.notEqual(set.savedOption, null);
    assert.equal(set.savedOption!.name, null);
    assert.equal(set.savedOption!.label, "Saved rate", "the picker needs text; the column does not");
    assert.equal(activeTax?.rate, 9.4);
    // The name column must stay null — opening the editor cannot invent a name.
    assert.deepEqual(written, { taxRateName: null, taxRatePercent: 9.4 });
});

test("a renamed/removed company tax still resolves to the stored rate", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { set, activeTax } = openAndSave(salesTaxes, { name: "Old City Tax", percent: 7.5 });

    assert.notEqual(set.savedOption, null);
    assert.equal(activeTax?.rate, 7.5);
    assert.equal(set.savedOption!.orphaned, true, "the picker flags it as not in settings");
});

test("a stored rate of 0 is an answer, not an absence", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Default", rate: 8.8, isDefault: true }];
    const { activeTax, written } = openAndSave(salesTaxes, { name: "Zero", percent: 0 });

    assert.equal(activeTax?.rate, 0, "must not fall through to the 8.8% default");
    assert.deepEqual(written, { taxRateName: "Zero", taxRatePercent: 0 });
});

test("a null percent means unset, falling back to the default option", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Default", rate: 8.8, isDefault: true }];
    const { set, activeTax } = openAndSave(salesTaxes, { name: null, percent: null });

    assert.equal(set.savedOption, null);
    assert.equal(set.initialKey, "Default");
    assert.equal(activeTax?.rate, 8.8);
});

test("a non-finite/garbage percent is ignored, falling back to the default option", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Default", rate: 8.8, isDefault: true }];
    const { set, activeTax } = openAndSave(salesTaxes, { name: "X", percent: "abc" });

    assert.equal(set.savedOption, null);
    assert.equal(activeTax?.rate, 8.8);
});

test("a string percent (Prisma Decimal serializes to string) is handled numerically", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const { activeTax, written } = openAndSave(salesTaxes, { name: "Sales Tax", percent: "9.15" });

    assert.equal(activeTax?.rate, 9.15);
    assert.equal(typeof activeTax?.rate, "number");
    assert.equal(typeof written.taxRatePercent, "number", "the column takes a number, not '9.15'");
});

test("a string percent equal to a company rate is treated as covered, not orphaned", () => {
    // "8.8" == 8.8 numerically; a string/number mismatch must not fabricate a duplicate option.
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const { set } = openAndSave(salesTaxes, { name: "Sales Tax", percent: "8.8" });

    assert.equal(set.savedOption, null);
    assert.equal(set.options.length, 1);
});

test("empty salesTaxes with a saved rate: the saved rate is the only option", () => {
    const { set, activeTax, written } = openAndSave([], { name: "Sales Tax", percent: 9.15 });

    assert.equal(set.options.length, 1);
    assert.equal(set.defaultOption, null);
    assert.equal(activeTax?.rate, 9.15);
    assert.deepEqual(written, { taxRateName: "Sales Tax", taxRatePercent: 9.15 });
});

test("empty salesTaxes and nothing saved: no options, resolveActiveTax returns null", () => {
    const { set, activeTax, written } = openAndSave([], { name: null, percent: null });

    assert.equal(set.options.length, 0);
    assert.equal(set.defaultOption, null);
    assert.equal(set.initialKey, null);
    assert.equal(activeTax, null);
    assert.deepEqual(written, { taxRateName: null, taxRatePercent: null });
});

test("isDefault selection: the flagged company tax wins over positional order", () => {
    const salesTaxes: CompanySalesTax[] = [
        { name: "A", rate: 1, isDefault: false },
        { name: "B", rate: 2, isDefault: true },
        { name: "C", rate: 3, isDefault: false },
    ];
    const { defaultOption } = buildTaxOptions(salesTaxes, { name: null, percent: null });
    assert.equal(defaultOption?.name, "B");
});

test("isDefault selection: with none flagged default, the first option wins", () => {
    const salesTaxes: CompanySalesTax[] = [
        { name: "A", rate: 1, isDefault: false },
        { name: "B", rate: 2, isDefault: false },
    ];
    const { defaultOption } = buildTaxOptions(salesTaxes, { name: null, percent: null });
    assert.equal(defaultOption?.name, "A");
});

test("option keys stay unique even when the saved name collides with a company name", () => {
    // Two options can share a LABEL (the picker appends each rate, so they read differently),
    // but a duplicate key would make the saved option unselectable — the original bug.
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const { options } = buildTaxOptions(salesTaxes, { name: "Sales Tax", percent: 9.15 });

    assert.equal(options.length, 2);
    assert.equal(new Set(options.map(o => o.key)).size, options.length);
});

test("an unknown selected key falls back to the company default rather than dropping tax", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { options, defaultOption } = buildTaxOptions(salesTaxes, { name: null, percent: null });

    assert.equal(resolveActiveTax(options, "deleted-tax", defaultOption)?.rate, 8.8);
});
