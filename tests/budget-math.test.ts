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
    derivedRateDecimals,
    internalBudget,
    DEFAULT_MARGIN_PCT,
    MIN_MARGIN_PCT,
    MAX_MARGIN_PCT,
    rawMarginPct,
    marginIsUnrepresentable,
    marginIsStale,
    marginPatchForRate,
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

/**
 * INVARIANT: rawMarginPct is the UNCLAMPED margin a rate/price pair implies — it is what
 * derivedMarginPct feeds into clampMarginPct. The two diverge exactly when the pair falls
 * outside [MIN_MARGIN_PCT, MAX_MARGIN_PCT], and that divergence is the whole detection
 * mechanism marginIsUnrepresentable relies on: a clamped, storable markupPercent can sit next
 * to a rate that does not actually produce it (PR #323's original defect — rate 150 at price
 * 100 stores a 0% margin, which implies cost === price, not a cost 50% higher than price).
 */
test("rawMarginPct returns the unclamped margin where derivedMarginPct clamps", () => {
    assert.equal(rawMarginPct(150, 100), -50);
    assert.equal(derivedMarginPct(150, 100), 0);

    assert.equal(rawMarginPct(0.5, 100), 99.5);
    assert.equal(derivedMarginPct(0.5, 100), 99);
});

/**
 * INVARIANT: rawMarginPct is null whenever there is no real margin to report — a non-finite
 * rate or price, or a sell price of zero/negative (no sell to earn a margin on).
 */
test("rawMarginPct is null for non-finite inputs and non-positive price", () => {
    assert.equal(rawMarginPct(Infinity, 100), null);
    assert.equal(rawMarginPct(-Infinity, 100), null);
    assert.equal(rawMarginPct(NaN, 100), null);
    assert.equal(rawMarginPct(100, Infinity), null);
    assert.equal(rawMarginPct(100, NaN), null);
    assert.equal(rawMarginPct(50, 0), null);
    assert.equal(rawMarginPct(50, -10), null);
});

/**
 * REGRESSION (mirror of PR #323's margin defect): entering a budget rate ABOVE the sell price
 * used to silently store a 0% margin — clampMarginPct(-50) === 0 — which claims cost === price
 * when the line actually loses money. marginIsUnrepresentable is the flag that catches this: the
 * stored "0.00" is still what gets persisted (rates are never silently rewritten), but callers
 * now have a way to know the persisted margin is a lie instead of trusting it silently.
 */
test("a rate above the sell price stores a lying 0% margin and is flagged unrepresentable", () => {
    const patch = marginPatchForRate(150, 100);
    assert.equal(patch.markupPercent, "0.00");
    assert.equal(marginIsUnrepresentable(150, 100), true);
});

/**
 * REGRESSION (the other direction of the same defect): a rate far below the sell price clamps to
 * a 99% margin — clampMarginPct(99.5) === 99 — which implies a cost of $1.00 on a $100 sell price
 * when the real rate was $0.50. Flagged the same way as the >100 case, and for the same reason:
 * a clamped, storable value must not be trusted as a faithful description of the input rate.
 */
test("a rate far below the sell price stores an inflated margin and is flagged unrepresentable", () => {
    const patch = marginPatchForRate(0.5, 100);
    assert.equal(patch.markupPercent, "99.00");
    assert.equal(marginIsUnrepresentable(0.5, 100), true);
});

/**
 * INVARIANT: the honest middle of the range round-trips cleanly and is never flagged, including
 * both boundaries — rate === price (0% margin) and rate === price / 100 (99% margin) are REAL,
 * storable margins. These must not false-positive as unrepresentable; only values that clamp are
 * unrepresentable.
 */
test("in-range rates (including both boundaries) are honest and never flagged", () => {
    let patch = marginPatchForRate(75, 100);
    assert.equal(patch.markupPercent, "25.00");
    assert.equal(marginIsUnrepresentable(75, 100), false);

    // Boundary: rate === price -> 0% margin, a real value, NOT unrepresentable.
    patch = marginPatchForRate(100, 100);
    assert.equal(patch.markupPercent, "0.00");
    assert.equal(marginIsUnrepresentable(100, 100), false);

    // Boundary: rate === price / 100 -> 99% margin, a real value, NOT unrepresentable.
    patch = marginPatchForRate(1, 100);
    assert.equal(patch.markupPercent, "99.00");
    assert.equal(marginIsUnrepresentable(1, 100), false);
});

/**
 * REGRESSION: a rate of 0 or an unparsed/blank rate (NaN) used to strand a stale margin in
 * place, because the caller's `r > 0 && price > 0` guard skipped the write entirely and left
 * whatever markupPercent was already stored. marginPatchForRate now returns an explicit null
 * patch so the caller always clears the stale value instead of leaving it stranded.
 */
