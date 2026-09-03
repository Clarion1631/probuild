import assert from "node:assert/strict";
import test from "node:test";
import {
    addDaysKey,
    daysBetweenKeys,
    displayEndDate,
    durationDays,
    formatDateKey,
    isTaskOnDay,
    isTaskOverdue,
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

test("a display end on the start day is a one-day task; before the start is left invalid for the server", () => {
    assert.equal(storedEndDate("2026-09-03", "2026-09-03"), "2026-09-04");
    // 9/1 shown -> stored 9/2, which is <= start 9/3 and fails validation
    // instead of being silently turned into a one-day task.
    assert.equal(storedEndDate("2026-09-03", "2026-09-01"), "2026-09-02");
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

test("overdue means the last working day is behind us", () => {
    // Task 9/3..9/7 shown, stored end 9/8: not overdue on 9/7, overdue from 9/8.
    assert.equal(isTaskOverdue("2026-09-03", "2026-09-08", "2026-09-07"), false);
    assert.equal(isTaskOverdue("2026-09-03", "2026-09-08", "2026-09-08"), true);
    // Legacy zero-length row counts as one day.
    assert.equal(isTaskOverdue("2026-09-03", "2026-09-03", "2026-09-03"), false);
    assert.equal(isTaskOverdue("2026-09-03", "2026-09-03", "2026-09-04"), true);
    // Milestones are not overdue on their own day.
    assert.equal(isTaskOverdue("2026-09-03", "2026-09-03", "2026-09-03", "milestone"), false);
    assert.equal(isTaskOverdue("2026-09-03", "2026-09-03", "2026-09-04", "milestone"), true);
    assert.equal(isTaskOverdue("2026-09-03T00:00:00.000Z", "2026-09-08T00:00:00.000Z", new Date("2026-09-09T15:00:00Z")), true);
});

test("formatDateKey formats a date key without local-timezone drift", () => {
    // Anchored to UTC midnight and formatted with timeZone: "UTC", so this is
    // stable regardless of process.env.TZ.
    assert.equal(formatDateKey("2026-09-03", { month: "short", day: "numeric" }), "Sep 3");
});
