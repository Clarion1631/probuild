/**
 * Unit tests for buildMobileScheduleWhere(), the pure helper backing the
 * per-role scoping in GET /api/mobile/schedule/today.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMobileScheduleWhere } from "../src/lib/mobile-schedule-scope";

const range = {
    start: new Date("2026-08-27T00:00:00.000Z"),
    end: new Date("2026-08-29T23:59:59.999Z"),
};

test("ADMIN gets no OR/assignment clause (full access)", () => {
    const where = buildMobileScheduleWhere({ id: "u1", role: "ADMIN" }, range);
    assert.deepEqual(where, {
        startDate: { lte: range.end },
        endDate: { gte: range.start },
    });
    assert.equal("OR" in where, false);
    assert.equal("assignments" in where, false);
});

test("MANAGER gets no OR/assignment clause (full access)", () => {
    const where = buildMobileScheduleWhere({ id: "u2", role: "MANAGER" }, range);
    assert.deepEqual(where, {
        startDate: { lte: range.end },
        endDate: { gte: range.start },
    });
    assert.equal("OR" in where, false);
    assert.equal("assignments" in where, false);
});

test("FIELD_CREW is scoped to their own assignments only", () => {
    const where = buildMobileScheduleWhere({ id: "u3", role: "FIELD_CREW" }, range);
    assert.deepEqual(where, {
        startDate: { lte: range.end },
        endDate: { gte: range.start },
        assignments: { some: { userId: "u3" } },
    });
    assert.equal("OR" in where, false);
});

test("FINANCE is treated like FIELD_CREW: scoped to their own assignments only", () => {
    const where = buildMobileScheduleWhere({ id: "u4", role: "FINANCE" }, range);
    assert.deepEqual(where, {
        startDate: { lte: range.end },
        endDate: { gte: range.start },
        assignments: { some: { userId: "u4" } },
    });
    assert.equal("OR" in where, false);
});
