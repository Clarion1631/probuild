/**
 * The extraction from scripts/suggest-expense-cost-codes.mjs must be verbatim:
 * the script's dry run has already been reviewed by a human against these exact
 * regexes, and three callers now share them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    LINE_RULES,
    LINE_RULE_CONFIDENCE,
    VENDOR_RULES,
    VENDOR_RULE_CONFIDENCE,
    suggestCode,
} from "../src/lib/expense-cost-suggest";

test("a specialty vendor is decided on the vendor alone, at the vendor tier", () => {
    const hit = suggestCode({ vendor: "Summit Plumbing LLC", description: "misc" });
    assert.equal(hit?.code, "03-PLUMB");
    assert.equal(hit?.tier, "vendor");
    assert.equal(hit?.confidence, VENDOR_RULE_CONFIDENCE);
});

test("a general retailer is decided on the itemised lines, at the line tier", () => {
    const hit = suggestCode({
        vendor: "Lowe's",
        description: "[Drive import] Invoice 123 · Materials | Lines: 2x4 stud douglas fir; joist hanger",
    });
    assert.equal(hit?.code, "02-FRAME");
    assert.equal(hit?.tier, "line");
    assert.equal(hit?.confidence, LINE_RULE_CONFIDENCE);
});

test("only the itemised portion is read — boilerplate in the prefix is ignored", () => {
    // "Receipt" boilerplate mentioning a trade word before "Lines:" must not
    // decide the phase; the whole point of the slice is that the prefix is
    // template text the pipeline wrote, not evidence from the vendor.
    const hit = suggestCode({
        vendor: "Lowe's",
        description: "paint department checkout | Lines: 1/2in drywall sheet; joint compound",
    });
    assert.equal(hit?.code, "07-DRYWALL");
});

test("no evidence returns null — a refusal is a legitimate answer", () => {
    assert.equal(suggestCode({ vendor: "Lowe's", description: "misc supplies" }), null);
    assert.equal(suggestCode({ vendor: null, description: null }), null);
    assert.equal(suggestCode({}), null);
});

test("an excavator rental is sitework, not cleanup (the $3,317.78 Mesplay mis-book)", () => {
    // The rule ordering is load-bearing: /disposal|debris|dump fee/ comes
    // BEFORE /excavator/, and neither may capture the other's rows.
    assert.equal(suggestCode({ vendor: "Sunbelt", description: "Lines: mini excavator rental 1 day" })?.code, "23-SITEWORK");
    assert.equal(suggestCode({ vendor: "Sunbelt", description: "Lines: dump fee msw" })?.code, "20-CLEAN");
});

test("vendor rules beat line rules", () => {
    const hit = suggestCode({
        vendor: "Ferguson",
        description: "Lines: 2x4 stud douglas fir",
    });
    assert.equal(hit?.code, "03-PLUMB", "a specialty vendor is stronger evidence than a keyword");
    assert.equal(hit?.tier, "vendor");
});

test("the rule sets are the ones the reviewed dry run used", () => {
    assert.equal(VENDOR_RULES.length, 7);
    assert.equal(LINE_RULES.length, 16);
    // Every rule must name a code, and no rule may be a catch-all.
    for (const rule of [...VENDOR_RULES, ...LINE_RULES]) {
        assert.match(rule.code, /^\d{2}-[A-Z]+$/);
        assert.ok(!rule.re.test(""), `catch-all rule: ${rule.re}`);
    }
});

test("the two confidence tiers both clear the backfill's 0.7 threshold, and are ordered", () => {
    assert.ok(VENDOR_RULE_CONFIDENCE > LINE_RULE_CONFIDENCE);
    assert.ok(LINE_RULE_CONFIDENCE >= 0.7);
});

test("regex lastIndex cannot leak between calls", () => {
    // A /g flag on any rule would make repeated calls return different answers
    // for the same input. Cheap assertion, catastrophic bug.
    for (const rule of [...VENDOR_RULES, ...LINE_RULES]) {
        assert.ok(!rule.re.global, `rule must not be global: ${rule.re}`);
    }
    const input = { vendor: "Summit Plumbing", description: "" };
    assert.deepEqual(suggestCode(input), suggestCode(input));
});
