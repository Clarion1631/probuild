/**
 * buildTaxOptions/reconcileTaxKey/resolveActiveTax/taxFieldsForSave pick the estimate editor's
 * active sales-tax rate out of two sources: the company's configured `CompanySettings.salesTaxes`,
 * and the estimate's OWN stored `taxRateName`/`taxRatePercent`. Identity is the option KEY, and a
 * key is opaque and generated — see the module doc comment for why any name-derived key silently
 * re-quotes the client.
 *
 * Every case here asserts the MONEY (`totalAmount` at a fixed subtotal) and the change-detection
 * snapshot, not just which option came back: the bug this module exists to prevent is invisible
 * in the picker and only shows up in what the next save writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EXEMPT_TAX_KEY,
    SAVED_TAX_KEY,
    buildTaxOptions,
    companyTaxKey,
    reconcileTaxKey,
    resolveActiveTax,
    sanitizeCompanySalesTaxes,
    taxFieldsForSave,
    type CompanySalesTax,
    type TaxOption,
    type TaxOptionSet,
} from "../src/lib/estimate-tax-options";
import { parseSalesTaxes } from "../src/lib/sales-tax";

/** Every test prices the same job, so a re-rating shows up as a different dollar total. */
const SUBTOTAL = 10_000;

/** The editor's own money math (`computeSellTotals` in EstimateEditor.tsx), to the cent. */
const rm = (n: number) => Math.round(n * 100) / 100;
function sellTotals(subtotal: number, activeTax: TaxOption | null, taxExempt: boolean, processingFeeMarkup = 0) {
    const taxRate = taxExempt ? 0 : (activeTax ? activeTax.rate / 100 : 0.088);
    const processingFee = processingFeeMarkup > 0 ? rm(subtotal * (processingFeeMarkup / 100)) : 0;
    const tax = rm(subtotal * taxRate);
    return { tax, totalAmount: rm(subtotal + tax + processingFee) };
}

/**
 * One open-the-editor-and-save cycle, exactly as the editor performs it: build the options from
 * what is stored, select `initialKey`, resolve the active option, price the job, and write the
 * fields back. Returns what the save would persist, so a test can feed it straight into the next
 * cycle.
 *
 * `snapshot` mirrors the tax-bearing slice of `getEstimateSnapshot()`, which the editor freezes
 * into `lastSavedStateRef` on mount and diffs every later save against.
 */
function openAndSave(
    salesTaxes: CompanySalesTax[] | null | undefined,
    stored: { name: string | null; percent: number | string | null },
    opts: { taxExempt?: boolean; selectKey?: string | null; subtotal?: number } = {},
) {
    const set = buildTaxOptions(salesTaxes, { name: stored.name, percent: stored.percent });
    const key = "selectKey" in opts ? opts.selectKey! : set.initialKey;
    const activeTax = resolveActiveTax(set.options, key, set.defaultOption);
    const taxExempt = !!opts.taxExempt;
    const written = taxFieldsForSave(activeTax, taxExempt);
    const money = sellTotals(opts.subtotal ?? SUBTOTAL, activeTax, taxExempt);
    const snapshot = JSON.stringify({ taxExempt, ...written, totalAmount: money.totalAmount });
    return { set, key, activeTax, written, ...money, snapshot };
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

/** The key of the company option carrying this exact name+rate. Keys are opaque, so ask. */
function keyOf(set: TaxOptionSet, name: string, rate: number): string {
    const found = set.options.find(o => o.name === name && o.rate === rate);
    assert.ok(found, `no option for ${name} @ ${rate}`);
    return found.key;
}

/** `initialKey` must always name a real option — see the TaxOptionSet doc comment. */
function assertInitialKeyIsSelectable(set: TaxOptionSet, label: string) {
    if (set.options.length === 0) {
        assert.equal(set.initialKey, null, `${label}: no options, so nothing can be selected`);
        return;
    }
    assert.ok(
        set.options.some(o => o.key === set.initialKey),
        `${label}: initialKey ${JSON.stringify(set.initialKey)} is not in the option list`,
    );
}

// ─── The regression this module exists for ───────────────────────────────────────────────────

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
    // The money, which is the whole point: 8.8% would have billed $10,880.
    assert.equal(first.tax, 915);
    assert.equal(first.totalAmount, 10_915);

    // Reopening on what the first save wrote must be a fixed point, not a slow drift toward
    // the company default. Two further cycles, because a re-rating bug can take a save to show.
    const second = openAndSave(salesTaxes, reopen(first.written));
    assert.equal(second.activeTax?.rate, 9.15);
    assert.deepEqual(second.written, first.written);
    assert.equal(second.snapshot, first.snapshot);

    const third = openAndSave(salesTaxes, reopen(second.written));
    assert.deepEqual(third.written, first.written);
    assert.equal(third.totalAmount, 10_915);
});

