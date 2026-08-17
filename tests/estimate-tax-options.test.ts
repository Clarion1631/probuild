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
    LEGACY_FALLBACK_TAX_RATE,
    SAVED_TAX_KEY,
    UNRATED_TAX_KEY,
    buildTaxOptions,
    companyTaxKey,
    deriveEffectiveTaxRate,
    isRepresentableTaxRate,
    reconcileTaxKey,
    resolveActiveTax,
    sanitizeCompanySalesTaxes,
    taxFieldsForSave,
    taxFractionFor,
    type CompanySalesTax,
    type StoredSellMoney,
    type TaxOption,
    type TaxOptionSet,
} from "../src/lib/estimate-tax-options";
import { parseSalesTaxes } from "../src/lib/sales-tax";

/** Every test prices the same job, so a re-rating shows up as a different dollar total. */
const SUBTOTAL = 10_000;

/** The editor's own money math (`computeSellTotals` in EstimateEditor.tsx), to the cent. */
const rm = (n: number) => Math.round(n * 100) / 100;
function sellTotals(subtotal: number, activeTax: TaxOption | null, taxExempt: boolean, processingFeeMarkup = 0) {
    const taxRate = taxFractionFor(activeTax, taxExempt);
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
    opts: {
        taxExempt?: boolean;
        selectKey?: string | null;
        subtotal?: number;
        processingFeeMarkup?: number;
        /**
         * The `totalAmount` already on the row. Supplying it turns on rate DERIVATION, which is
         * the whole point of the round-3 ruling: without a stored total there is nothing to
         * preserve and the editor legitimately adopts the company default.
         */
        storedTotal?: number | string | null;
    } = {},
) {
    const subtotal = opts.subtotal ?? SUBTOTAL;
    const processingFeeMarkup = opts.processingFeeMarkup ?? 0;
    const storedMoney: StoredSellMoney | undefined =
        "storedTotal" in opts
            ? { subtotal, totalAmount: opts.storedTotal, processingFeeMarkup, taxExempt: !!opts.taxExempt }
            : undefined;
    const set = buildTaxOptions(salesTaxes, { name: stored.name, percent: stored.percent }, storedMoney);
    const key = "selectKey" in opts ? opts.selectKey! : set.initialKey;
    const activeTax = resolveActiveTax(set.options, key, set.defaultOption);
    const taxExempt = !!opts.taxExempt;
    const written = taxFieldsForSave(activeTax, taxExempt);
    const money = sellTotals(subtotal, activeTax, taxExempt, processingFeeMarkup);
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

test("ROUND-2 FINDING 1: a null key is repaired, because null never meant exempt", () => {
    // Exemption lives in `taxExempt`, a separate column and a separate piece of editor state; the
    // picker's EXEMPT_TAX_KEY is a <select> value that is never stored in `selectedTaxKey`. The
    // old code short-circuited `key === null` as "exempt", so a NON-exempt estimate that opened
    // against empty settings kept a null key forever once settings were populated — the <select>
    // rendered the first row while resolveActiveTax quietly used defaultOption.
    const empty = buildTaxOptions([], { name: null, percent: null });
    assert.equal(empty.initialKey, null, "nothing configured, so nothing to select");

    const populated = buildTaxOptions(
        [{ name: "Clark County", rate: 7.7 }, { name: "WA Sales Tax", rate: 8.8, isDefault: true }],
        { name: null, percent: null },
    );
    const repaired = reconcileTaxKey(null, empty.options, populated);

    assert.equal(repaired, populated.initialKey);
    assert.equal(repaired, keyOf(populated, "WA Sales Tax", 8.8), "the DEFAULT row, not the first one");
    // The bug in one assertion: the rendered <select> and the priced rate must agree.
    const rendered = populated.options[0];
    const resolved = resolveActiveTax(populated.options, repaired, populated.defaultOption);
    assert.equal(resolved!.key, repaired);
    assert.notEqual(rendered.key, populated.initialKey, "first row != default row, so a null key WOULD have diverged");
});

test("ROUND-2 FINDING 1: exemption survives a rebuild via taxExempt, not via the key", () => {
    // An exempt estimate keeps whatever key it was on. Both columns still clear on save, and
    // un-exempting returns the user to that rate rather than to the company default.
    const first = buildTaxOptions([{ name: "Sales Tax", rate: 8.8, isDefault: true }], { name: "Sales Tax", percent: 8.8 });
    const second = buildTaxOptions([{ name: "Other", rate: 5 }, { name: "Sales Tax", rate: 8.8 }], { name: "Sales Tax", percent: 8.8 });

    const carried = reconcileTaxKey(first.initialKey, first.options, second);
    assert.equal(carried, keyOf(second, "Sales Tax", 8.8), "identity re-matched by (name, rate) across the reorder");

    const active = resolveActiveTax(second.options, carried, second.defaultOption);
    assert.deepEqual(taxFieldsForSave(active, true), { taxRateName: null, taxRatePercent: null }, "still exempt");
    assert.deepEqual(taxFieldsForSave(active, false), { taxRateName: "Sales Tax", taxRatePercent: 8.8 }, "un-exempt restores it");
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

// ─── THE RULING (round 3): a rateless estimate keeps the tax it already effectively has ──────
//
// The round-2 BLOCKER: rateless estimates were re-rated to the company default, which need not
// equal the legacy 8.8% the editor had already baked into `totalAmount`. The round-2 tests hid it
// by comparing default-to-default. Every test below therefore asserts against STORED money — a
// literal dollar figure a save produced with the legacy fallback — and every company default here
// is deliberately NOT 8.8.

/** A company whose default (9.15%) differs from the legacy fallback. Re-rating shows up as money. */
const NON_88_SETTINGS: CompanySalesTax[] = [
    { name: "WA Sales Tax", rate: 9.15, isDefault: true },
    { name: "Clark County", rate: 7.7 },
];

/** What the editor stored when it last saved a rateless estimate at the legacy 8.8%. */
function legacyStoredTotal(subtotal: number, processingFeeMarkup = 0) {
    return sellTotals(subtotal, null, false, processingFeeMarkup).totalAmount;
}

test("THE RULING: the review's worked example — $11,080 stays $11,080, not $11,115", () => {
    // $10,000 subtotal + 2% processing fee, saved at the legacy 8.8%.
    const stored = legacyStoredTotal(10_000, 2);
    assert.equal(stored, 11_080, "the legacy fallback's own arithmetic, stated as a number");
    // What re-rating to the company default would have produced, so the assertion below is not
    // vacuously true.
    assert.equal(sellTotals(10_000, { rate: 9.15 } as TaxOption, false, 2).totalAmount, 11_115);

    const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal: 10_000, processingFeeMarkup: 2, storedTotal: stored,
    });

    assert.equal(opened.totalAmount, 11_080, "the client's total must not move");
    assert.equal(opened.key, SAVED_TAX_KEY, "on the estimate's own derived rate, not a settings row");
    assert.deepEqual(opened.written, { taxRateName: null, taxRatePercent: 8.8 },
        "the derived rate is written, so the columns finally agree with the total");
});

test("THE RULING: the derived total holds to the cent across THREE save cycles", () => {
    // Three cycles, because the first save is what changes `taxRatePercent` from null to 8.8 —
    // cycles two and three prove the new value is a fixed point rather than a one-step drift.
    const subtotal = 10_000;
    const feeMarkup = 2;
    let stored: { name: string | null; percent: number | string | null } = { name: null, percent: null };
    let total = legacyStoredTotal(subtotal, feeMarkup);

    for (const cycle of [1, 2, 3]) {
        const run = openAndSave(NON_88_SETTINGS, stored, {
            subtotal, processingFeeMarkup: feeMarkup, storedTotal: total,
        });
        assert.equal(run.totalAmount, 11_080, `cycle ${cycle}: the total moved`);
        stored = reopen(run.written);
        total = run.totalAmount;
    }
    assert.deepEqual(stored, { name: null, percent: 8.8 }, "and it settled on the rate it always had");
});

test("THE RULING: an awkward subtotal still round-trips to the cent", () => {
    // 8.8% of $7,432.19 is $654.03 (rounded), so the derived rate is not exactly 8.8 — this is
    // where a naive (total - subtotal) / subtotal would drift a cent on the way back.
    const subtotal = 7_432.19;
    const stored = legacyStoredTotal(subtotal, 3);
    const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal, processingFeeMarkup: 3, storedTotal: stored,
    });

    assert.equal(opened.totalAmount, stored, "to the cent");
    assert.notEqual(opened.written.taxRatePercent, 9.15, "and not the company default");
    // Re-saving what cycle one wrote reproduces the same money from the STORED rate.
    const again = openAndSave(NON_88_SETTINGS, reopen(opened.written), {
        subtotal, processingFeeMarkup: 3, storedTotal: opened.totalAmount,
    });
    assert.equal(again.totalAmount, stored);
});

