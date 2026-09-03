import assert from "node:assert/strict";
import test from "node:test";
import {
    addDaysKey,
    daysBetweenKeys,
    displayEndDate,
    durationDays,
    formatDateKey,
    isTaskOnDay,
    storedEndDate,
} from "@/lib/schedule-dates";

test("stored end is the day after the last day of work; display is the last day", () => {
    // One-day task on 9/3: stored 9/3..9/4, shown as End 9/3.
    assert.equal(storedEndDate("2026-09-03", "2026-09-03"), "2026-09-04");
    assert.equal(displayEndDate("2026-09-03", "2026-09-04"), "2026-09-03");
    // Five-day task 9/3..9/7 as the user sees it.
    assert.equal(storedEndDate("2026-09-03", "2026-09-07"), "2026-09-08");
    assert.equal(displayEndDate("2026-09-03", "2026-09-08"), "2026-09-07");
    assert.equal(durationDays("2026-09-03", "2026-09-08"), 5);
});

test("round trip is stable and month boundaries are handled in UTC", () => {
    for (const [start, shown] of [["2026-09-28", "2026-09-30"], ["2026-12-31", "2027-01-02"], ["2028-02-28", "2028-02-29"]]) {
        assert.equal(displayEndDate(start, storedEndDate(start, shown)), shown);
    }
    assert.equal(addDaysKey("2026-09-30", 1), "2026-10-01");
    assert.equal(daysBetweenKeys("2026-09-03", "2026-09-08"), 5);
});

test("legacy zero-length rows (end == start) display and count as one day", () => {
    assert.equal(displayEndDate("2026-09-03", "2026-09-03"), "2026-09-03");
    assert.equal(durationDays("2026-09-03", "2026-09-03"), 1);
    assert.equal(isTaskOnDay("2026-09-03", "2026-09-03", "2026-09-03"), true);
    assert.equal(isTaskOnDay("2026-09-03", "2026-09-03", "2026-09-04"), false);
});

test("a display end on or before the start becomes a one-day task", () => {
    assert.equal(storedEndDate("2026-09-03", "2026-09-01"), "2026-09-04");
    assert.equal(storedEndDate("2026-09-03", "2026-09-03"), "2026-09-04");
});

test("milestones keep end == start in both directions", () => {
    assert.equal(storedEndDate("2026-09-03", "2026-09-09", "milestone"), "2026-09-03");
    assert.equal(displayEndDate("2026-09-03", "2026-09-03", "milestone"), "2026-09-03");
    assert.equal(durationDays("2026-09-03", "2026-09-03", "milestone"), 1);
    assert.equal(isTaskOnDay("2026-09-03", "2026-09-03", "2026-09-03", "milestone"), true);
});

test("full ISO timestamps are accepted and reduced to their date part", () => {
    assert.equal(displayEndDate("2026-09-03T00:00:00.000Z", "2026-09-08T00:00:00.000Z"), "2026-09-07");
    assert.equal(isTaskOnDay("2026-09-03T00:00:00.000Z", "2026-09-08T00:00:00.000Z", "2026-09-07"), true);
    assert.equal(isTaskOnDay("2026-09-03T00:00:00.000Z", "2026-09-08T00:00:00.000Z", "2026-09-08"), false);
});

test("formatDateKey formats a date key without local-timezone drift", () => {
    // Anchored to UTC midnight and formatted with timeZone: "UTC", so this is
    // stable regardless of process.env.TZ.
    assert.equal(formatDateKey("2026-09-03", { month: "short", day: "numeric" }), "Sep 3");
});