test("opening an estimate is a no-op for the tax columns: an unrelated save writes them back unchanged", () => {
    // The editor freezes getEstimateSnapshot() into lastSavedStateRef on mount, then ships that
    // whole payload on ANY later save (retitle, edit a line item). If the mount snapshot resolved
    // the tax differently from what is stored, an edit that never touched tax re-rates the client.
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Clark County", rate: 7.7 },
    ];
    for (const stored of [
        { name: "Sales Tax", percent: 9.15 },   // orphaned custom rate
        { name: "Clark County", percent: 7.7 }, // exact company match
        { name: null, percent: 9.4 },           // nameless stored rate
        { name: "Zero", percent: 0 },           // an explicit 0% quote
    ]) {
        const opened = openAndSave(salesTaxes, stored);
        assert.deepEqual(
            opened.written,
            { taxRateName: stored.name, taxRatePercent: stored.percent },
            `opening ${JSON.stringify(stored)} must not change the stored pair`,
        );
    }
});

// ─── Duplicate names (the round-2 blocker) ───────────────────────────────────────────────────

test("BLOCKER: duplicate company names at different rates stay individually selectable", () => {
    // /settings/sales-taxes does not dedupe names. With name-derived keys, the 9.15% row was
    // unreachable: the stored 9.15 pair read as "covered by settings", and every lookup then
    // returned the FIRST "Sales Tax" — the 8.8% one — and re-quoted the client.
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Sales Tax", rate: 9.15 },
    ];

    const high = openAndSave(salesTaxes, { name: "Sales Tax", percent: 9.15 });
    assert.equal(high.set.options.length, 2, "an exact pair match needs no synthetic option");
    assert.equal(high.set.savedOption, null);
    assert.equal(high.key, keyOf(high.set, "Sales Tax", 9.15));
    assert.equal(high.activeTax?.rate, 9.15, "must not collapse onto the first 'Sales Tax'");
    assert.deepEqual(high.written, { taxRateName: "Sales Tax", taxRatePercent: 9.15 });
    assert.equal(high.totalAmount, 10_915);

    // The other one still resolves to itself, so the two rows are genuinely distinct options.
    const low = openAndSave(salesTaxes, { name: "Sales Tax", percent: 8.8 });
    assert.equal(low.key, keyOf(low.set, "Sales Tax", 8.8));
    assert.equal(low.totalAmount, 10_880);

    assert.notEqual(high.key, low.key, "duplicate names must not share a key");
    assert.equal(new Set(high.set.options.map(o => o.key)).size, 2);
});

test("BLOCKER: a duplicate name at a THIRD rate still yields the synthetic saved option", () => {
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Sales Tax", rate: 9.15 },
    ];
    const { set, key, activeTax, totalAmount } = openAndSave(salesTaxes, { name: "Sales Tax", percent: 10.1 });

    assert.equal(key, SAVED_TAX_KEY);
    assert.equal(set.savedOption?.orphaned, true);
    assert.equal(activeTax?.rate, 10.1);
    assert.equal(totalAmount, 11_010);
});

