/**
 * Washington state weekly overtime: hours over 40 in a single Mon-Sun
 * company-local workweek are paid at 1.5x. No daily overtime.
 *
 * These tests exercise src/lib/overtime.ts directly (pure, no prisma) —
 * no database required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bucketWorkweeks,
    priceWorkweek,
    OVERTIME_MULTIPLIER,
    WA_WEEKLY_OVERTIME_THRESHOLD_HOURS,
    type OvertimeTimeEntry,
} from "../src/lib/overtime";
import { dateOnlyInTimeZone, DEFAULT_COMPANY_TIME_ZONE } from "../src/lib/company-timezone";

const TZ = DEFAULT_COMPANY_TIME_ZONE; // America/Los_Angeles

/** A time entry starting at company-local noon on the given YYYY-MM-DD day. */
function entryOn(day: string, durationHours: number): OvertimeTimeEntry {
    return { startTime: dateOnlyInTimeZone(day, TZ), durationHours };
}

test("39-hour week is entirely regular", () => {
    const [week] = bucketWorkweeks([entryOn("2026-08-10", 39)], TZ); // Monday
    assert.equal(week.totalHours, 39);
    assert.equal(week.regularHours, 39);
    assert.equal(week.overtimeHours, 0);
});

test("40-hour week is entirely regular (threshold itself is not OT)", () => {
    const [week] = bucketWorkweeks([entryOn("2026-08-10", 40)], TZ);
    assert.equal(week.totalHours, 40);
    assert.equal(week.regularHours, 40);
    assert.equal(week.overtimeHours, 0);
});

test("41-hour week pays 1 hour of overtime", () => {
    const [week] = bucketWorkweeks([entryOn("2026-08-10", 41)], TZ);
    assert.equal(week.totalHours, 41);
    assert.equal(week.regularHours, 40);
    assert.equal(week.overtimeHours, 1);
});

test("50-hour week pays 10 hours of overtime", () => {
    const [week] = bucketWorkweeks([entryOn("2026-08-10", 50)], TZ);
    assert.equal(week.totalHours, 50);
    assert.equal(week.regularHours, 40);
    assert.equal(week.overtimeHours, 10);
});

test("an entry straddling the 40h line is split between regular and OT", () => {
    // Mon-Thu: 8h each (running total 32h). Fri: 12h entry crosses the 40h
    // line at hour 8 of that entry (32 + 8 = 40), so it must split 8 regular / 4 OT.
    const entries = [
        entryOn("2026-08-10", 8), // Mon
        entryOn("2026-08-11", 8), // Tue
        entryOn("2026-08-12", 8), // Wed
        entryOn("2026-08-13", 8), // Thu
        entryOn("2026-08-14", 12), // Fri — straddles the boundary
    ];
    const [week] = bucketWorkweeks(entries, TZ);
    assert.equal(week.totalHours, 44);
    assert.equal(week.regularHours, 40);
    assert.equal(week.overtimeHours, 4);

    const fridaySplit = week.entries.find((e) => e.entry.durationHours === 12);
    assert.ok(fridaySplit);
    assert.equal(fridaySplit.regularHours, 8);
    assert.equal(fridaySplit.overtimeHours, 4);

    // Every other entry stayed fully regular.
    for (const split of week.entries) {
        if (split.entry.durationHours === 12) continue;
        assert.equal(split.regularHours, 8);
        assert.equal(split.overtimeHours, 0);
    }

    // Entry-level splits must reconcile to the week totals.
    const sumRegular = week.entries.reduce((s, e) => s + e.regularHours, 0);
    const sumOvertime = week.entries.reduce((s, e) => s + e.overtimeHours, 0);
    assert.equal(sumRegular, week.regularHours);
    assert.equal(sumOvertime, week.overtimeHours);
});

