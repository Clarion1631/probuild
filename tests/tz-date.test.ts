/**
 * Pure time-zone/date primitives (src/lib/tz-date.ts) — no prisma, no
 * database required. These back overtime.ts and the manager dashboard's
 * DST-correct week-boundary math.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addCalendarDaysInTimeZone,
    addDaysToKey,
    dayKeyInTimeZone,
    startOfDateInTimeZone,
    endOfDateInTimeZone,
} from "../src/lib/tz-date";

const TZ = "America/Los_Angeles";

test("dayKeyInTimeZone honors the time zone parameter — the same instant can read as different days in different zones", () => {
    const instant = new Date("2026-08-17T06:30:00.000Z");
    assert.equal(dayKeyInTimeZone(instant, "America/Los_Angeles"), "2026-08-16");
    assert.equal(dayKeyInTimeZone(instant, "America/New_York"), "2026-08-17");
});

test("addCalendarDaysInTimeZone advances 7 CALENDAR days, not a fixed 168 hours, across the Nov 2026 DST fall-back", () => {
    // Clocks fall back in America/Los_Angeles on 2026-11-01 (2am PDT -> 1am
    // PST), so the week starting Mon 2026-10-26 00:00 PT has 169 real hours,
    // not 168.
    const weekStart = startOfDateInTimeZone("2026-10-26", TZ);
    const nextWeekStart = addCalendarDaysInTimeZone(weekStart, 7, TZ);

    assert.equal(dayKeyInTimeZone(nextWeekStart, TZ), "2026-11-02");
    // Still exactly local midnight, not shifted by the DST hour.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(nextWeekStart);
    assert.equal(parts, "00:00");

    const spanHours = (nextWeekStart.getTime() - weekStart.getTime()) / 3_600_000;
    assert.equal(spanHours, 169); // NOT 168 — this is exactly the bug a fixed-ms offset gets wrong.
});

test("addCalendarDaysInTimeZone preserves the local wall-clock time of day across a DST transition", () => {
    // 2026-10-26 14:30 PT (before fall-back) + 7 days should still read
    // 14:30 PT the following week, not 13:30 or 15:30.
    const start = new Date(startOfDateInTimeZone("2026-10-26", TZ).getTime() + 14.5 * 3_600_000);
    const later = addCalendarDaysInTimeZone(start, 7, TZ);
    const timeOfDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(later);
    assert.equal(timeOfDay, "14:30");
    assert.equal(dayKeyInTimeZone(later, TZ), "2026-11-02");
});

test("addCalendarDaysInTimeZone with a non-multiple-of-7 offset still lands on the correct calendar day", () => {
    const start = startOfDateInTimeZone("2026-08-10", TZ);
    const plus3 = addCalendarDaysInTimeZone(start, 3, TZ);
    assert.equal(dayKeyInTimeZone(plus3, TZ), "2026-08-13");
    const minus3 = addCalendarDaysInTimeZone(start, -3, TZ);
    assert.equal(dayKeyInTimeZone(minus3, TZ), "2026-08-07");
});

test("addDaysToKey is pure calendar-key arithmetic, unaffected by any time zone", () => {
    assert.equal(addDaysToKey("2026-08-10", 7), "2026-08-17");
    assert.equal(addDaysToKey("2026-08-10", -3), "2026-08-07");
    assert.equal(addDaysToKey("2026-02-25", 5), "2026-03-02"); // month rollover
});

test("startOfDateInTimeZone lands on the correct calendar date even when local midnight is skipped by a DST transition (Africa/Casablanca)", () => {
    // Morocco's clocks jump directly from 23:59:59 to 01:00:00 on 2009-06-01
    // — local midnight that day never happens. A naive fixed-point offset
    // iteration converges to 2009-05-31T23:00:00Z, which reads back as
    // 23:00 on May 31 in Casablanca — the WRONG calendar day, silently.
    const start = startOfDateInTimeZone("2009-06-01", "Africa/Casablanca");
    assert.equal(dayKeyInTimeZone(start, "Africa/Casablanca"), "2009-06-01");
});

test("startOfDateInTimeZone and endOfDateInTimeZone bracket a full company-local day", () => {
    const start = startOfDateInTimeZone("2026-08-10", TZ);
    const end = endOfDateInTimeZone("2026-08-10", TZ);
    assert.equal(dayKeyInTimeZone(start, TZ), "2026-08-10");
    assert.equal(dayKeyInTimeZone(end, TZ), "2026-08-10");
    assert.ok(end.getTime() > start.getTime());
    assert.ok(end.getTime() - start.getTime() < 86_400_000); // 23:59:59.999, just under 24h
});
