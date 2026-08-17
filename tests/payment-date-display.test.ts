import assert from "node:assert/strict";
import test from "node:test";
import {
    isDateOnly,
    formatMoneyDate,
    formatMoneyMonth,
    formatMoneyMonthKey,
    formatMoneyDateISO,
    parsePaymentDateInput,
} from "../src/lib/payment-date";

// These tests only mean something in a west-of-UTC zone — that is where a stored
// calendar day (UTC midnight) rendered as the PREVIOUS day. Run under TZ=America/Los_Angeles.
const PT = process.env.TZ === "America/Los_Angeles";

// Real shapes observed in prod:
//   manual entry (parsePaymentDateInput -> midnight UTC, in every environment)
const MANUAL_JUL_28 = "2026-07-28T00:00:00.000Z";
//   QuickBooks import (paidAt copied into paymentDate) — noon UTC, a real instant
const QBO_JUL_20 = "2026-07-20T12:00:00.000Z";
//   Stripe webhook (new Date()) — 5:30pm PT on Jul 28 is Jul 29 in UTC
const STRIPE_JUL_28_PT = "2026-07-29T00:30:00.000Z";

test("isDateOnly distinguishes stored calendar days from real instants", () => {
    assert.equal(isDateOnly(new Date(MANUAL_JUL_28)), true);
    assert.equal(isDateOnly(new Date(QBO_JUL_20)), false);
    assert.equal(isDateOnly(new Date(STRIPE_JUL_28_PT)), false);
});

test("a manually recorded calendar day keeps its picked day (the reported bug)", () => {
    // Regression: this rendered "Jul 27, 2026" for Pacific viewers.
    assert.equal(formatMoneyDate(MANUAL_JUL_28), "Jul 28, 2026");
    assert.equal(formatMoneyDate("2026-07-22T00:00:00.000Z"), "Jul 22, 2026");
    // Accepts a Date as well as an ISO string.
    assert.equal(formatMoneyDate(new Date(MANUAL_JUL_28)), "Jul 28, 2026");
});

test("real instants still render in the viewer's local zone", () => {
    // QBO noon-UTC lands on the same calendar day either way.
    assert.equal(formatMoneyDate(QBO_JUL_20), "Jul 20, 2026");
    if (PT) {
        // A Stripe payment taken at 5:30pm PT on Jul 28 must NOT show as Jul 29.
        assert.equal(formatMoneyDate(STRIPE_JUL_28_PT), "Jul 28, 2026");
    }
});

test("null, undefined and malformed input render as empty, never 'Invalid Date'", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
        assert.equal(formatMoneyDate(bad as never), "");
    }
    assert.equal(formatMoneyDate(new Date("nope")), "");
});

test("month bucket key and label always agree", () => {
    for (const v of [MANUAL_JUL_28, QBO_JUL_20, STRIPE_JUL_28_PT, "2026-08-01T00:00:00.000Z"]) {
        const d = new Date(v);
        const [year, month] = formatMoneyMonthKey(d).split("-");
        const label = formatMoneyMonth(d);
        assert.ok(
            label.includes(year),
            `key ${formatMoneyMonthKey(d)} and label "${label}" disagree on year for ${v}`,
        );
        const monthName = new Date(Date.UTC(2026, Number(month) - 1, 15))
            .toLocaleString("en-US", { month: "long", timeZone: "UTC" });
        assert.ok(
            label.startsWith(monthName),
            `key ${formatMoneyMonthKey(d)} and label "${label}" disagree on month for ${v}`,
        );
    }
});

test("a first-of-month calendar day does not fall into the previous month", () => {
    // Sales-tax remittance is monthly — an Aug 1 payment must not group into July.
    const augFirst = new Date("2026-08-01T00:00:00.000Z");
    assert.equal(formatMoneyMonthKey(augFirst), "2026-08");
    assert.equal(formatMoneyMonth(augFirst), "August 2026");
    assert.equal(formatMoneyDateISO(augFirst), "2026-08-01");
});

test("CSV export writes the picked calendar day", () => {
    assert.equal(formatMoneyDateISO(new Date(MANUAL_JUL_28)), "2026-07-28");
    assert.equal(formatMoneyDateISO(new Date("2026-07-22T00:00:00.000Z")), "2026-07-22");
});

// ---------------------------------------------------------------------------
// parsePaymentDateInput — the WRITER of the calendar-day sentinel that isDateOnly
// reads. These two must agree, or a picked day is silently reclassified as an
// instant and renders as the day before to a Pacific viewer.
// ---------------------------------------------------------------------------

