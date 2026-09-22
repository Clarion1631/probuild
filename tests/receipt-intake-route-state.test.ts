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
import {
    backoffMs,
    DATE_IMPLAUSIBLE_REASON,
    isImplausibleReceiptDate,
    MAX_BOOK_ATTEMPTS,
    MAX_RECEIPT_AGE_DAYS,
    MAX_RECEIPT_FUTURE_DAYS,
    preservedTaxWarning,
    retryTargetFor,
    routeState,
} from "../src/lib/receipt-intake/route-state";
// Imported ONLY to pin the deliberate divergence documented below — the
// predicate no longer uses it.
import { isValidDate } from "../src/lib/receipt-intake/keys";

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

// ── The read date has to be believable ─────────────────────────────────────

/** The day the live Sunbelt row arrived. Every offset below is measured from it. */
const ARRIVAL = "2026-09-21";
/** The misread that got through: a 2023 date on a row created in 2026. */
const badDate = { dateStr: "2023-09-17", referenceDay: ARRIVAL } as const;

test("the window is CLOSED at 120 days back and 3 days forward", () => {
    assert.equal(MAX_RECEIPT_AGE_DAYS, 120);
    assert.equal(MAX_RECEIPT_FUTURE_DAYS, 3);
    // Exactly at each bound is still plausible; one day past it is not.
    assert.equal(isImplausibleReceiptDate("2026-05-24", ARRIVAL), false, "120 days back");
    assert.equal(isImplausibleReceiptDate("2026-05-23", ARRIVAL), true, "121 days back");
    assert.equal(isImplausibleReceiptDate("2026-09-24", ARRIVAL), false, "3 days forward");
    assert.equal(isImplausibleReceiptDate("2026-09-25", ARRIVAL), true, "4 days forward");
    assert.equal(isImplausibleReceiptDate(ARRIVAL, ARRIVAL), false, "and the arrival day itself");
});

test("THE LIVE CASE: a 2023 date on a 2026 row is a misread, not a stale receipt", () => {
    // Sunbelt Rentals, $1,597.03, read as 2023-09-17 on a row created
    // 2026-09-21. Nothing in the rail checked, so it advanced to BOOKING and
    // would have become an Expense dated 2023 — into a closed year.
    assert.equal(isImplausibleReceiptDate("2023-09-17", ARRIVAL), true);
    assert.equal(isImplausibleReceiptDate("2026-09-17", ARRIVAL), false, "the date it should have read");
});

test("month, year and leap-day boundaries are plain calendar arithmetic", () => {
    // Both sides are UTC midnight, so no zone and no DST ever enters.
    assert.equal(isImplausibleReceiptDate("2025-12-31", "2026-01-01"), false, "one day, not one year");
    assert.equal(isImplausibleReceiptDate("2025-09-03", "2026-01-01"), false, "exactly 120, across the year end");
    assert.equal(isImplausibleReceiptDate("2025-09-02", "2026-01-01"), true, "121");
    assert.equal(isImplausibleReceiptDate("2026-01-31", "2026-02-01"), false, "a month end");
    assert.equal(isImplausibleReceiptDate("2024-02-29", "2024-03-01"), false, "the leap day is a real day");
    assert.equal(isImplausibleReceiptDate("2024-02-29", "2024-06-28"), false, "exactly 120 counting it");
    assert.equal(isImplausibleReceiptDate("2024-02-29", "2024-06-29"), true, "121");
});

test("validation is SELF-CONTAINED and UTC — no host time zone, no 19xx mapping", () => {
    // A four-digit year must mean itself. `Date.UTC(26, ...)` maps years 0-99
    // into the 20th century, so a naive implementation reads "0026-09-17" as
    // 1926-09-17 — and against a 1926 reference that flips the verdict from
    // "nearly two millennia old" to "four days old". This is the assertion that
    // catches it; against a 2026 reference both answers happen to agree.
    assert.equal(isImplausibleReceiptDate("0026-09-17", "1926-09-21"), true, "year 26, not 1926");
    assert.equal(isImplausibleReceiptDate("0026-09-17", "2026-09-21"), true, "and wildly old either way");

    // DELIBERATE DIVERGENCE from keys.ts's isValidDate, which round-trips
    // through host-local `new Date(y, m, d)` and therefore REJECTS "0026-09-17"
    // via that same 19xx mapping. This predicate decides whether money posts,
    // so it must not depend on the machine it runs on. The divergence is
    // one-directional and safe: the extra day it accepts gets the correct
    // (implausible) verdict, and the worker never hands it one anyway — see
    // "a year the reader cannot have read off a document" in the worker tests.
    assert.equal(isValidDate("0026-09-17"), false, "the local-time helper's quirk, pinned");

    // The leap rules are the real calendar's, in UTC.
    //
    // The references are DISTANT on purpose. Against a nearby one both a
    // correct validator and a broken one answer false — the day is either
    // rejected (null, so not judged) or accepted and one day old — so the
    // assertion proves nothing. Twenty-six years apart makes the two answers
    // disagree, which is the only way this can fail when it should.
    assert.equal(
        isImplausibleReceiptDate("2000-02-29", "2026-09-21"),
        true,
        "2000 IS a leap year, so this is a real day and a very old one; a validator that rejected it would say false",
    );
    assert.equal(
        isImplausibleReceiptDate("1900-02-29", "2026-09-21"),
        false,
        "1900 is NOT, so there is no such day to judge; a validator that rolled it to 1900-03-01 would say true",
    );
});