test("a zero or blank rate clears the margin instead of stranding a stale one", () => {
    assert.deepEqual(marginPatchForRate(0, 100), { markupPercent: null });
    assert.deepEqual(marginPatchForRate(NaN, 100), { markupPercent: null });
});

/**
 * INVARIANT: a positive rate with no sell price to measure it against (price <= 0) has no
 * margin to store, and is always flagged unrepresentable — there is nothing for the rate to be
 * a percentage of.
 */
test("a positive rate against a non-positive price clears the margin and is unrepresentable", () => {
    assert.deepEqual(marginPatchForRate(50, 0), { markupPercent: null });
    assert.equal(marginIsUnrepresentable(50, 0), true);
});

/**
 * INVARIANT: non-finite inputs must never throw, and must land on the documented result for all
 * three functions — Infinity/NaN on either side of the pair.
 */
test("non-finite inputs do not throw and land on documented results", () => {
    assert.doesNotThrow(() => {
        rawMarginPct(Infinity, 100);
        rawMarginPct(100, Infinity);
        rawMarginPct(NaN, 100);
        marginIsUnrepresentable(Infinity, 100);
        marginIsUnrepresentable(100, Infinity);
        marginIsUnrepresentable(NaN, 100);
        marginPatchForRate(Infinity, 100);
        marginPatchForRate(100, Infinity);
        marginPatchForRate(NaN, 100);
    });

    // rate non-finite: a bad budget, not "no budget" — still persists to budgetRate while the
    // margin next to it clears to the default, so it must be flagged rather than waved through.
    assert.equal(marginIsUnrepresentable(Infinity, 100), true);
    assert.equal(marginIsUnrepresentable(-Infinity, 100), true);
    assert.equal(marginIsUnrepresentable(NaN, 100), true);
    assert.deepEqual(marginPatchForRate(Infinity, 100), { markupPercent: null });
    assert.deepEqual(marginPatchForRate(NaN, 100), { markupPercent: null });

    // price non-finite with a real rate: "a cost with no sell price" -> true, and no patch.
    assert.equal(marginIsUnrepresentable(50, Infinity), true);
    assert.equal(marginIsUnrepresentable(50, NaN), true);
    assert.deepEqual(marginPatchForRate(50, Infinity), { markupPercent: null });
    assert.deepEqual(marginPatchForRate(50, NaN), { markupPercent: null });
});

/**
 * PROPERTY: whenever marginIsUnrepresentable says a rate/price pair IS representable, the
 * margin marginPatchForRate actually persists must describe that same rate — i.e.
 * parseFloat(marginPatchForRate(rate, price).markupPercent) equals derivedMarginPct(rate, price)
 * rounded to 2dp, at every price scale. This is the round-trip guarantee the whole detection
 * mechanism exists to protect: a stored margin the caller did NOT flag must always be true.
 */
test("stored margin always describes the stored rate when not flagged unrepresentable", () => {
    const prices = [1500, 100, 12.5, 1, 0.49];
    const factors = [1, 0.75, 0.5, 0.25, 0.01]; // rate = price * factor -> margin = (1-factor)*100

    for (const price of prices) {
        for (const factor of factors) {
            const rate = price * factor;
            assert.equal(
                marginIsUnrepresentable(rate, price),
                false,
                `expected rate ${rate} at price ${price} to be representable`,
            );
            const patch = marginPatchForRate(rate, price);
            assert.notEqual(patch.markupPercent, null);
            const expected = Math.round(derivedMarginPct(rate, price) * 100) / 100;
            assert.equal(
                parseFloat(patch.markupPercent!),
                expected,
                `stored margin does not describe rate ${rate} at price ${price}`,
            );
        }
    }
});

/**
 * REGRESSION: a NEGATIVE budget rate used to read as "no budget at all" (every non-positive rate
 * short-circuited to false), but it still persists to budgetRate — and internalBudget happily
 * multiplies it out — while marginPatchForRate clears markupPercent, which then displays the
 * default 25%. A bad (negative) budget must not be indistinguishable from no budget. rate === 0
 * is the one true "no budget" case and stays unflagged.
 */
test("a negative rate is a bad budget, not no budget, and is flagged unrepresentable", () => {
    assert.equal(marginIsUnrepresentable(0, 100), false);
    assert.equal(marginIsUnrepresentable(-5, 100), true);
});

/**
 * REGRESSION: stale-margin detection. A margin persisted on an item can be left behind by an
 * edit that changed the sell price (or rate) without re-deriving markupPercent — the reported
 * shape was a stored 25% sitting next to rate 75 / price 200, whose real margin is 62.5%.
 * marginIsStale is the check that surfaces this without re-flagging pairs marginIsUnrepresentable
 * already owns.
 */