test("THE RULING: a stored NAME with no rate keeps its name and gains its own rate", () => {
    // Before the ruling this landed on the same-named company row (nameOnlyMatch) and re-rated
    // 8.8 -> 9.15. The name is preserved either way; the money is what changed.
    const subtotal = 10_000;
    const stored = legacyStoredTotal(subtotal);
    const opened = openAndSave(NON_88_SETTINGS, { name: "WA Sales Tax", percent: null }, {
        subtotal, storedTotal: stored,
    });

    assert.equal(opened.totalAmount, 10_880);
    assert.deepEqual(opened.written, { taxRateName: "WA Sales Tax", taxRatePercent: 8.8 });
    assert.equal(opened.set.savedOption?.orphaned, true, "the picker flags it as not a settings row");
});

test("THE RULING: a derived rate settings DO carry lands on the company row, not a synthetic one", () => {
    // The company's default happens to be 8.8 under the name the estimate stored, so the derived
    // rate IS that row. No synthetic option: the picker stays a plain list of settings.
    const settings: CompanySalesTax[] = [{ name: "WA Sales Tax", rate: 8.8, isDefault: true }];
    const opened = openAndSave(settings, { name: "WA Sales Tax", percent: null }, {
        subtotal: 10_000, storedTotal: legacyStoredTotal(10_000),
    });

    assert.equal(opened.set.savedOption, null);
    assert.equal(opened.key, keyOf(opened.set, "WA Sales Tax", 8.8));
    assert.equal(opened.totalAmount, 10_880);
});

