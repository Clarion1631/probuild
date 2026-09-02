/**
 * The routing truth table (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §4) plus the
 * booking backoff schedule. Both are pure, so this file needs no database.
 *
 * Order is the assertion, not just the outcomes: "first match wins" is why a
 * $0 misread never reaches a dedup key and why a multi-page scan is triaged
 * before anyone asks which job it belongs to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { backoffMs, MAX_BOOK_ATTEMPTS, routeState } from "../src/lib/receipt-intake/route-state";

const NO_HITS = { strong: null, weak: null };
const clean = { docType: "receipt", amount: "364.98", totalCents: 36498 };

test("multi outranks everything, including a missing project", () => {
    const d = routeState({ docType: "multi", amount: "0.00", totalCents: null }, NO_HITS, false);
    assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "multi-doc", duplicateOfId: null });
});

test("a non-receipt is its own terminal state, not a review item", () => {
    const d = routeState({ docType: "non_receipt", amount: "0.00", totalCents: null }, NO_HITS, true);
    assert.deepEqual(d, { state: "NON_RECEIPT", stateReason: null, duplicateOfId: null });
});

test("a $0.00 total is a misread and is parked BEFORE any dedup or job check", () => {
    // :531 — you don't get a $0 receipt or write a $0 check. Letting this reach
    // a key would poison it for the real document.
    const d = routeState(
        { docType: "receipt", amount: "0.00", totalCents: 0 },
        { strong: { id: "owner", totalCents: 0 }, weak: { id: "other" } },
        true,
    );
    assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "zero-total", duplicateOfId: null });
});

test("no project means NEEDS_JOB — a queue, not a fault", () => {
    const d = routeState(clean, NO_HITS, false);
    assert.deepEqual(d, { state: "NEEDS_JOB", stateReason: null, duplicateOfId: null });
});

test("a strong hit at the same total is the same purchase twice", () => {
    const d = routeState(clean, { strong: { id: "row-a", totalCents: 36498 }, weak: null }, true);
    assert.deepEqual(d, { state: "DUPLICATE", stateReason: null, duplicateOfId: "row-a" });
});

test("a strong hit at a DIFFERENT total is ambiguous and goes to a human", () => {
    const d = routeState(clean, { strong: { id: "row-a", totalCents: 20000 }, weak: null }, true);
    assert.deepEqual(d, {
        state: "NEEDS_REVIEW",
        stateReason: "strong-dup-amount-mismatch:row-a",
        duplicateOfId: "row-a",
    });
});

test("an owner whose total is unknown is never treated as a match", () => {
    // A null total means "can't confirm the totals match" — reading it as a
    // match would silently quarantine a real expense.
    const d = routeState(clean, { strong: { id: "row-a", totalCents: null }, weak: null }, true);
    assert.equal(d.state, "NEEDS_REVIEW");
    assert.equal(d.stateReason, "strong-dup-amount-mismatch:row-a");
});

test("a weak hit always asks a human, never quarantines on its own", () => {
    const d = routeState(clean, { strong: null, weak: { id: "row-b" } }, true);
    assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "weak-dup:row-b", duplicateOfId: null });
});

test("the strong net is checked before the weak one", () => {
    const d = routeState(clean, { strong: { id: "row-a", totalCents: 36498 }, weak: { id: "row-b" } }, true);
    assert.equal(d.state, "DUPLICATE");
    assert.equal(d.duplicateOfId, "row-a");
});

test("a clean document with a job and no hits is READ", () => {
    assert.deepEqual(routeState(clean, NO_HITS, true), {
        state: "READ", stateReason: null, duplicateOfId: null,
    });
});

test("backoff is 5m / 15m / 1h / 6h and then stays at 6h", () => {
    assert.equal(backoffMs(1), 5 * 60_000);
    assert.equal(backoffMs(2), 15 * 60_000);
    assert.equal(backoffMs(3), 60 * 60_000);
    assert.equal(backoffMs(4), 6 * 60 * 60_000);
    assert.equal(backoffMs(10), 6 * 60 * 60_000);
    assert.equal(MAX_BOOK_ATTEMPTS, 20);
});