test("marginIsStale flags a persisted margin that no longer describes rate/price", () => {
    // The reported regression shape: stored 25%, but rate 75 at price 200 is really 62.5%.
    assert.equal(marginIsStale(25, 75, 200), true);
});

test("marginIsStale is false when the stored margin agrees with rate/price", () => {
    assert.equal(marginIsStale(25, 75, 100), false);
});

test("marginIsStale is false for inputs with nothing to compare", () => {
    assert.equal(marginIsStale(null, 75, 100), false);
    assert.equal(marginIsStale(NaN, 75, 100), false);
    assert.equal(marginIsStale(25, 0, 100), false);
    assert.equal(marginIsStale(25, -5, 100), false);
    assert.equal(marginIsStale(25, Infinity, 100), false);
    assert.equal(marginIsStale(25, 75, 0), false);
});

/**
 * INVARIANT: marginIsStale must never double-flag a pair marginIsUnrepresentable already reports
 * — an out-of-range rate/price pair has no honest margin to compare a stored value against, so
 * the unrepresentable check owns it exclusively.
 */
test("marginIsStale defers to marginIsUnrepresentable instead of double-flagging", () => {
    // rate > price: clamps to 0%, marginIsUnrepresentable is the one that should catch this.
    assert.equal(marginIsUnrepresentable(150, 100), true);
    assert.equal(marginIsStale(0, 150, 100), false);

    // rate far below price: clamps to 99%, same deferral.
    assert.equal(marginIsUnrepresentable(0.5, 100), true);
    assert.equal(marginIsStale(99, 0.5, 100), false);
});

/**
 * PROPERTY (no-false-positive): a margin freshly written by marginPatchForRate must never trip
 * marginIsStale against the same rate/price it was derived from — otherwise every newly saved
 * row would warn on its own value. Covers a spread of prices and in-range margins, going through
 * the same 2dp string round-trip a real save performs.
 */
test("a freshly derived margin never flags itself as stale", () => {
    const prices = [1500, 100, 12.5, 1, 0.49];
    const margins = [0, 10, 25, 50, 75, 99];

    for (const price of prices) {
        for (const marginPct of margins) {
            const rate = costFromMargin(price, marginPct);
            if (rate <= 0) continue; // marginIsStale requires rate > 0
            const patch = marginPatchForRate(rate, price);
            assert.notEqual(patch.markupPercent, null);
            const stored = parseFloat(patch.markupPercent!);
            assert.equal(
                marginIsStale(stored, rate, price),
                false,
                `freshly stored margin ${stored} flagged stale for rate ${rate} at price ${price}`,
            );
        }
    }
});

/**
 * REGRESSION: the tolerance used to be a flat MARGIN_STORAGE_HALF_STEP (0.005), sized for only
 * ONE writer's rounding. A row can legitimately be off by a half-step from EACH of the two
 * writers at once — marginPatchForRate rounds the MARGIN to 2dp, formatDerivedRate rounds the
 * RATE to derivedRateDecimals(price) places — so a row written by rounding the rate first and
 * then re-deriving/rounding the margin can sit a combined distance from the true margin that a
 * single half-step does not cover. Reported shape: rate 2.95 at price 8 stores margin "63.13"
 * (marginPatchForRate(2.95, 8).markupPercent) against a true margin of 63.125 — a difference of
 * 0.005000000000002558, which trips the old flat 0.005 boundary by float dust alone. The
 * tolerance now adds rateRoundingMarginDrift(price) to cover the second writer's rounding, so a
 * freshly written row must never warn.
 */
test("marginIsStale does not flag a freshly written row off by one half-step from each writer", () => {
    assert.equal(marginPatchForRate(2.95, 8).markupPercent, "63.13");
    assert.equal(marginIsStale(63.13, 2.95, 8), false);
});

/**
 * REGRESSION: typed-margin round trip through the OTHER writer path. A margin typed by the user
 * (25.025) derives a cost via costFromMargin, which formatDerivedRate rounds to
 * derivedRateDecimals(price) places for storage. Reading that stored rate back must not flag the
 * margin it was derived from as stale, even though the rate went through its own rounding step
 * independent of the margin's.
 */
test("marginIsStale does not flag a typed margin against the rate rounded from it", () => {
    const price = 100;
    const margin = 25.025;
    const rate = formatDerivedRate(costFromMargin(price, margin), price);
    assert.equal(marginIsStale(margin, parseFloat(rate), price), false);
});

/**
 * PROPERTY (no-false-positive, both writer directions): at every price scale the derived-rate
 * decimal count actually changes at, and across a spread of in-range margins/rates, BOTH ways a
 * row gets written must round-trip clean:
 *  - path A (rate-first): a rate is picked, the margin stored beside it comes from
 *    marginPatchForRate(rate, price) — mirrors a user typing a budget rate.
 *  - path B (margin-first): a margin is stored verbatim, the rate stored beside it comes from
 *    formatDerivedRate(costFromMargin(price, margin), price) — mirrors a user typing a margin.
 * Neither path may ever flag its own freshly written pair as stale.
 */