test("BLOCKER: company rows named like the reserved keys cannot shadow them", () => {
    // "__saved__" as a company name used to mint the same key as the synthetic saved option
    // (shadowing the estimate's own rate), and "__exempt__" used to make picking that row zero
    // out the tax as if the client were exempt.
    const salesTaxes: CompanySalesTax[] = [
        { name: SAVED_TAX_KEY, rate: 5, isDefault: true },
        { name: EXEMPT_TAX_KEY, rate: 6 },
    ];
    const { set, key, activeTax, written, totalAmount } = openAndSave(salesTaxes, {
        name: "Custom",
        percent: 9.15,
    });

    for (const option of set.options.filter(o => o.key !== SAVED_TAX_KEY)) {
        assert.equal(option.key, companyTaxKey(set.options.indexOf(option)));
        assert.notEqual(option.key, SAVED_TAX_KEY);
        assert.notEqual(option.key, EXEMPT_TAX_KEY);
    }
    assert.equal(key, SAVED_TAX_KEY, "the synthetic option keeps its own key");
    assert.equal(activeTax?.rate, 9.15, "must not resolve to the row NAMED __saved__");
    assert.deepEqual(written, { taxRateName: "Custom", taxRatePercent: 9.15 });
    assert.equal(totalAmount, 10_915);
});

test("BLOCKER: selecting a row named __exempt__ taxes at its rate, it does not exempt", () => {
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: EXEMPT_TAX_KEY, rate: 6 },
    ];
    const set = buildTaxOptions(salesTaxes, { name: null, percent: null });
    const trap = keyOf(set, EXEMPT_TAX_KEY, 6);

    assert.notEqual(trap, EXEMPT_TAX_KEY, "the picker's exemption branch keys on the literal");
    const { written, totalAmount } = openAndSave(salesTaxes, { name: null, percent: null }, { selectKey: trap });
    assert.deepEqual(written, { taxRateName: EXEMPT_TAX_KEY, taxRatePercent: 6 });
    assert.equal(totalAmount, 10_600, "an exemption would have billed a flat $10,000");
});

// ─── initialKey is always selectable (round-2 real issue 2) ──────────────────────────────────

test("initialKey always names a real option, across every stored shape", () => {
    // A controlled <select> whose value matches no <option> renders the FIRST entry while the
    // math uses something else, and the next save writes that mismatch into the tax columns.
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8 },
        { name: "Clark County", rate: 7.7, isDefault: true },
        { name: "Sales Tax", rate: 9.15 },
    ];
    const stored: { name: string | null; percent: number | string | null }[] = [
        { name: null, percent: null },
        { name: "Removed", percent: null },       // a name settings no longer carries, no rate
        { name: "Sales Tax", percent: null },     // a name settings DOES carry, no rate
        { name: "Removed", percent: "abc" },      // non-finite percent
        { name: "Removed", percent: 7.5 },
        { name: "Sales Tax", percent: 9.15 },
        { name: null, percent: 0 },
        { name: "", percent: 6.5 },
    ];
    for (const s of stored) {
        assertInitialKeyIsSelectable(buildTaxOptions(salesTaxes, s), JSON.stringify(s));
        assertInitialKeyIsSelectable(buildTaxOptions([], s), `no settings + ${JSON.stringify(s)}`);
    }
});

test("a stored name with no rate keeps the name when settings still carry it", () => {
    // There is no rate to preserve, so the only thing at stake is `taxRateName`. Landing on the
    // same-named company row keeps the column byte-for-byte and fills in the rate the editor was
    // already applying.
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Clark County", rate: 7.7 },
    ];
    const { set, key, written, totalAmount } = openAndSave(salesTaxes, { name: "Clark County", percent: null });

    assert.equal(set.savedOption, null, "no rate on file means nothing to synthesize");
    assert.equal(key, keyOf(set, "Clark County", 7.7), "not the company DEFAULT");
    assert.deepEqual(written, { taxRateName: "Clark County", taxRatePercent: 7.7 });
    assert.equal(totalAmount, 10_770);
});

test("a stored name settings cannot place costs no money to normalize", () => {
    // ("Removed", null) is unrepresentable: no option can write a name with a null rate without
    // leaving totalAmount — which already carries the fallback rate — contradicting the columns.
    // So we select the default. The client's money must not move; only the label catches up.
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const set = buildTaxOptions(salesTaxes, { name: "Removed", percent: null });
    assertInitialKeyIsSelectable(set, "removed name, no rate");

    const before = sellTotals(SUBTOTAL, resolveActiveTax(set.options, "Removed", set.defaultOption), false);
    const after = openAndSave(salesTaxes, { name: "Removed", percent: null });

    assert.equal(after.key, set.defaultOption?.key);
    assert.equal(after.totalAmount, before.totalAmount, "normalizing the label must not re-price the job");
    assert.equal(after.totalAmount, 10_880);
    assert.deepEqual(after.written, { taxRateName: "Sales Tax", taxRatePercent: 8.8 });
});