test("the writer's calendar day satisfies the reader's predicate (round-trip)", () => {
    // Regression: parsePaymentDateInput used to build LOCAL midnight, so in any
    // non-UTC zone this produced e.g. 07:00Z and isDateOnly returned FALSE. The
    // sentinel was correct on Vercel (UTC) purely by accident of deployment zone.
    for (const day of ["2026-07-28", "2026-01-01", "2026-12-31", "2026-08-04"]) {
        const stored = parsePaymentDateInput(day);
        assert.ok(stored, `${day} should parse`);
        assert.equal(isDateOnly(stored), true, `${day} must be classified as a calendar day`);
        assert.equal(formatMoneyDateISO(stored), day, `${day} must round-trip unchanged`);
    }
});

test("a picked day renders as that same day, not the day before", () => {
    const stored = parsePaymentDateInput("2026-08-04");
    assert.ok(stored);
    assert.equal(stored.toISOString(), "2026-08-04T00:00:00.000Z");
    assert.equal(formatMoneyDate(stored), "Aug 4, 2026");
    if (PT) {
        // The whole point: under Pacific rendering it is still Aug 4.
        assert.equal(formatMoneyDateISO(stored), "2026-08-04");
    }
});

test("real instants are preserved verbatim and stay classified as instants", () => {
    // ISO datetime (API callers) and epoch millis (Stripe/QBO) are NOT calendar days.
    const iso = parsePaymentDateInput("2026-04-20T14:30:00Z");
    assert.ok(iso);
    assert.equal(iso.toISOString(), "2026-04-20T14:30:00.000Z");
    assert.equal(isDateOnly(iso), false);

    const ms = parsePaymentDateInput(Date.UTC(2026, 6, 20, 12, 0, 0));
    assert.ok(ms);
    assert.equal(ms.toISOString(), "2026-07-20T12:00:00.000Z");
    assert.equal(isDateOnly(ms), false);
});

test("an ISO datetime that happens to land on UTC midnight is left alone", () => {
    // Deliberate: the sentinel is lossy by design — an instant exactly at UTC midnight
    // is indistinguishable from a calendar day. Documented so the ambiguity is a known
    // property rather than a surprise. It renders as that day either way.
    const midnightInstant = parsePaymentDateInput("2026-05-21T00:00:00Z");
    assert.ok(midnightInstant);
    assert.equal(isDateOnly(midnightInstant), true);
    assert.equal(formatMoneyDateISO(midnightInstant), "2026-05-21");
});

test("invalid and out-of-range input is rejected, never coerced to a wrong day", () => {
    for (const bad of ["", "   ", "not-a-date", "2026-13-01", "2026-00-10", "2026-07-32"]) {
        assert.equal(parsePaymentDateInput(bad), null, `${JSON.stringify(bad)} must be rejected`);
    }
    // Overflow must not silently roll forward into the next month.
    assert.equal(parsePaymentDateInput("2026-02-31"), null);
    assert.equal(parsePaymentDateInput(0), null);
    assert.equal(parsePaymentDateInput(-1), null);
    assert.equal(parsePaymentDateInput(NaN), null);
});

test("a leap day is accepted in a leap year and rejected otherwise", () => {
    const leap = parsePaymentDateInput("2028-02-29");
    assert.ok(leap);
    assert.equal(formatMoneyDateISO(leap), "2028-02-29");
    assert.equal(parsePaymentDateInput("2026-02-29"), null);
});

test("an offset-less ISO datetime is rejected, not silently read in the host zone", () => {
    // Regression (Codex round 1): ECMAScript parses a date-TIME string without a zone
    // designator in the HOST's local zone, so "2026-08-04T14:30:00" stored 14:30Z on
    // Vercel and 21:30Z in Pacific dev. Ambiguous input must fail loudly.
    for (const ambiguous of [
        "2026-08-04T14:30:00",
        "2026-08-04T14:30",
        "2026-08-04T14:30:00.500",
        "Aug 4, 2026 2:30 PM",
    ]) {
        assert.equal(parsePaymentDateInput(ambiguous), null, `${ambiguous} must be rejected`);
    }
});

test("an ISO datetime WITH an explicit zone is accepted and exact", () => {
    const cases = [
        ["2026-08-04T14:30:00Z", "2026-08-04T14:30:00.000Z"],
        ["2026-08-04T14:30:00z", "2026-08-04T14:30:00.000Z"],
        ["2026-08-04T14:30:00.250Z", "2026-08-04T14:30:00.250Z"],
        ["2026-08-04T07:30:00-07:00", "2026-08-04T14:30:00.000Z"], // Pacific daylight
        ["2026-08-04T14:30:00+0000", "2026-08-04T14:30:00.000Z"],
    ];
    for (const [input, expected] of cases) {
        const got = parsePaymentDateInput(input);
        assert.ok(got, `${input} should parse`);
        assert.equal(got.toISOString(), expected, `${input} must be exact`);
    }
});