test("a day key is EXACTLY ten characters — no trailing whitespace is trimmed away", () => {
    // JavaScript's `$` (no `m` flag) anchors at the very end of the input, so
    // "2026-09-21\n" is already rejected — unlike in Python, where `$` also
    // matches before a trailing newline. Pinned here so the rejection is a
    // tested property of the guard rather than a quirk nobody re-checks, and so
    // a later `.trim()` or `m` flag has to break a test to land.
    for (const trailing of ["\n", "\r\n", "\t", "\r", " "]) {
        assert.equal(
            isImplausibleReceiptDate(`2023-09-17${trailing}`, ARRIVAL),
            false,
            `read date with trailing ${JSON.stringify(trailing)}`,
        );
        assert.equal(
            isImplausibleReceiptDate("2023-09-17", `${ARRIVAL}${trailing}`),
            false,
            `reference day with trailing ${JSON.stringify(trailing)}`,
        );
    }
    // The control: the same pair without the trailing character IS judged, and
    // is implausible. Without this the loop above would pass against a
    // predicate that answered false for everything.
    assert.equal(isImplausibleReceiptDate("2023-09-17", ARRIVAL), true);
});

test("a fallback date measured against itself is always plausible", () => {
    // Load-bearing for the worker: when the reader found no usable date the
    // keys substitute the row's arrival day, which is the very day the guard
    // measures against. Zero days apart, so it can never trip.
    for (const day of ["2026-09-21", "2024-02-29", "2026-01-01", "2026-12-31"]) {
        assert.equal(isImplausibleReceiptDate(day, day), false, day);
    }
});

test("a missing or unreadable day on EITHER side is not this guard's business", () => {
    // Those cases already have owners: the dedup keys fall back to the arrival
    // day and booking parks a null txnDate as `invalid-date`. Claiming them
    // here would park a row under a reason that does not describe it.
    for (const bad of [
        null, undefined, "", "   ", "not-a-date", "2026-13-05", "2026-02-30",
        "2023-02-29", "20260917", "2026-9-17",
        // A timestamp is NOT a calendar day here: both call sites hand a bare
        // YYYY-MM-DD, and accepting a second spelling invites them to drift.
        "2026-09-17T10:00:00Z",
    ]) {
        assert.equal(isImplausibleReceiptDate(bad, ARRIVAL), false, `date=${String(bad)}`);
        assert.equal(isImplausibleReceiptDate("2023-09-17", bad), false, `reference=${String(bad)}`);
    }
});

test("an implausible date parks the row BEFORE any dedup key is claimed", () => {
    const d = routeState({ ...clean, ...badDate }, { strong: owner(), weak: { id: "row-b" } }, true);
    assert.deepEqual(d, {
        state: "NEEDS_REVIEW",
        stateReason: "date-implausible",
        duplicateOfId: null,
    });
    assert.equal(DATE_IMPLAUSIBLE_REASON, "date-implausible");
});

test("the document facts ABOVE it keep their priority", () => {
    const blank = { amount: "0.00", totalCents: null, canonicalVendor: "" } as const;
    assert.equal(
        routeState({ docType: "multi", ...blank, ...badDate }, NO_HITS, true).stateReason,
        "multi-doc",
    );
    assert.equal(
        routeState({ docType: "non_receipt", ...blank, ...badDate }, NO_HITS, true).state,
        "NON_RECEIPT",
    );
    assert.equal(
        routeState({ ...clean, docType: "invoice", ...badDate }, NO_HITS, true).stateReason,
        "unknown-doc-type",
    );
    assert.equal(
        routeState({ ...clean, amount: "0.00", totalCents: 0, ...badDate }, NO_HITS, true).stateReason,
        "refund-or-zero",
    );
});

test("...and it outranks the job queue and BOTH dedup verdicts", () => {
    // No job: the document fact is the more useful answer, exactly as a $0
    // misread is — fixing the date is what unblocks the row either way.
    assert.equal(routeState({ ...clean, ...badDate }, NO_HITS, false).stateReason, "date-implausible");
    // A strong hit that would otherwise resolve to DUPLICATE on its own.
    assert.equal(
        routeState({ ...clean, ...badDate }, { strong: owner(), weak: null }, true).stateReason,
        "date-implausible",
    );
    assert.equal(
        routeState({ ...clean, ...badDate }, { strong: null, weak: { id: "row-b" } }, true).stateReason,
        "date-implausible",
    );
});