test("an unmatched selected key is not silently priced at 8.8% when settings are empty", () => {
    // resolveActiveTax returns null and the editor's fallback rate takes over; with no options at
    // all there is nothing to select, so initialKey stays null rather than pointing at nothing.
    const { set, activeTax, written, totalAmount } = openAndSave([], { name: "Removed", percent: null });

    assert.equal(set.initialKey, null);
    assert.equal(activeTax, null);
    assert.deepEqual(written, { taxRateName: null, taxRatePercent: null });
    assert.equal(totalAmount, 10_880, "the editor's own 8.8% fallback, unchanged by this module");
});

// ─── Stale keys across an option-set rebuild (round-2 real issue 1) ──────────────────────────

test("STALE KEY: the saved rate becoming a settings row keeps the same money", () => {
    // Someone adds the estimate's custom rate to /settings/sales-taxes while the editor is open.
    // The refreshed set no longer carries "__saved__"; without reconciliation the key resolves to
    // nothing, the editor falls to the company default, and the next save re-quotes the client.
    const before: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const first = buildTaxOptions(before, { name: "Sales Tax", percent: 9.15 });
    assert.equal(first.initialKey, SAVED_TAX_KEY);

    const after: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Sales Tax", rate: 9.15 },
    ];
    const second = buildTaxOptions(after, { name: "Sales Tax", percent: 9.15 });
    const key = reconcileTaxKey(first.initialKey, first.options, second);

    assert.equal(key, keyOf(second, "Sales Tax", 9.15));
    const activeTax = resolveActiveTax(second.options, key, second.defaultOption);
    assert.equal(activeTax?.rate, 9.15);
    assert.equal(sellTotals(SUBTOTAL, activeTax, false).totalAmount, 10_915);
    assert.deepEqual(taxFieldsForSave(activeTax, false), { taxRateName: "Sales Tax", taxRatePercent: 9.15 });
});

test("STALE KEY: deleting an earlier settings row repoints the key at a different tax", () => {
    // Keys are positional. Delete row 0 and "company:1" now means what "company:2" meant. A
    // key-exists check would happily keep the stale key and re-quote the client.
    const before: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Clark County", rate: 7.7 },
        { name: "Cowlitz County", rate: 7.9 },
    ];
    const first = buildTaxOptions(before, { name: null, percent: null });
    const picked = keyOf(first, "Clark County", 7.7);
    assert.equal(picked, companyTaxKey(1));

    const after: CompanySalesTax[] = [
        { name: "Clark County", rate: 7.7, isDefault: true },
        { name: "Cowlitz County", rate: 7.9 },
    ];
    const second = buildTaxOptions(after, { name: null, percent: null });
    const key = reconcileTaxKey(picked, first.options, second);

    assert.equal(key, companyTaxKey(0), "the same tax moved to index 0");
    const activeTax = resolveActiveTax(second.options, key, second.defaultOption);
    assert.equal(activeTax?.name, "Clark County");
    assert.equal(sellTotals(SUBTOTAL, activeTax, false).totalAmount, 10_770, "7.9% would be $10,790");
});

test("STALE KEY: a selection settings dropped falls back to the SAVED pair, not the default", () => {
    const before: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Retired Tax", rate: 6.5 },
    ];
    const first = buildTaxOptions(before, { name: "Custom", percent: 9.15 });
    const picked = keyOf(first, "Retired Tax", 6.5);

    const after: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const second = buildTaxOptions(after, { name: "Custom", percent: 9.15 });
    const key = reconcileTaxKey(picked, first.options, second);

    assert.equal(key, SAVED_TAX_KEY, "the estimate's own rate outranks the company default");
    const activeTax = resolveActiveTax(second.options, key, second.defaultOption);
    assert.deepEqual(taxFieldsForSave(activeTax, false), { taxRateName: "Custom", taxRatePercent: 9.15 });
    assert.equal(sellTotals(SUBTOTAL, activeTax, false).totalAmount, 10_915);
});

