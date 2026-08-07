import assert from "node:assert/strict";
import test from "node:test";
import {
    isDateOnly,
    formatMoneyDate,
    formatMoneyMonth,
    formatMoneyMonthKey,
    formatMoneyDateISO,
} from "../src/lib/payment-date";

// These tests only mean something in a west-of-UTC zone — that is where a stored
// calendar day (UTC midnight) rendered as the PREVIOUS day. Run under TZ=America/Los_Angeles.
const PT = process.env.TZ === "America/Los_Angeles";

// Real shapes observed in prod:
//   manual entry (parsePaymentDateInput -> local midnight, UTC on Vercel)
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
