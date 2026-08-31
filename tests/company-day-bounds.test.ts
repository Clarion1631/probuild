/**
 * companyDayBounds (src/lib/company-day.ts): the half-open UTC window of a company-local
 * (America/Los_Angeles) calendar day. Used to put a company-day condition into a database
 * WHERE (the owner time-entry delete, src/lib/wa-breaks-db.ts). Checked against
 * toCompanyDayKey — the two must agree exactly at both edges, including across DST.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { companyDayBounds, toCompanyDayKey } from "../src/lib/company-day";

const DAYS = [
    "2026-08-30", // PDT, ordinary
    "2026-03-08", // spring forward (02:00 PST → 03:00 PDT): a 23-hour day
    "2026-03-07", // day before spring forward — its END is the DST switch
    "2026-11-01", // fall back: a 25-hour day
    "2026-10-31", // day before fall back
    "2026-12-31", // PST, year boundary
    "2026-02-28", // month boundary into a non-leap March
];

for (const day of DAYS) {
    test(`bounds of ${day} agree with toCompanyDayKey at both edges`, () => {
        const { start, end } = companyDayBounds(day);
        assert.equal(toCompanyDayKey(start), day, "start is on the day");
        assert.notEqual(toCompanyDayKey(new Date(start.getTime() - 1)), day, "1ms before start is the previous day");
        assert.notEqual(toCompanyDayKey(end), day, "end is the next day (half-open)");
        assert.equal(toCompanyDayKey(new Date(end.getTime() - 1)), day, "1ms before end is still the day");
    });
}

test("DST days are 23 and 25 hours long; ordinary days 24", () => {
    const hours = (d: string) => (companyDayBounds(d).end.getTime() - companyDayBounds(d).start.getTime()) / 3_600_000;
    assert.equal(hours("2026-08-30"), 24);
    assert.equal(hours("2026-03-08"), 23);
    assert.equal(hours("2026-11-01"), 25);
});

test("Pacific midnight is 07:00Z in summer and 08:00Z in winter", () => {
    assert.equal(companyDayBounds("2026-08-30").start.toISOString(), "2026-08-30T07:00:00.000Z");
    assert.equal(companyDayBounds("2026-12-31").start.toISOString(), "2026-12-31T08:00:00.000Z");
});
