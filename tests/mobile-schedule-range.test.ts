/**
 * Unit tests for resolveScheduleRange(), the pure helper backing
 * GET /api/mobile/schedule/today's optional start/end query params.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScheduleRange } from "../src/lib/mobile-schedule-range";

function params(query: Record<string, string> = {}) {
    return new URLSearchParams(query);
}

test("default (no params) reproduces the original today ± 1 day slop, byte-for-byte", () => {
    const now = new Date("2026-08-28T15:30:00.000Z");

    const expectedStart = new Date(now);
    expectedStart.setHours(0, 0, 0, 0);
    expectedStart.setDate(expectedStart.getDate() - 1);
    const expectedEnd = new Date(now);
    expectedEnd.setHours(23, 59, 59, 999);
    expectedEnd.setDate(expectedEnd.getDate() + 1);

    const result = resolveScheduleRange(params(), now);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.start.getTime(), expectedStart.getTime());
    assert.equal(result.end.getTime(), expectedEnd.getTime());
    assert.equal(result.startKey, expectedStart.toISOString().split("T")[0]);
    assert.equal(result.endKey, expectedEnd.toISOString().split("T")[0]);
});

test("valid explicit range uses UTC day boundaries", () => {
    const now = new Date("2026-08-28T15:30:00.000Z");
    const result = resolveScheduleRange(params({ start: "2026-09-01", end: "2026-09-05" }), now);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.start.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(result.end.toISOString(), "2026-09-05T23:59:59.999Z");
    assert.equal(result.startKey, "2026-09-01");
    assert.equal(result.endKey, "2026-09-05");
});

test("only start given -> 400-shaped error", () => {
    const result = resolveScheduleRange(params({ start: "2026-09-01" }), new Date());
    assert.deepEqual(result, { ok: false, error: "start and end must both be YYYY-MM-DD" });
});

test("only end given -> 400-shaped error", () => {
    const result = resolveScheduleRange(params({ end: "2026-09-01" }), new Date());
    assert.deepEqual(result, { ok: false, error: "start and end must both be YYYY-MM-DD" });
});

test("malformed start -> 400-shaped error", () => {
    const result = resolveScheduleRange(params({ start: "09/01/2026", end: "2026-09-05" }), new Date());
    assert.deepEqual(result, { ok: false, error: "start and end must both be YYYY-MM-DD" });
});

test("malformed end (invalid calendar date) -> 400-shaped error", () => {
    const result = resolveScheduleRange(params({ start: "2026-09-01", end: "2026-02-30" }), new Date());
    assert.deepEqual(result, { ok: false, error: "start and end must both be YYYY-MM-DD" });
});

test("end before start -> clear error", () => {
    const result = resolveScheduleRange(params({ start: "2026-09-05", end: "2026-09-01" }), new Date());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /end.*before.*start|start.*end/i);
});

test("span greater than 14 days -> clear error", () => {
    const result = resolveScheduleRange(params({ start: "2026-09-01", end: "2026-09-16" }), new Date());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /14/);
});

test("exactly 14 days is allowed", () => {
    const result = resolveScheduleRange(params({ start: "2026-09-01", end: "2026-09-14" }), new Date());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.startKey, "2026-09-01");
    assert.equal(result.endKey, "2026-09-14");
});