test("STALE KEY: a refresh that changes nothing is a no-op, so the user's pick survives", () => {
    // Fresh props arrive on every router refresh with a brand-new array identity. Reconciliation
    // must not quietly drag the selection back to initialKey.
    const salesTaxes: CompanySalesTax[] = [
        { name: "Sales Tax", rate: 8.8, isDefault: true },
        { name: "Clark County", rate: 7.7 },
    ];
    const first = buildTaxOptions(salesTaxes, { name: "Sales Tax", percent: 8.8 });
    const picked = keyOf(first, "Clark County", 7.7);
    assert.notEqual(picked, first.initialKey);

    const second = buildTaxOptions([...salesTaxes.map(t => ({ ...t }))], { name: "Sales Tax", percent: 8.8 });
    assert.equal(reconcileTaxKey(picked, first.options, second), picked);

    // ...and the resulting snapshot is byte-identical, so the refresh cannot mark the editor dirty.
    const openedBefore = openAndSave(salesTaxes, { name: "Sales Tax", percent: 8.8 }, { selectKey: picked });
    const openedAfter = openAndSave(salesTaxes, { name: "Sales Tax", percent: 8.8 }, { selectKey: picked });
    assert.equal(openedAfter.snapshot, openedBefore.snapshot);
});

test("STALE KEY: exempt (a null key) stays exempt across a rebuild", () => {
    const first = buildTaxOptions([{ name: "Sales Tax", rate: 8.8, isDefault: true }], { name: null, percent: null });
    const second = buildTaxOptions([{ name: "Clark County", rate: 7.7, isDefault: true }], { name: null, percent: null });
    assert.equal(reconcileTaxKey(null, first.options, second), null);
});

test("STALE KEY: a key from nowhere resolves to a real option rather than sticking", () => {
    const set = buildTaxOptions([{ name: "Sales Tax", rate: 8.8, isDefault: true }], { name: null, percent: null });
    assert.equal(reconcileTaxKey("company:99", [], set), set.initialKey);
    assert.ok(set.options.some(o => o.key === reconcileTaxKey("company:99", [], set)));
});

// ─── Malformed settings JSON (round-2 real issue 3) ──────────────────────────────────────────

test("MALFORMED: buildTaxOptions survives every shape JSON.parse can hand it", () => {
    for (const junk of [null, undefined, {}, "not an array", 5, [null, undefined, "x", 5, []]]) {
        const set = buildTaxOptions(junk as any, { name: "Sales Tax", percent: 9.15 });
        assert.equal(set.options.length, 1, `${JSON.stringify(junk)} must contribute no options`);
        assert.equal(set.initialKey, SAVED_TAX_KEY, "the estimate's own rate still resolves");
        assert.equal(set.defaultOption, null);
    }
});

test("MALFORMED: a row with an unusable rate is DROPPED, never coerced to 0%", () => {
    // A 0% survivor is the dangerous repair: it can become defaultOption and quote the client no
    // tax at all, which reads downstream as a deliberate exemption.
    const salesTaxes = [
        { name: "Broken", rate: "abc" },
        { name: "Missing" },
        { name: "NotANumber", rate: NaN },
        { name: "Infinite", rate: Infinity },
        { name: "Nulled", rate: null },
        { name: "Sales Tax", rate: 8.8 },
    ] as any;
    const set = buildTaxOptions(salesTaxes, { name: null, percent: null });

    assert.deepEqual(set.options.map(o => o.name), ["Sales Tax"]);
    assert.equal(set.defaultOption?.rate, 8.8, "the first VALID row is the default, not a 0% ghost");
    assert.ok(!set.options.some(o => o.rate === 0), "no row was repaired into 0%");
    assert.equal(sellTotals(SUBTOTAL, resolveActiveTax(set.options, set.initialKey, set.defaultOption), false).totalAmount, 10_880);
});

test("MALFORMED: a configured rate of 0 is real and is kept", () => {
    const set = buildTaxOptions([{ name: "No Tax", rate: 0, isDefault: true }] as any, { name: null, percent: null });
    assert.equal(set.options.length, 1);
    assert.equal(set.defaultOption?.rate, 0);
    assert.deepEqual(taxFieldsForSave(set.defaultOption, false), { taxRateName: "No Tax", taxRatePercent: 0 });
});

