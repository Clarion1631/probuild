/**
 * The cutover boundary and the storage-failure classification.
 *
 * Both are places where getting the answer WRONG loses money rather than
 * merely erroring: a mis-parsed boundary retires receipts nobody booked, and a
 * mis-classified storage fault declares a present file missing and releases its
 * dedup key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCutoverBoundary, CUTOVER_SETTING_KEY } from "../src/lib/receipt-intake/cutover";

test("a missing or malformed boundary is null — never epoch", () => {
    // The dangerous failure: `new Date(undefined)` style coercion yielding a
    // date in 1970 would put the ENTIRE backlog "before the boundary" and
    // retire every row, including the ones v1 never booked.
    for (const bad of [undefined, null, "", "   ", "not-a-date", "yesterday", "2026-13-45"]) {
        assert.equal(parseCutoverBoundary(bad as string | null | undefined), null, JSON.stringify(bad));
    }
});

test("a real ISO timestamp parses to that instant", () => {
    const at = parseCutoverBoundary("2026-08-25T17:30:00.000Z");
    assert.ok(at);
    assert.equal(at.toISOString(), "2026-08-25T17:30:00.000Z");
    // Surrounding whitespace is a copy-paste artefact, not a different answer.
    assert.equal(parseCutoverBoundary("  2026-08-25T17:30:00.000Z  ")!.toISOString(), "2026-08-25T17:30:00.000Z");
});

test("the setting key is stable — an operator writes this row at the flip", () => {
    // Renaming it silently would make every future cutover refuse.
    assert.equal(CUTOVER_SETTING_KEY, "cutoverV1StoppedAt");
});