test("THE RULING: a derived rate never invents a taxRateName", () => {
    // 8.8 is on file under "Clark County" here. Matching the derived RATE alone would select it
    // and write that name onto an estimate that never carried it.
    const settings: CompanySalesTax[] = [
        { name: "WA Sales Tax", rate: 9.15, isDefault: true },
        { name: "Clark County", rate: 8.8 },
    ];
    const opened = openAndSave(settings, { name: null, percent: null }, {
        subtotal: 10_000, storedTotal: legacyStoredTotal(10_000),
    });

    assert.equal(opened.key, SAVED_TAX_KEY);
    assert.deepEqual(opened.written, { taxRateName: null, taxRatePercent: 8.8 });
    assert.equal(opened.totalAmount, 10_880);
});

test("THE RULING: a derived rate never RENAMES an estimate that already has a name", () => {
    // The null-name case above cannot reach the name-matching branch at all (it is guarded on
    // `savedName === null`), so it does not actually prove the pair-match. This one does: the
    // estimate stores "Legacy Tax", the derived rate is 8.8, and settings carry 8.8 under a
    // DIFFERENT name. Matching on the rate alone would rewrite `taxRateName` to "Clark County" —
    // a column change on a client-facing document that nobody asked for.
    const settings: CompanySalesTax[] = [
        { name: "WA Sales Tax", rate: 9.15, isDefault: true },
        { name: "Clark County", rate: 8.8 },
    ];
    const opened = openAndSave(settings, { name: "Legacy Tax", percent: null }, {
        subtotal: 10_000, storedTotal: legacyStoredTotal(10_000),
    });

    assert.equal(opened.key, SAVED_TAX_KEY, "a synthetic option, not the same-rate company row");
    assert.deepEqual(opened.written, { taxRateName: "Legacy Tax", taxRatePercent: 8.8 });
    assert.equal(opened.set.savedOption?.label, "Legacy Tax");
    assert.equal(opened.totalAmount, 10_880);
});