test("MALFORMED: blank and non-string names are dropped rather than making blank picker rows", () => {
    const set = buildTaxOptions(
        [{ name: "", rate: 5 }, { name: "   ", rate: 6 }, { name: 7, rate: 7 }, { name: null, rate: 8 }, { name: " Sales Tax ", rate: 8.8 }] as any,
        { name: null, percent: null },
    );
    assert.deepEqual(set.options.map(o => o.label), ["Sales Tax"], "and the surviving name is trimmed");
    assert.equal(set.options[0].key, companyTaxKey(0), "keys stay dense after the drops");
});

test("MALFORMED: a numeric-string rate from settings is honoured, not dropped", () => {
    const set = buildTaxOptions([{ name: "Sales Tax", rate: "8.8", isDefault: true }] as any, { name: null, percent: null });
    assert.equal(set.defaultOption?.rate, 8.8);
    assert.equal(typeof set.defaultOption?.rate, "number");
});

test("MALFORMED: sanitizeCompanySalesTaxes and parseSalesTaxes agree on what a row is", () => {
    // parseSalesTaxes guarantees an array of OBJECTS; sanitize adds the per-row rules.
    assert.deepEqual(parseSalesTaxes('[null, 5, "x", {"name":"A","rate":7}]'), [{ name: "A", rate: 7 }]);
    for (const bad of ["null", "{}", "not json", "", null, undefined]) {
        assert.deepEqual(parseSalesTaxes(bad as any), [], `expected none for ${JSON.stringify(bad)}`);
        assert.deepEqual(sanitizeCompanySalesTaxes(parseSalesTaxes(bad as any)), []);
    }
    assert.deepEqual(
        sanitizeCompanySalesTaxes(parseSalesTaxes('[{"name":"A","rate":7,"isDefault":"yes"},{"name":"B"}]')),
        [{ id: undefined, name: "A", rate: 7, isDefault: false }],
        "a truthy-but-not-true isDefault is not a default, and a rateless row is not a row",
    );
});

// ─── Behaviour carried forward from round 1 ──────────────────────────────────────────────────

test("a matched company rate resolves to that exact row and stays on the company option", () => {
    const salesTaxes: CompanySalesTax[] = [
        { name: "WA Sales Tax", rate: 8.8, isDefault: true },
        { name: "Clark County", rate: 7.7 },
    ];
    const { set, key, activeTax, written, totalAmount } = openAndSave(salesTaxes, {
        name: "Clark County",
        percent: 7.7,
    });

    // No synthetic option: settings already carry this exact name+rate pair.
    assert.equal(set.savedOption, null);
    assert.equal(set.options.length, 2);
    assert.equal(key, keyOf(set, "Clark County", 7.7));
    assert.equal(activeTax?.orphaned, false);
    assert.deepEqual(written, { taxRateName: "Clark County", taxRatePercent: 7.7 });
    assert.equal(totalAmount, 10_770);
});

test("switching to a company rate re-quotes deliberately, which is the whole point of the picker", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const set = buildTaxOptions(salesTaxes, { name: "Old City Tax", percent: 7.5 });
    const { written, totalAmount } = openAndSave(
        salesTaxes,
        { name: "Old City Tax", percent: 7.5 },
        { selectKey: keyOf(set, "WA Sales Tax", 8.8) },
    );
    assert.deepEqual(written, { taxRateName: "WA Sales Tax", taxRatePercent: 8.8 });
    assert.equal(totalAmount, 10_880);
});

test("the exempt path clears both columns regardless of the resolved option", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { activeTax, written, totalAmount } = openAndSave(
        salesTaxes,
        { name: "Old City Tax", percent: 7.5 },
        { taxExempt: true },
    );

    // The option still resolves — exemption is applied at write time, not by unresolving it.
    assert.equal(activeTax?.rate, 7.5);
    assert.deepEqual(written, { taxRateName: null, taxRatePercent: null });
    assert.equal(totalAmount, 10_000, "an exempt sale is billed at the subtotal");
});

test("un-exempting an exempt estimate falls back to the company default, not a stale rate", () => {
    // What an exempt save left behind is a null/null pair, so the next open has nothing to
    // preserve and legitimately lands on the default.
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { set, key, written } = openAndSave(salesTaxes, { name: null, percent: null });
    assert.equal(key, keyOf(set, "WA Sales Tax", 8.8));
    assert.deepEqual(written, { taxRateName: "WA Sales Tax", taxRatePercent: 8.8 });
});

