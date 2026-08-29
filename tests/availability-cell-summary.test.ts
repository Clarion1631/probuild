/**
 * Unit tests for summarizeCell(), the pure derivation that reduces a day
 * cell's raw booked/soft chip list to what the availability grid renders:
 * booked chips (capped, with a "+N" overflow marker) and a soft-membership
 * count. See AvailabilityPanel.tsx for how this feeds the info-design rules
 * (booked = chip, soft-only = dot + count in title, empty = free).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCell, MAX_VISIBLE_BOOKED_CHIPS, type AvailabilityChip } from "../src/app/company-dashboard/schedule-board/availability";

function chip(overrides: Partial<AvailabilityChip> = {}): AvailabilityChip {
    return {
        kind: "booked",
        projectId: "p1",
        projectName: "Project One",
        projectColor: "#123456",
        taskName: "Framing",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        distanceMilesFromShop: null,
        ...overrides,
    };
}

test("empty cell -> no booked, no soft, no overflow", () => {
    const result = summarizeCell([]);
    assert.deepEqual(result, { booked: [], overflow: 0, softCount: 0 });
});

test("soft-only cell (org auto-adds crew to every job) -> zero chips rendered, softCount carries the signal", () => {
    const chips = [
        chip({ kind: "soft", projectId: "p1", taskName: null }),
        chip({ kind: "soft", projectId: "p2", taskName: null }),
        chip({ kind: "soft", projectId: "p3", taskName: null }),
        chip({ kind: "soft", projectId: "p4", taskName: null }),
        chip({ kind: "soft", projectId: "p5", taskName: null }),
    ];
    const result = summarizeCell(chips);
    assert.deepEqual(result.booked, []);
    assert.equal(result.overflow, 0);
    assert.equal(result.softCount, 5);
});

test("one booked chip, mixed with soft chips from other jobs -> only the booked chip surfaces", () => {
    const chips = [
        chip({ kind: "soft", projectId: "p2", taskName: null }),
        chip({ kind: "booked", projectId: "p1", taskName: "Demo" }),
        chip({ kind: "soft", projectId: "p3", taskName: null }),
    ];
    const result = summarizeCell(chips);
    assert.equal(result.booked.length, 1);
    assert.equal(result.booked[0].taskName, "Demo");
    assert.equal(result.overflow, 0);
    assert.equal(result.softCount, 2);
});

test("booked count at the cap -> all shown, no overflow", () => {
    const chips = [
        chip({ projectId: "p1", taskName: "Demo" }),
        chip({ projectId: "p2", taskName: "Framing" }),
    ];
    const result = summarizeCell(chips);
    assert.equal(result.booked.length, MAX_VISIBLE_BOOKED_CHIPS);
    assert.equal(result.overflow, 0);
});

test("booked count over the cap -> truncates to the cap and reports overflow", () => {
    const chips = [
        chip({ projectId: "p1", taskName: "Demo" }),
        chip({ projectId: "p2", taskName: "Framing" }),
        chip({ projectId: "p3", taskName: "Siding" }),
        chip({ projectId: "p4", taskName: "Paint" }),
    ];
    const result = summarizeCell(chips);
    assert.equal(result.booked.length, MAX_VISIBLE_BOOKED_CHIPS);
    assert.deepEqual(result.booked.map(c => c.taskName), ["Demo", "Framing"]);
    assert.equal(result.overflow, 2);
    assert.equal(result.softCount, 0);
});
