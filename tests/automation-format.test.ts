import assert from "node:assert/strict";
import test from "node:test";
import { amountSign } from "../src/app/automation/components/format";

// ── amountSign — B7 + Codex round 1 finding 10 ──────────────────────────────
// B7: decide the sign from the rounded-to-the-cent magnitude, not the raw
// value, so a sub-cent value that rounds to $0.00 never carries a sign the
// displayed digits don't back up. Finding 10: round the MAGNITUDE and
// reapply the ORIGINAL sign — never `Math.round(x)` directly, which rounds
// halfway values toward +Infinity (not away from zero) and produces -0 for
// exactly -0.5, silently dropping a genuine negative's sign.

test("positive amounts sign '+'", () => {
    assert.equal(amountSign(100), "+");
    assert.equal(amountSign(1), "+");
});

test("negative amounts sign '-'", () => {
    assert.equal(amountSign(-100), "-");
    assert.equal(amountSign(-1), "-");
});

test("exactly zero has no sign", () => {
    assert.equal(amountSign(0), "");
});

test("a sub-cent value that rounds to zero has no sign (B7) — either direction", () => {
    assert.equal(amountSign(0.001), "");
    assert.equal(amountSign(-0.001), "");
    assert.equal(amountSign(0.499), "");
    assert.equal(amountSign(-0.499), "");
});

test("finding 10: a negative half-cent still signs '-', not '' — Math.round(-0.5) alone would silently drop it", () => {
    // Sanity-check the exact JS quirk this guards against: plain Math.round
    // rounds -0.5 toward +Infinity, landing on -0, which is NOT `< 0`.
    assert.equal(Object.is(Math.round(-0.5), -0), true);
    assert.equal(Math.round(-0.5) < 0, false);
    // amountSign must not inherit that: rounding the MAGNITUDE (0.5 -> 1,
    // a nonzero cent) and reapplying the original negative sign gives "-".
    assert.equal(amountSign(-0.5), "-");
});

test("finding 10: a positive half-cent still signs '+' — symmetric with the negative case above", () => {
    assert.equal(amountSign(0.5), "+");
});

test("finding 10: larger halfway values round symmetrically in both directions", () => {
    assert.equal(amountSign(-1.5), "-");
    assert.equal(amountSign(1.5), "+");
});