test("THE RULING: an EXEMPT estimate is not given a derived 0% rate", () => {
    // An exempt row stores null/null legitimately and prices at the subtotal, so derivation would
    // "recover" 0% and pin it there — un-exempting would then quote 0% instead of the default.
    const subtotal = 10_000;
    const exempt = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal, storedTotal: subtotal, taxExempt: true,
    });
    assert.deepEqual(exempt.written, { taxRateName: null, taxRatePercent: null });
    assert.equal(exempt.totalAmount, subtotal);

    // Un-exempting is a UI toggle, not a reload: the option set was built from the STORED
    // `taxExempt: true`, so derivation stayed off and the selection is still the company default.
    // Flipping the checkbox therefore quotes 9.15%, not a 0% recovered from an exempt total.
    const set = buildTaxOptions(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal, totalAmount: subtotal, processingFeeMarkup: 0, taxExempt: true,
    });
    const active = resolveActiveTax(set.options, set.initialKey, set.defaultOption);
    assert.equal(set.initialKey, keyOf(set, "WA Sales Tax", 9.15));
    assert.deepEqual(taxFieldsForSave(active, false), { taxRateName: "WA Sales Tax", taxRatePercent: 9.15 });
    assert.equal(sellTotals(subtotal, active, false).totalAmount, 10_915);
});

test("THE RULING: total == subtotal on a NON-exempt estimate derives a real 0%", () => {
    // The mirror image of the test above, and the reason exemption has to be read from the stored
    // row rather than inferred: a non-exempt estimate billed at its bare subtotal is carrying 0%
    // tax, and re-rating it to 9.15% would add $915 the client never agreed to.
    const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal: 10_000, storedTotal: 10_000,
    });
    assert.equal(opened.written.taxRatePercent, 0, "a derived 0 is an answer, not an absence");
    assert.equal(opened.totalAmount, 10_000);
});

// ─── The degenerate branch: columns and money left untouched ─────────────────────────────────

test("DEGENERATE: an underivable total leaves BOTH tax columns and the money untouched", () => {
    // A $10,000 job stored at $9,000 cannot be explained by any rate in 0..100 (it implies -12%).
    // Writing a rate here would rewrite the client's total; the only safe move is to change
    // nothing at all and keep pricing at the legacy fallback.
    const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal: 10_000, storedTotal: 9_000,
    });

    assert.equal(opened.key, UNRATED_TAX_KEY);
    assert.equal(opened.activeTax?.rate, null, "no rate is claimed");
    assert.deepEqual(opened.written, { taxRateName: null, taxRatePercent: null }, "columns untouched");
    assert.equal(opened.totalAmount, 10_880, "priced at the legacy fallback, exactly as before");
    assertInitialKeyIsSelectable(opened.set, "underivable");
});

test("DEGENERATE: the unrated option preserves a stored NAME while still writing no rate", () => {
    const opened = openAndSave(NON_88_SETTINGS, { name: "Old City Tax", percent: null }, {
        subtotal: 10_000, storedTotal: 9_000,
    });
    assert.equal(opened.key, UNRATED_TAX_KEY);
    assert.deepEqual(opened.written, { taxRateName: "Old City Tax", taxRatePercent: null });
    assert.equal(opened.set.options.at(-1)!.label, "Old City Tax");
});

test("DEGENERATE: a missing/garbage stored total is underivable, not a licence to re-rate", () => {
    for (const total of [null, undefined, "", "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
        const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
            subtotal: 10_000, storedTotal: total as any,
        });
        assert.equal(opened.key, UNRATED_TAX_KEY, `total=${String(total)}`);
        assert.deepEqual(opened.written, { taxRateName: null, taxRatePercent: null }, `total=${String(total)}`);
        assert.equal(opened.totalAmount, 10_880, `total=${String(total)}`);
    }
});