test("entries spanning a week boundary (Sun -> Mon) attribute to the week each entry started in", () => {
    // 2026-08-09 is a Sunday (end of the Mon 08-03..Sun 08-09 workweek).
    // 2026-08-10 is the following Monday (start of the next workweek).
    const entries = [entryOn("2026-08-09", 5), entryOn("2026-08-10", 6)];
    const weeks = bucketWorkweeks(entries, TZ);

    assert.equal(weeks.length, 2);
    const [prevWeek, nextWeek] = weeks;

    assert.equal(prevWeek.weekStartKey, "2026-08-03");
    assert.equal(prevWeek.totalHours, 5);
    assert.equal(prevWeek.entries.length, 1);

    assert.equal(nextWeek.weekStartKey, "2026-08-10");
    assert.equal(nextWeek.totalHours, 6);
    assert.equal(nextWeek.entries.length, 1);
});

test("DST fall-back week (Nov 2026) still buckets Mon-Sun correctly and spans the real 169-hour week", () => {
    // 2026-11-01 (Sun) is the day clocks fall back in America/Los_Angeles:
    // 2am PDT -> 1am PST. The workweek Mon 2026-10-26..Sun 2026-11-01 therefore
    // has 169 wall-clock hours, not the usual 168.
    const entries = [
        entryOn("2026-10-26", 20), // Monday, before the transition
        entryOn("2026-11-01", 22), // Sunday, the transition day itself
        entryOn("2026-11-02", 8), // following Monday — must land in the NEXT week
    ];
    const weeks = bucketWorkweeks(entries, TZ);
    assert.equal(weeks.length, 2);
    const [transitionWeek, nextWeek] = weeks;

    assert.equal(transitionWeek.weekStartKey, "2026-10-26");
    assert.equal(transitionWeek.totalHours, 42);
    assert.equal(transitionWeek.regularHours, 40);
    assert.equal(transitionWeek.overtimeHours, 2);

    assert.equal(nextWeek.weekStartKey, "2026-11-02");
    assert.equal(nextWeek.totalHours, 8);
    assert.equal(nextWeek.overtimeHours, 0);

    // The transition week's real wall-clock span is 169 hours (one extra hour
    // from fall-back), not a naive 7 * 24 = 168. This is the DST-correctness
    // guard: a week boundary computed by adding milliseconds instead of
    // re-resolving the local wall clock would get this wrong.
    const spanHours = (transitionWeek.weekEnd.getTime() - transitionWeek.weekStart.getTime()) / 3_600_000;
    assert.equal(spanHours, 169);

    // weekEnd must exactly equal the next week's weekStart (no gap, no overlap).
    assert.equal(transitionWeek.weekEnd.getTime(), nextWeek.weekStart.getTime());
});

test("bucketWorkweeks skips entries with zero, negative, or non-finite duration (e.g. still clocked in)", () => {
    const entries: OvertimeTimeEntry[] = [
        entryOn("2026-08-10", 8),
        { startTime: dateOnlyInTimeZone("2026-08-10", TZ), durationHours: 0 },
        { startTime: dateOnlyInTimeZone("2026-08-10", TZ), durationHours: -3 },
        { startTime: dateOnlyInTimeZone("2026-08-10", TZ), durationHours: NaN },
    ];
    const [week] = bucketWorkweeks(entries, TZ);
    assert.equal(week.totalHours, 8);
    assert.equal(week.entries.length, 1);
});

test("priceWorkweek applies 1.5x to overtime only, and leaves burden un-multiplied", () => {
    const pay = priceWorkweek({ regularHours: 40, overtimeHours: 5 }, 20, 10);
    assert.equal(OVERTIME_MULTIPLIER, 1.5);
    assert.equal(pay.regularPay, 800); // 40 * 20
    assert.equal(pay.overtimePay, 150); // 5 * 20 * 1.5
    assert.equal(pay.totalPay, 950);
    assert.equal(pay.burdenCost, 450); // (40 + 5) * 10 — no OT premium on burden
});

test("priceWorkweek rounds to cents", () => {
    const pay = priceWorkweek({ regularHours: 3, overtimeHours: 0 }, 33.333, 0);
    assert.equal(pay.regularPay, 100); // 3 * 33.333 = 99.999 -> rounds to 100.00
});

test("a week with no overtime hours prices with zero overtime pay", () => {
    const pay = priceWorkweek({ regularHours: WA_WEEKLY_OVERTIME_THRESHOLD_HOURS - 1, overtimeHours: 0 }, 25, 5);
    assert.equal(pay.overtimePay, 0);
    assert.equal(pay.totalPay, pay.regularPay);
});
