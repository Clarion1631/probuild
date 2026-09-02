/**
 * `Expense.date` is a COMPANY CALENDAR DAY (Codex round 6, item 1).
 *
 * Every writer stored it differently — UTC midnight from the QBO sync, UTC
 * midnight from `new Date("2026-07-01")` on the API routes, the SERVER's noon
 * from receipt-ingest — while the tax report filters on company-midnight bounds
 * and buckets with `dayKeyInTimeZone`. In Pacific time that put a 1 July
 * purchase on 30 June and out of Q3 entirely.
 *
 * These are the boundary cases the writers now have to agree on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dateOnlyInTimeZone, dayKeyInTimeZone, startOfDateInTimeZone } from "../src/lib/tz-date";

const PACIFIC = "America/Los_Angeles";

/** What every writer now does with a bare YYYY-MM-DD. */
const store = (day: string) => dateOnlyInTimeZone(day, PACIFIC);

/** What the report does with the stored instant. */
const bucket = (instant: Date) => dayKeyInTimeZone(instant, PACIFIC);

test("the old UTC-midnight shape lands on the WRONG company day", () => {
    // The bug, stated as a test so the fix cannot be undone quietly.
    assert.equal(bucket(new Date("2026-07-01T00:00:00.000Z")), "2026-06-30");
});

test("a stored day round-trips to itself, on both sides of a quarter", () => {
    for (const day of ["2026-06-30", "2026-07-01", "2026-09-30", "2026-10-01", "2026-01-01", "2026-12-31"]) {
        assert.equal(bucket(store(day)), day, day);
    }
});

test("a quarter's first and last day fall INSIDE that quarter's bounds", () => {
    // The report's window is [company midnight of `from`, company midnight of
    // the day AFTER `to`).
    const from = startOfDateInTimeZone("2026-07-01", PACIFIC);
    const to = startOfDateInTimeZone("2026-10-01", PACIFIC);

    const firstDay = store("2026-07-01");
    const lastDay = store("2026-09-30");
    assert.ok(firstDay >= from, "the first day of the quarter must be in it");
    assert.ok(lastDay < to, "and so must the last");

    // ...and the neighbours must stay out.
    assert.ok(store("2026-06-30") < from);
    assert.ok(store("2026-10-01") >= to);
});

test("noon-anchoring survives both DST transitions", () => {
    // Local MIDNIGHT is the fragile choice: a spring-forward zone can have no
    // 00:00 at all. Noon exists on every day in every zone, which is why the
    // shared parser uses it.
    for (const day of ["2026-03-08", "2026-11-01"]) {
        const stored = store(day);
        assert.equal(bucket(stored), day, day);
    }
});

test("a winter day and a summer day use DIFFERENT offsets", () => {
    // Proof the parser is doing zone maths rather than adding a fixed number of
    // hours: PST is UTC-8, PDT is UTC-7.
    assert.equal(store("2026-01-15").toISOString(), "2026-01-15T20:00:00.000Z");
    assert.equal(store("2026-07-15").toISOString(), "2026-07-15T19:00:00.000Z");
});

test("a UTC company sees the same calendar day it stored", () => {
    // The rule is "the company's zone", not "Pacific" — a UTC-configured
    // company must not be shifted either.
    assert.equal(dayKeyInTimeZone(dateOnlyInTimeZone("2026-07-01", "UTC"), "UTC"), "2026-07-01");
});
