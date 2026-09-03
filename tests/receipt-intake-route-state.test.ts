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
import { backoffMs, MAX_BOOK_ATTEMPTS, preservedTaxWarning, retryTargetFor, routeState } from "../src/lib/receipt-intake/route-state";

const NO_HITS = { strong: null, weak: null };
const clean = { docType: "receipt", amount: "364.98", totalCents: 36498, canonicalVendor: "lowes" };
/** The strong key is vendor-LESS, so an owner has to carry its vendor separately. */
const owner = (over: Partial<{ id: string; totalCents: number | null; canonicalVendor: string | null }> = {}) =>
    ({ id: "row-a", totalCents: 36498, canonicalVendor: "lowes", ...over });

test("multi outranks everything, including a missing project", () => {
    const d = routeState({ docType: "multi", amount: "0.00", totalCents: null, canonicalVendor: "" }, NO_HITS, false);
    assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "multi-doc", duplicateOfId: null });
});

test("a non-receipt is its own terminal state, not a review item", () => {
    const d = routeState({ docType: "non_receipt", amount: "0.00", totalCents: null, canonicalVendor: "" }, NO_HITS, true);
    assert.deepEqual(d, { state: "NON_RECEIPT", stateReason: null, duplicateOfId: null });
});

test("a $0.00 total is a misread and is parked BEFORE any dedup or job check", () => {
    // :531 — you don't get a $0 receipt or write a $0 check. Letting this reach
    // a key would poison it for the real document.
    const d = routeState(
        { docType: "receipt", amount: "0.00", totalCents: 0, canonicalVendor: "lowes" },
        { strong: owner({ id: "owner", totalCents: 0 }), weak: { id: "other" } },
        true,
    );
    assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "refund-or-zero", duplicateOfId: null });
});

test("a NEGATIVE total is a refund: reviewed, and it claims no dedup key", () => {
    // A refund is a legitimate document — v1 carried them all the way through
    // rename/dedup/archive — but it must never book itself against the original
    // purchase automatically, and it must not hold a key the original needs.
    for (const [amount, cents] of [["-22.57", -2257], ["-1200.00", -120000]] as const) {
        const d = routeState(
            { docType: "receipt", amount, totalCents: cents, canonicalVendor: "lowes" },
            NO_HITS,
            true,
        );
        assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "refund-or-zero", duplicateOfId: null }, amount);
    }
});

test("an unreadable total (null cents) is reviewed, not booked", () => {
    const d = routeState(
        { docType: "receipt", amount: "abc", totalCents: null, canonicalVendor: "lowes" },
        NO_HITS,
        true,
    );
    assert.equal(d.stateReason, "refund-or-zero");
});

test("no project means NEEDS_JOB — a queue, not a fault", () => {
    const d = routeState(clean, NO_HITS, false);
    assert.deepEqual(d, { state: "NEEDS_JOB", stateReason: null, duplicateOfId: null });
});

test("a strong hit at the same total AND the same vendor is the same purchase twice", () => {
    const d = routeState(clean, { strong: owner(), weak: null }, true);
    assert.deepEqual(d, { state: "DUPLICATE", stateReason: null, duplicateOfId: "row-a" });
});

test("same total, DIFFERENT vendor is a key collision, not a duplicate", () => {
    // The v3.6 key leaves the vendor out on purpose (one store spells its own
    // name three ways). The cost is that two unrelated vendors reusing an
    // invoice number on one day for the same amount collide — and quarantining
    // one of those would silently drop a real expense. The vendor is not part
    // of the KEY, but it is part of the CONFIRMATION.
    const d = routeState(clean, { strong: owner({ canonicalVendor: "homedepot" }), weak: null }, true);
    assert.deepEqual(d, {
        state: "NEEDS_REVIEW",
        stateReason: "vendor-mismatch:row-a",
        duplicateOfId: "row-a",
    });
});

test("an owner whose VENDOR is unknown is not a confirmed match either", () => {
    const d = routeState(clean, { strong: owner({ canonicalVendor: null }), weak: null }, true);
    assert.equal(d.state, "NEEDS_REVIEW");
    assert.equal(d.stateReason, "vendor-mismatch:row-a");
});

test("a chain's spelling variants still collapse — canonicalVendor is what is compared", () => {
    // "Lowe's Home Improvement" and "LOWES HOME CENTERS LLC" both canonicalise
    // to "lowes", so the alias table (not the raw string) decides this.
    const d = routeState(clean, { strong: owner({ canonicalVendor: "lowes" }), weak: null }, true);
    assert.equal(d.state, "DUPLICATE");
});

test("a strong hit at a DIFFERENT total is ambiguous and goes to a human", () => {
    const d = routeState(clean, { strong: owner({ totalCents: 20000 }), weak: null }, true);
    assert.deepEqual(d, {
        state: "NEEDS_REVIEW",
        stateReason: "strong-dup-amount-mismatch:row-a",
        duplicateOfId: "row-a",
    });
});

