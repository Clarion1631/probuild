import assert from "node:assert/strict";
import test from "node:test";
import { applyRegisterFilters } from "../src/app/automation/register-filters";

// ── B1 — "Needs review only" must never build an empty state from missing
// data ────────────────────────────────────────────────────────────────────
// On the degraded path (merge inputs failed to load), every row was mapped
// to `needsReview: false` — not because nothing needs review, but because we
// don't know. Applying the reviewOnly filter against that fabricated data
// used to remove the ENTIRE register, and the page reported "Nothing here"
// — a bookkeeper filtering for problems would conclude there are none, the
// worst possible WRONG answer. The fix: ignore the review filter (show every
// row) whenever mergeUnavailable is true, and say so on screen.

interface Row {
    amountCents: number;
    needsReview: boolean;
}

const rows: Row[] = [
    { amountCents: 100, needsReview: true },
    { amountCents: -200, needsReview: false },
    { amountCents: 300, needsReview: false },
];

test("reviewOnly + mergeUnavailable: the filter is ignored, every row still shows", () => {
    const result = applyRegisterFilters(rows, { type: "all", reviewOnly: true, mergeUnavailable: true });
    assert.equal(result.length, rows.length);
});

test("reviewOnly + merge available: filters down to needsReview rows as before (no regression)", () => {
    const result = applyRegisterFilters(rows, { type: "all", reviewOnly: true, mergeUnavailable: false });
    assert.deepEqual(result, [rows[0]]);
});

test("type filter still applies even when mergeUnavailable ignores the review filter", () => {
    const result = applyRegisterFilters(rows, { type: "out", reviewOnly: true, mergeUnavailable: true });
    assert.deepEqual(result, [rows[1]]);
});

test("no filters active: every row passes", () => {
    const result = applyRegisterFilters(rows, { type: "all", reviewOnly: false, mergeUnavailable: false });
    assert.equal(result.length, rows.length);
});

test("type: in / out partition money-in vs money-out rows", () => {
    assert.deepEqual(
        applyRegisterFilters(rows, { type: "in", reviewOnly: false, mergeUnavailable: false }),
        [rows[0], rows[2]],
    );
    assert.deepEqual(
        applyRegisterFilters(rows, { type: "out", reviewOnly: false, mergeUnavailable: false }),
        [rows[1]],
    );
});