test("both writer paths round-trip clean at every price scale (property)", () => {
    const prices = [0.49, 1, 8, 12.5, 100, 1500, 1e6];
    const margins = [1, 10, 25, 50, 75, 90, 99]; // keep well inside (0, 100) at every scale

    for (const price of prices) {
        for (const marginPct of margins) {
            // Path A: rate-first. Derive a real rate from the margin so it's in range for this
            // price, then store the MARGIN from that rate — this is what marginPatchForRate sees
            // when a user types a rate.
            const pickedRate = costFromMargin(price, marginPct);
            if (pickedRate > 0) {
                const patch = marginPatchForRate(pickedRate, price);
                assert.notEqual(patch.markupPercent, null, `path A: no margin stored for rate ${pickedRate} at price ${price}`);
                const storedMargin = parseFloat(patch.markupPercent!);
                assert.equal(
                    marginIsStale(storedMargin, pickedRate, price),
                    false,
                    `path A: rate ${pickedRate} at price ${price} flagged stale against its own derived margin ${storedMargin}`,
                );
            }

            // Path B: margin-first. Store the margin verbatim, derive the RATE via
            // formatDerivedRate(costFromMargin(...)) — this is what a user typing a margin writes.
            const derivedRate = parseFloat(formatDerivedRate(costFromMargin(price, marginPct), price));
            if (derivedRate > 0) {
                assert.equal(
                    marginIsStale(marginPct, derivedRate, price),
                    false,
                    `path B: margin ${marginPct} at price ${price} flagged stale against its own derived rate ${derivedRate}`,
                );
            }
        }
    }
});

/**
 * REGRESSION: the widened tolerance must not grow large enough to swallow a REAL contradiction.
 * Confirms detection still works at multiple price scales beyond the originally reported shape
 * (marginIsStale(25, 75, 200) — stored 25%, but rate 75 at price 200 is really 62.5%).
 */
test("marginIsStale still catches genuine staleness at every price scale", () => {
    // The originally reported shape.
    assert.equal(marginIsStale(25, 75, 200), true);

    // A large-price contradiction: stored 80%, but rate 500 at price 5000 is really 90%.
    assert.equal(marginIsStale(80, 500, 5000), true);

    // A sub-dollar contradiction: stored 50%, but rate 0.01 at price 0.05 is really 80%.
    assert.equal(marginIsStale(50, 0.01, 0.05), true);
});

/**
 * derivedRateDecimals is the shared rounding rule behind both formatDerivedRate and
 * marginIsStale's tolerance — this pins the shape of that rule directly, independent of the
 * margin math built on top of it.
 */
test("derivedRateDecimals: bounds, growth, and non-finite/non-positive price", () => {
    // Large prices need no more than cents.
    assert.equal(derivedRateDecimals(1e6), 2);
    // Floored at 2 even for prices far larger still — never fewer than cents.
    assert.equal(derivedRateDecimals(1e10), 2);

    // Sub-dollar prices need more precision than cents to keep the implied margin accurate.
    assert.ok(derivedRateDecimals(0.49) > 2, "expected sub-dollar price to need more than 2 decimals");

    // Capped at 10 even for a price small enough that the naive formula would ask for more.
    assert.equal(derivedRateDecimals(1e-10), 10);

    // Non-positive / non-finite price has no meaningful scale — falls back to 2.
    assert.equal(derivedRateDecimals(0), 2);
    assert.equal(derivedRateDecimals(-5), 2);
    assert.equal(derivedRateDecimals(NaN), 2);
    assert.equal(derivedRateDecimals(Infinity), 2);
});

/**
 * INVARIANT: formatDerivedRate and derivedRateDecimals must never drift apart — the doc comment
 * on derivedRateDecimals says as much ("if these two ever disagree, healthy rows start
 * warning"). Pins that a positive rate is always formatted at exactly derivedRateDecimals(price)
 * decimal places, at every scale exercised above.
 */
test("formatDerivedRate always uses exactly derivedRateDecimals(price) decimal places", () => {
    for (const price of [0.01, 0.49, 1, 8, 12.5, 100, 1500, 1e6]) {
        const formatted = formatDerivedRate(1.23456789, price);
        const decimalPlaces = formatted.includes(".") ? formatted.split(".")[1].length : 0;
        assert.equal(
            decimalPlaces,
            derivedRateDecimals(price),
            `formatDerivedRate(1.23456789, ${price}) = "${formatted}" does not match derivedRateDecimals(${price})`,
        );
    }
});