test("absent or plausible date fields leave every existing verdict untouched", () => {
    // Every other test in this file omits the two fields entirely, which is the
    // real assertion. This one says it out loud, including the shapes a caller
    // passes when the reader found no date at all.
    const READ = { state: "READ", stateReason: null, duplicateOfId: null };
    assert.deepEqual(routeState(clean, NO_HITS, true), READ);
    assert.deepEqual(routeState({ ...clean, dateStr: null, referenceDay: ARRIVAL }, NO_HITS, true), READ);
    assert.deepEqual(routeState({ ...clean, ...badDate, referenceDay: null }, NO_HITS, true), READ);
    assert.deepEqual(routeState({ ...clean, dateStr: "2026-09-17", referenceDay: ARRIVAL }, NO_HITS, true), READ);
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

test("the tax warning is read from its OWN column, not from stateReason", () => {
    // THE ROUND-20 FINDING. Routing wrote the marker into `stateReason`, and
    // a deferred booking then replaced that column with `push-disabled` or
    // `push-paused` -- which is EVERY row during the disabled-push cutover.
    // The BOOKED transition read the marker out of whatever the column held at
    // that moment, so the evidence was already gone. It has its own column
    // now, written once by routing and touched by nothing else.
    assert.equal(
        preservedTaxWarning({ taxWarning: "tax-implausible", stateReason: "push-disabled" }),
        "tax-implausible",
        "a deferred booking cannot erase it",
    );
    assert.equal(
        preservedTaxWarning({ taxWarning: "tax-implausible", stateReason: null }),
        "tax-implausible",
    );
    assert.equal(
        preservedTaxWarning({ taxWarning: null, stateReason: "push-paused" }),
        null,
        "and a defer reason is still not a warning",
    );

    // PRE-FIX CONTROL: reading `stateReason` alone loses it the moment a
    // defer reason lands there. This is the shipped behaviour, restated.
    assert.equal(
        preservedTaxWarning({ stateReason: "push-disabled" }),
        null,
        "the old source of truth says the receipt had a clean tax read",
    );

    // THE FALLBACK, for rows already mid-flight when the column was added: one
    // sitting in BOOKING with the marker in the old place must not lose it at
    // deploy time.
    assert.equal(
        preservedTaxWarning({ stateReason: "tax-implausible" }),
        "tax-implausible",
    );
    assert.equal(
        preservedTaxWarning({ stateReason: "weak-dup:row-a;tax-implausible" }),
        "tax-implausible",
        "including a compound reason, the way note() builds one",
    );
    assert.equal(preservedTaxWarning({}), null);
    assert.equal(preservedTaxWarning({ taxWarning: null, stateReason: null }), null);
    // A column carrying something ELSE is not the marker.
    assert.equal(preservedTaxWarning({ taxWarning: "something-else" }), null);
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

    await t.test("a weak-dup row resumes at RECEIVED — the re-route is what restores its key", () => {
        // The weak net now clears a pair whose reference numbers already tell
        // them apart (weak-net.ts), so retrying one of these is a re-decision
        // rather than another attempt at the same verdict.
        //
        // RECEIVED, not READ, and the re-read is the point rather than a side
        // effect: rows parked by the OLD code had their dedupStrongKey released
        // on the way in, and ROUTING is the only path that claims one. Sent
        // back to READ they would book still owning no identity, which is the
        // hole this whole round is about.
        assert.equal(retryTargetFor("NEEDS_REVIEW", "weak-dup:abc"), "RECEIVED");
        assert.equal(retryTargetFor("NEEDS_REVIEW", "weak-dup:cmg8x2q0000abcd"), "RECEIVED");
        // Still a prefix rule, not a substring one.
        assert.equal(retryTargetFor("NEEDS_REVIEW", "not-weak-dup:abc"), null);
    });

    await t.test("READ is not a retry target at all", () => {
        // Phase 2's auto re-sweep may want one; phase 1 does not have one, and
        // an unused member of the union is a target `retryReceiptIntake` would
        // happily write without anything having thought about it.
        const targets = new Set(
            ["ai-unavailable", "file-missing", "weak-dup:abc", "qbo-timeout", "qbo-5xx", "max-retries"]
                .map(reason => retryTargetFor("NEEDS_REVIEW", reason)),
        );
        assert.deepEqual([...targets].sort(), ["BOOKING", "RECEIVED"]);
    });

    await t.test("document verdicts are NOT retryable — another attempt parks them again", () => {
        for (const reason of [
            "multi-doc", "no-estimate", "refund-or-zero", "invalid-date", "zero-total",
            // A date this row cannot own is a VERDICT about the document, not a
            // transient failure: re-reading it produces the same misread and
            // spends an attempt and a QuickBooks round trip doing it. It stays
            // non-retryable in phase 1; the repair that would change that is
            // phase 2 work.
            DATE_IMPLAUSIBLE_REASON,
            "strong-dup-amount-mismatch:abc", "vendor-mismatch:abc",
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