test("DEGENERATE: a total implying MORE than 100% tax is refused", () => {
    const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
        subtotal: 10_000, storedTotal: 30_000,
    });
    assert.equal(opened.key, UNRATED_TAX_KEY);
    assert.equal(opened.written.taxRatePercent, null);
});

test("DEGENERATE: no subtotal means no money at risk, so the default applies as it always has", () => {
    // A brand-new estimate has no items. No rate can move its total off zero, so there is nothing
    // to preserve and nothing to refuse — pinning it to the legacy fallback here would regress
    // every new estimate away from the company's configured default.
    for (const subtotal of [0, -50]) {
        const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, {
            subtotal, storedTotal: 0,
        });
        assert.equal(opened.key, keyOf(opened.set, "WA Sales Tax", 9.15), `subtotal=${subtotal}`);
        assert.deepEqual(opened.written, { taxRateName: "WA Sales Tax", taxRatePercent: 9.15 });
    }
});

test("DEGENERATE: with no company settings at all, an underivable estimate still changes nothing", () => {
    const opened = openAndSave([], { name: "Old City Tax", percent: null }, {
        subtotal: 10_000, storedTotal: 9_000,
    });
    assert.equal(opened.key, UNRATED_TAX_KEY, "the unrated option is the ONLY option");
    assert.equal(opened.set.options.length, 1);
    assert.deepEqual(opened.written, { taxRateName: "Old City Tax", taxRatePercent: null });
    assert.equal(opened.totalAmount, 10_880);
});

test("deriveEffectiveTaxRate returns only rates that reproduce the stored total to the cent", () => {
    const cases: { money: StoredSellMoney; expect: number | null }[] = [
        { money: { subtotal: 10_000, totalAmount: 11_080, processingFeeMarkup: 2 }, expect: 8.8 },
        { money: { subtotal: 10_000, totalAmount: 10_880, processingFeeMarkup: 0 }, expect: 8.8 },
        { money: { subtotal: 10_000, totalAmount: 10_000, processingFeeMarkup: 0 }, expect: 0 },
        { money: { subtotal: 10_000, totalAmount: "10880", processingFeeMarkup: "0" }, expect: 8.8 },
        { money: { subtotal: 10_000, totalAmount: 9_000, processingFeeMarkup: 0 }, expect: null },
        { money: { subtotal: 0, totalAmount: 0, processingFeeMarkup: 0 }, expect: null },
        { money: { subtotal: 10_000, totalAmount: null, processingFeeMarkup: 0 }, expect: null },
        { money: { subtotal: 10_000, totalAmount: 10_880, processingFeeMarkup: 0, taxExempt: true }, expect: null },
    ];
    for (const { money, expect } of cases) {
        assert.equal(deriveEffectiveTaxRate(money), expect, JSON.stringify(money));
    }
    assert.equal(deriveEffectiveTaxRate(null), null);
    assert.equal(deriveEffectiveTaxRate(undefined), null);

    // The property the whole rule rests on: whatever comes back re-prices the job to the stored
    // total exactly. Swept across subtotals and fee markups that all land on awkward cents.
    for (const subtotal of [123.45, 999.99, 7_432.19, 10_000, 88_888.88]) {
        for (const markup of [0, 2, 3.25]) {
            const total = legacyStoredTotal(subtotal, markup);
            const derived = deriveEffectiveTaxRate({ subtotal, totalAmount: total, processingFeeMarkup: markup });
            assert.notEqual(derived, null, `no rate derived for ${subtotal} @ ${markup}%`);
            const repriced = sellTotals(subtotal, { rate: derived } as TaxOption, false, markup).totalAmount;
            assert.equal(repriced, total, `${subtotal} @ ${markup}% repriced to ${repriced}, stored ${total}`);
        }
    }
});