test("a saved rate with a null name is preserved verbatim, not synthesized", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { set, activeTax, written, totalAmount } = openAndSave(salesTaxes, { name: null, percent: 9.4 });

    assert.notEqual(set.savedOption, null);
    assert.equal(set.savedOption!.name, null);
    assert.equal(set.savedOption!.label, "Saved rate", "the picker needs text; the column does not");
    assert.equal(activeTax?.rate, 9.4);
    // The name column must stay null — opening the editor cannot invent a name.
    assert.deepEqual(written, { taxRateName: null, taxRatePercent: 9.4 });
    assert.equal(totalAmount, 10_940);
});

test("a renamed/removed company tax still resolves to the stored rate", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const { set, activeTax, totalAmount } = openAndSave(salesTaxes, { name: "Old City Tax", percent: 7.5 });

    assert.notEqual(set.savedOption, null);
    assert.equal(activeTax?.rate, 7.5);
    assert.equal(set.savedOption!.orphaned, true, "the picker flags it as not in settings");
    assert.equal(totalAmount, 10_750);
});

test("a stored rate of 0 is an answer, not an absence", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Default", rate: 8.8, isDefault: true }];
    const { activeTax, written, totalAmount } = openAndSave(salesTaxes, { name: "Zero", percent: 0 });

    assert.equal(activeTax?.rate, 0, "must not fall through to the 8.8% default");
    assert.deepEqual(written, { taxRateName: "Zero", taxRatePercent: 0 });
    assert.equal(totalAmount, 10_000, "8.8% would have billed $10,880");
});

test("a null percent means unset, falling back to the default option", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Default", rate: 8.8, isDefault: true }];
    const { set, activeTax } = openAndSave(salesTaxes, { name: null, percent: null });

    assert.equal(set.savedOption, null);
    assert.equal(set.initialKey, keyOf(set, "Default", 8.8));
    assert.equal(activeTax?.rate, 8.8);
});

test("a non-finite/garbage percent is ignored, falling back to the default option", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Default", rate: 8.8, isDefault: true }];
    for (const percent of ["abc", "", "  ", NaN, Infinity] as any[]) {
        const { set, activeTax, totalAmount } = openAndSave(salesTaxes, { name: "X", percent });
        assert.equal(set.savedOption, null, `expected no synthetic option for ${JSON.stringify(percent)}`);
        assertInitialKeyIsSelectable(set, `percent ${JSON.stringify(percent)}`);
        assert.equal(activeTax?.rate, 8.8);
        assert.equal(totalAmount, 10_880);
    }
});

test("a string percent (Prisma Decimal serializes to string) is handled numerically", () => {
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const { activeTax, written, totalAmount } = openAndSave(salesTaxes, { name: "Sales Tax", percent: "9.15" });

    assert.equal(activeTax?.rate, 9.15);
    assert.equal(typeof activeTax?.rate, "number");
    assert.equal(typeof written.taxRatePercent, "number", "the column takes a number, not '9.15'");
    assert.equal(totalAmount, 10_915);
});

test("a string percent equal to a company rate is treated as covered, not orphaned", () => {
    // "8.8" == 8.8 numerically; a string/number mismatch must not fabricate a duplicate option.
    const salesTaxes: CompanySalesTax[] = [{ name: "Sales Tax", rate: 8.8, isDefault: true }];
    const { set } = openAndSave(salesTaxes, { name: "Sales Tax", percent: "8.8" });

    assert.equal(set.savedOption, null);
    assert.equal(set.options.length, 1);
});

test("empty salesTaxes with a saved rate: the saved rate is the only option", () => {
    const { set, activeTax, written, totalAmount } = openAndSave([], { name: "Sales Tax", percent: 9.15 });

    assert.equal(set.options.length, 1);
    assert.equal(set.defaultOption, null);
    assert.equal(activeTax?.rate, 9.15);
    assert.deepEqual(written, { taxRateName: "Sales Tax", taxRatePercent: 9.15 });
    assert.equal(totalAmount, 10_915);
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
    assert.equal(defaultOption?.key, companyTaxKey(1));
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
