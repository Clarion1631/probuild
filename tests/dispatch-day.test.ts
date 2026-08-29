/**
 * Unit tests for the Dispatch Day lens's pure day-key helpers
 * (shiftDayKey, formatDayLabel, isTodayKey). See
 * src/app/company-dashboard/schedule-board/dispatch-day.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftDayKey, formatDayLabel, isTodayKey } from "../src/app/company-dashboard/schedule-board/dispatch-day";

test("shiftDayKey: +1 day within a month", () => {
    assert.equal(shiftDayKey("2026-08-15", 1), "2026-08-16");
});

test("shiftDayKey: -1 day within a month", () => {
    assert.equal(shiftDayKey("2026-08-15", -1), "2026-08-14");
});

test("shiftDayKey: month rollover forward", () => {
    assert.equal(shiftDayKey("2026-08-31", 1), "2026-09-01");
});

test("shiftDayKey: month rollover backward", () => {
    assert.equal(shiftDayKey("2026-09-01", -1), "2026-08-31");
});

test("shiftDayKey: year rollover forward", () => {
    assert.equal(shiftDayKey("2026-12-31", 1), "2027-01-01");
});

test("shiftDayKey: year rollover backward", () => {
    assert.equal(shiftDayKey("2027-01-01", -1), "2026-12-31");
});

test("shiftDayKey: leap-day rollover (2028 is a leap year)", () => {
    assert.equal(shiftDayKey("2028-02-28", 1), "2028-02-29");
    assert.equal(shiftDayKey("2028-02-29", 1), "2028-03-01");
});

test("shiftDayKey: negative multi-day delta", () => {
    assert.equal(shiftDayKey("2026-08-15", -20), "2026-07-26");
});

test("shiftDayKey: zero delta is a no-op", () => {
    assert.equal(shiftDayKey("2026-08-15", 0), "2026-08-15");
});

test("formatDayLabel: formats as weekday, short month, day", () => {
    // 2026-08-29 is a Saturday.
    assert.equal(formatDayLabel("2026-08-29"), "Saturday, Aug 29");
});

test("formatDayLabel: no year in the label", () => {
    assert.ok(!formatDayLabel("2026-08-29").includes("2026"));
});

test("isTodayKey: matching keys", () => {
    assert.equal(isTodayKey("2026-08-29", "2026-08-29"), true);
});

test("isTodayKey: non-matching keys", () => {
    assert.equal(isTodayKey("2026-08-28", "2026-08-29"), false);
});