test("THE RULING: a 4-dp rate is preferred, but only when it still reproduces the total", () => {
    // The picker displays rates to 4 decimals, so a tidy 4-dp value is what we want to write. On a
    // big enough job that rounding costs cents: $100,000 carrying $97.13 of tax implies
    // 0.09713%, and the 4-dp 0.0971% reprices it to $100,097.10 — three cents light. The
    // reproduction gate catches that and keeps full precision instead.
    const subtotal = 100_000;
    const storedTotal = 100_097.13;
    assert.equal(sellTotals(subtotal, { rate: 0.0971 } as TaxOption, false).totalAmount, 100_097.10,
        "the 4-dp rate really does miss, so this test is not vacuous");

    const derived = deriveEffectiveTaxRate({ subtotal, totalAmount: storedTotal, processingFeeMarkup: 0 });
    assert.notEqual(derived, null);
    assert.notEqual(derived, 0.0971, "the lossy 4-dp value was rejected");
    assert.equal(sellTotals(subtotal, { rate: derived } as TaxOption, false).totalAmount, storedTotal);

    const opened = openAndSave(NON_88_SETTINGS, { name: null, percent: null }, { subtotal, storedTotal });
    assert.equal(opened.totalAmount, storedTotal, "to the cent");
});

// ─── Rate range at the sanitizer (round-2 real issue 2) ──────────────────────────────────────

test("RANGE: sanitizeCompanySalesTaxes drops rates outside 0..100", () => {
    // /settings/sales-taxes puts min="0" max="100" on the input, but handleAdd reads
    // parseFloat(newRate) and never calls checkValidity(), so those attributes gate nothing.
    const rows = sanitizeCompanySalesTaxes([
        { name: "Negative", rate: -5 },
        { name: "Tiny negative", rate: -0.01 },
        { name: "Over", rate: 101 },
        { name: "Absurd", rate: 8800 },
        { name: "String negative", rate: "-5" },
        { name: "Zero", rate: 0 },
        { name: "Hundred", rate: 100 },
        { name: "Normal", rate: 8.8 },
    ]);
    assert.deepEqual(rows.map(r => r.name), ["Zero", "Hundred", "Normal"], "only the representable ones survive");
});

test("RANGE: a negative default rate cannot become the option the editor prices with", () => {
    // The end-to-end consequence: a -5% row would bill the client a discount on every estimate.
    const set = buildTaxOptions([{ name: "Oops", rate: -5, isDefault: true }, { name: "Real", rate: 8.8 }], {
        name: null, percent: null,
    });
    assert.equal(set.options.length, 1);
    assert.equal(set.defaultOption?.name, "Real");
    assert.equal(sellTotals(SUBTOTAL, set.defaultOption, false).totalAmount, 10_880);
});

test("RANGE: isRepresentableTaxRate is the single boundary definition", () => {
    for (const ok of [0, 0.001, 8.8, 99.9999, 100]) assert.equal(isRepresentableTaxRate(ok), true, String(ok));
    for (const bad of [-0.0001, -5, 100.0001, 101, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.equal(isRepresentableTaxRate(bad), false, String(bad));
    }
});

test("RANGE: a derived rate is held to the same 0..100 bound as a configured one", () => {
    // A stored total below the subtotal implies a negative rate; above subtotal+100% implies an
    // absurd one. Neither may be written, by the same rule that drops such a settings row.
    assert.equal(deriveEffectiveTaxRate({ subtotal: 100, totalAmount: 99, processingFeeMarkup: 0 }), null);
    assert.equal(deriveEffectiveTaxRate({ subtotal: 100, totalAmount: 201, processingFeeMarkup: 0 }), null);
    assert.equal(deriveEffectiveTaxRate({ subtotal: 100, totalAmount: 200, processingFeeMarkup: 0 }), 100);
});

test("taxFractionFor: null rate prices at the legacy fallback, 0 prices at zero", () => {
    assert.equal(taxFractionFor({ rate: null } as TaxOption, false), LEGACY_FALLBACK_TAX_RATE / 100);
    assert.equal(taxFractionFor(null, false), LEGACY_FALLBACK_TAX_RATE / 100);
    assert.equal(taxFractionFor({ rate: 0 } as TaxOption, false), 0, "a real 0% must not fall through");
    assert.equal(taxFractionFor({ rate: 8.8 } as TaxOption, true), 0, "exempt beats everything");
});