test("an owner whose total is unknown is never treated as a match", () => {
    // A null total means "can't confirm the totals match" — reading it as a
    // match would silently quarantine a real expense.
    const d = routeState(clean, { strong: owner({ totalCents: null }), weak: null }, true);
    assert.equal(d.state, "NEEDS_REVIEW");
    assert.equal(d.stateReason, "strong-dup-amount-mismatch:row-a");
});

test("a weak hit always asks a human, never quarantines on its own", () => {
    const d = routeState(clean, { strong: null, weak: { id: "row-b" } }, true);
    assert.deepEqual(d, { state: "NEEDS_REVIEW", stateReason: "weak-dup:row-b", duplicateOfId: null });
});

test("the strong net is checked before the weak one", () => {
    const d = routeState(clean, { strong: owner(), weak: { id: "row-b" } }, true);
    assert.equal(d.state, "DUPLICATE");
    assert.equal(d.duplicateOfId, "row-a");
});

test("a clean document with a job and no hits is READ", () => {
    assert.deepEqual(routeState(clean, NO_HITS, true), {
        state: "READ", stateReason: null, duplicateOfId: null,
    });
});

test("preservedTaxWarning keeps only the tax-implausible marker", () => {
    assert.equal(preservedTaxWarning("tax-implausible"), "tax-implausible");
    // A compound reason (a park reason plus the warning, joined by ";" the
    // same way worker.ts's note() builds it) still yields the marker alone —
    // the other half of the reason is a park explanation, not a fact worth
    // carrying into BOOKED.
    assert.equal(preservedTaxWarning("weak-dup:row-a;tax-implausible"), "tax-implausible");
    // Anything else — a defer reason, a park reason with no warning, absence —
    // must NOT be mistaken for the marker and ride along into BOOKED.
    assert.equal(preservedTaxWarning("push-paused"), null);
    assert.equal(preservedTaxWarning(null), null);
    assert.equal(preservedTaxWarning(undefined), null);
});

test("backoff is 5m / 15m / 1h / 6h and then stays at 6h", () => {
    assert.equal(backoffMs(1), 5 * 60_000);
    assert.equal(backoffMs(2), 15 * 60_000);
    assert.equal(backoffMs(3), 60 * 60_000);
    assert.equal(backoffMs(4), 6 * 60 * 60_000);
    assert.equal(backoffMs(10), 6 * 60 * 60_000);
    assert.equal(MAX_BOOK_ATTEMPTS, 20);
});

// ── Manual "Retry now" (Codex real issue 10) ────────────────────────────────

test("only transient FAILURES are retryable — never a document verdict", async t => {
    await t.test("a BOOKING row is always retryable; it is mid-flight, not parked", () => {
        assert.equal(retryTargetFor("BOOKING", null), "BOOKING");
        assert.equal(retryTargetFor("BOOKING", "push-paused"), "BOOKING");
    });

    await t.test("pre-read failures resume at RECEIVED so the document is read again", () => {
        assert.equal(retryTargetFor("NEEDS_REVIEW", "ai-unavailable"), "RECEIVED");
        assert.equal(retryTargetFor("NEEDS_REVIEW", "file-missing"), "RECEIVED");
    });

    await t.test("send failures resume at BOOKING — the read is already done", () => {
        assert.equal(retryTargetFor("NEEDS_REVIEW", "qbo-timeout"), "BOOKING");
        assert.equal(retryTargetFor("NEEDS_REVIEW", "qbo-5xx"), "BOOKING");
        assert.equal(retryTargetFor("NEEDS_REVIEW", "qbo-fault:503"), "BOOKING");
        assert.equal(retryTargetFor("NEEDS_REVIEW", "qbo-fault:429"), "BOOKING");
        assert.equal(retryTargetFor("NEEDS_REVIEW", "max-retries"), "BOOKING");
    });

    await t.test("document verdicts are NOT retryable — another attempt parks them again", () => {
        for (const reason of [
            "multi-doc", "no-estimate", "refund-or-zero", "invalid-date", "zero-total",
            "weak-dup:abc", "strong-dup-amount-mismatch:abc", "vendor-mismatch:abc",
            "qbo-fault:account-config", "qbo-fault:vendor-duplicate", "voided-by-user",
        ]) {
            assert.equal(retryTargetFor("NEEDS_REVIEW", reason), null, reason);
        }
    });

    await t.test("an unknown or empty reason is not retryable — the list is CLOSED", () => {
        assert.equal(retryTargetFor("NEEDS_REVIEW", "something-new"), null);
        assert.equal(retryTargetFor("NEEDS_REVIEW", ""), null);
        assert.equal(retryTargetFor("NEEDS_REVIEW", null), null);
    });

    await t.test("no other state may be retried at all", () => {
        for (const state of ["STAGING", "RECEIVED", "READ", "NEEDS_JOB", "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT"]) {
            assert.equal(retryTargetFor(state, "qbo-timeout"), null, state);
        }
    });

    await t.test("a reason that merely CONTAINS a retryable one does not qualify", () => {
        assert.equal(retryTargetFor("NEEDS_REVIEW", "not-ai-unavailable"), null);
        assert.equal(retryTargetFor("NEEDS_REVIEW", "max-retries-exceeded"), null);
    });
});
