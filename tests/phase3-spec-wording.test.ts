/**
 * THE SPEC IS PART OF THE SHIP (Codex round 46, item 4).
 *
 * `docs/plans/PHASE-3-ATTRIBUTION-SPEC.md` is what the next person reads before
 * touching the tax path, and it had drifted three ways from the code that
 * actually shipped:
 *
 *   * it said an acknowledgement needs the TWO figures and that
 *     `installedAtCustomer` is "always optional" — round 43 made it three,
 *     because that field is the one the excise report keys on and omitting it
 *     preserves a stored `true`;
 *   * it listed `taxAtSource` among the columns PATCH edits — round 20 made it
 *     derived, and a request carrying the key is a 400; and
 *   * it described the report's filter as `taxAmount > 0` with unsigned bounds
 *     `0 ≤ base ≤ amount − taxAmount` — rounds 40/42 made the whole path
 *     SIGNED, because a vendor credit is a negative expense carrying negative
 *     tax and belongs on the filing as a subtraction.
 *
 * A spec that contradicts the code is worse than no spec: it tells someone the
 * old rule is the intended one and invites them to "fix" the code back. So the
 * sentences are pinned here, against the constants and the behaviour they
 * describe, and a future change to either has to move both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    MAX_PLAUSIBLE_TAX_RATE,
    taxReviewAckIsComplete,
} from "../src/lib/expense-attribution";

const SPEC = readFileSync(
    path.resolve(__dirname, "..", "docs", "plans", "PHASE-3-ATTRIBUTION-SPEC.md"),
    "utf8",
);

test("the ack rule says all THREE fields, and the code agrees", () => {
    assert.match(
        SPEC,
        /ALL THREE of the\s+`taxAmount`, `taxDeductibleBase` and `installedAtCustomer` keys in the same request/,
    );
    assert.match(SPEC, /`installedAtCustomer` is NOT the\s+optional one it looks like/);
    // The claim, checked against the function the route calls.
    assert.equal(
        taxReviewAckIsComplete({ taxAmount: true, taxDeductibleBase: true, installedAtCustomer: true }),
        true,
    );
    for (const missing of ["taxAmount", "taxDeductibleBase", "installedAtCustomer"] as const) {
        assert.equal(
            taxReviewAckIsComplete({
                taxAmount: missing !== "taxAmount",
                taxDeductibleBase: missing !== "taxDeductibleBase",
                installedAtCustomer: missing !== "installedAtCustomer",
            }),
            false,
            `omitting ${missing} is not a complete acknowledgement`,
        );
    }
});

test("...and the sentence it replaced is gone", () => {
    // The exact drifted wording. A negative assertion is weak on its own, which
    // is why the positive one above exists — but leaving this in means an
    // accidental revert is caught rather than merely un-asserted.
    assert.doesNotMatch(SPEC, /`installedAtCustomer` is always optional/);
    assert.doesNotMatch(SPEC, /BOTH the `taxAmount`\s+AND `taxDeductibleBase` keys/);
});

test("`taxAtSource` is documented as derived, not as an editable column", () => {
    assert.match(SPEC, /\*\*`taxAtSource` is DERIVED, never supplied\*\*/);
    assert.match(SPEC, /Expense_taxAtSource_check/);
    // The PATCH column list must no longer name it.
    assert.doesNotMatch(
        SPEC,
        /PATCH edits ONLY[\s\S]{0,160}`taxAtSource`/,
        "the editable-column list still names a derived column",
    );
});

test("the tax bounds are written SIGNED, at the rate the code uses", () => {
    assert.match(SPEC, /of the SAME SIGN as\s+`amount`/);
    assert.match(SPEC, /\|taxDeductibleBase\| ≤ \|amount − taxAmount\|/);
    assert.match(SPEC, /Written as `0 ≤ base ≤ amount − taxAmount`\s+those bounds would reject every legitimate refund/);
    // The band, and its name, as the code holds them.
    assert.equal(MAX_PLAUSIBLE_TAX_RATE, 0.12);
    assert.match(SPEC, /`\|taxAmount\| ≤ 12% of \|amount\|` \(`MAX_PLAUSIBLE_TAX_RATE`\)/);
});

test("the report's filter is documented as it is implemented", () => {
    assert.match(SPEC, /`taxAtSource = true AND installedAtCustomer = true AND\s+taxAmount != 0 AND needsTaxReview = false`/);
    assert.match(SPEC, /\*\*`taxAmount != 0`, not `> 0`:\*\*/);
    assert.doesNotMatch(SPEC, /all three POSITIVE/, "the old three-positive-conditions claim is gone");
    // The predicate itself, read off the shipped query rather than restated.
    const report = readFileSync(
        path.resolve(__dirname, "..", "src", "lib", "tax-at-source-report.ts"),
        "utf8",
    );
    assert.match(report, /taxAtSource: true/);
    assert.match(report, /installedAtCustomer: true/);
    assert.match(report, /taxAmount: \{ not: 0 \}/);
    assert.match(report, /needsTaxReview: false/);
});
