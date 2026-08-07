/**
 * Margin/cost coherence for the estimate budget strip.
 *
 * The invariant under test: the margin persisted to `markupPercent` and the budget rate stored
 * beside it always describe the SAME margin. The original defect clamped the value that fed
 * `costFromMargin` at 99 but persisted the raw input, so entering 100 stored a 100% margin next
 * to a cost derived from 99% — and since costFromMargin/sellFromMargin both return 0 at >= 100,
 * a stored 100 additionally collapsed downstream sell/cost math to zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clampMarginPct,
    normalizeMarginInput,
    formatDerivedRate,
    costFromMargin,
    derivedMarginPct,
    internalBudget,
    DEFAULT_MARGIN_PCT,
    MIN_MARGIN_PCT,
    MAX_MARGIN_PCT,
} from "../src/lib/budget-math";

test("clampMarginPct holds the representable range", () => {
    assert.equal(clampMarginPct(25), 25);
    assert.equal(clampMarginPct(0), 0);
    assert.equal(clampMarginPct(MAX_MARGIN_PCT), MAX_MARGIN_PCT);
    assert.equal(clampMarginPct(100), MAX_MARGIN_PCT);
    assert.equal(clampMarginPct(1e9), MAX_MARGIN_PCT);
    assert.equal(clampMarginPct(-10), MIN_MARGIN_PCT);
    // Infinity is out of range at the TOP — it must not fall through to the floor.
    assert.equal(clampMarginPct(Infinity), MAX_MARGIN_PCT);
    assert.equal(clampMarginPct(-Infinity), MIN_MARGIN_PCT);
    assert.equal(clampMarginPct(NaN), MIN_MARGIN_PCT);
});

test("normalizeMarginInput persists exactly the margin the rate is derived from", () => {
    // The regression: 100 must not store 100 while the cost comes from 99.
    const hundred = normalizeMarginInput("100");
    assert.equal(hundred.stored, String(MAX_MARGIN_PCT));
    assert.equal(hundred.derivedFrom, MAX_MARGIN_PCT);

    const negative = normalizeMarginInput("-10");
    assert.equal(negative.stored, String(MIN_MARGIN_PCT));
    assert.equal(negative.derivedFrom, MIN_MARGIN_PCT);

    // An entry that overflows to Infinity is still a real number: it must clamp to the ceiling,
    // not get stored as typed and not fall through to the floor.
    const huge = normalizeMarginInput("1e309");
    assert.equal(huge.stored, String(MAX_MARGIN_PCT));
    assert.equal(huge.derivedFrom, MAX_MARGIN_PCT);
});

test("normalizeMarginInput keeps in-range text verbatim so typing survives", () => {
    for (const raw of ["0", "25", "25.", "25.0", "99", "7.5"]) {
        const { stored, derivedFrom } = normalizeMarginInput(raw);
        assert.equal(stored, raw, `expected ${raw} to be stored verbatim`);
        assert.equal(derivedFrom, parseFloat(raw));
    }
});

test("whatever is stored always re-parses to the margin the rate came from", () => {
    // The core invariant, independent of how the text is spelled.
    for (const raw of ["0", "25", "25.", "99", "100", "-10", "1e309", "1e", ""]) {
        const { stored, derivedFrom } = normalizeMarginInput(raw);
        if (stored === null) continue;
        assert.equal(parseFloat(stored), derivedFrom, `stored/derived disagree for ${raw}`);
    }
});

test("normalizeMarginInput clears on empty but still derives from the displayed default", () => {
    const { stored, derivedFrom } = normalizeMarginInput("");
    assert.equal(stored, null);
    // The input renders `markupPercent ?? DEFAULT_MARGIN_PCT`, so a rate derived while the field
    // is empty has to come from that same default or the visible margin would be a lie.
    assert.equal(derivedFrom, DEFAULT_MARGIN_PCT);
});

test("normalizeMarginInput treats an unfinished keystroke as cleared, not as a margin", () => {
    // Storing the fragment would be worse than dropping it: saveEstimate turns an unparseable
    // markupPercent into the default, leaving a stored margin that contradicts the stored cost.
    // Note "1e" is NOT here: parseFloat("1e") is 1, so it is a usable margin, not a fragment.
    for (const raw of ["-", ".", "e5", "abc"]) {
        const { stored, derivedFrom } = normalizeMarginInput(raw);
        assert.equal(stored, null, `expected ${raw} to clear the stored margin`);
        assert.equal(derivedFrom, DEFAULT_MARGIN_PCT, `expected ${raw} to fall back to the default`);
    }
});

test("stored margin round-trips back from the stored cost at every price scale", () => {
    // Rounding to cents is not scale-free: a half cent is 0.5/price percent of margin, so a
    // cent-rounded rate silently misstates the margin at small unit prices.
    for (const price of [1500, 100, 12.5, 1, 0.49, 0.01]) {
        for (const raw of ["0", "10", "25", "60", "99", "100", "-10"]) {
            const { stored, derivedFrom } = normalizeMarginInput(raw);
            const rate = parseFloat(formatDerivedRate(costFromMargin(price, derivedFrom), price));
            // What the sibling budget-rate input would show for that cost must be what we stored.
            assert.equal(
                Math.round(derivedMarginPct(rate, price) * 100) / 100,
                Math.round(parseFloat(stored!) * 100) / 100,
                `margin/cost disagree for input ${raw} at price ${price}`,
            );
        }
    }
});

test("a 100% entry no longer collapses the derived cost to zero", () => {
    const price = 250;
    const { derivedFrom } = normalizeMarginInput("100");
    const cost = costFromMargin(price, derivedFrom);
    assert.ok(cost > 0, "cost must stay positive — costFromMargin returns 0 at margin >= 100");
    assert.equal(formatDerivedRate(cost, price), "2.50");
});

test("formatDerivedRate never rounds a real cost down to a zero budget", () => {
    assert.equal(formatDerivedRate(75, 100), "75.00");
    assert.equal(formatDerivedRate(0.5, 1), "0.5000");
    assert.equal(formatDerivedRate(0, 100), "0.00");

    // Price 0.49 at 99% margin is $0.0049/unit. Two decimals would store "0.00", which
    // internalBudget reads as "no budget at all" while markupPercent still claims 99.
    const tiny = costFromMargin(0.49, MAX_MARGIN_PCT);
    const stored = formatDerivedRate(tiny, 0.49);
    assert.ok(parseFloat(stored) > 0, `expected a non-zero rate, got ${stored}`);
    assert.notEqual(internalBudget({ quantity: 1, budgetRate: stored }), null);
});
