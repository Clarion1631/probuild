import assert from "node:assert/strict";
import test from "node:test";
import { visibleWeekChips, WEEK_CELL_MAX_CHIPS } from "@/app/company-dashboard/schedule-board/DispatchView";

function chip(over: Record<string, unknown> = {}) {
    return {
        project: { id: "p1", name: "Project", color: "#123456" },
        task: { id: "t1", name: "Task" },
        solid: true,
        lead: false,
        ...over,
    } as unknown as Parameters<typeof visibleWeekChips>[0][number];
}

test("soft-only chips render nothing", () => {
    const chips = [
        chip({ task: { id: "t1" }, solid: false }),
        chip({ task: { id: "t2" }, solid: false }),
    ];
    const result = visibleWeekChips(chips);
    assert.equal(result.chips.length, 0);
    assert.equal(result.overflow, 0);
});

test("empty cell stays empty", () => {
    const result = visibleWeekChips([]);
    assert.equal(result.chips.length, 0);
    assert.equal(result.overflow, 0);
});

test("solid chips pass through up to the cap, mixed with soft ones ignored", () => {
    const chips = [
        chip({ task: { id: "t1" }, solid: true }),
        chip({ task: { id: "t2" }, solid: false }),
        chip({ task: { id: "t3" }, solid: true }),
    ];
    const result = visibleWeekChips(chips);
    assert.equal(result.chips.length, 2);
    assert.deepEqual(result.chips.map(c => c.task.id), ["t1", "t3"]);
    assert.equal(result.overflow, 0);
});

test("more than the cap of solid chips overflow into a count", () => {
    const chips = Array.from({ length: WEEK_CELL_MAX_CHIPS + 2 }, (_, i) => chip({ task: { id: `t${i + 1}` }, solid: true }));
    const result = visibleWeekChips(chips);
    assert.equal(result.chips.length, WEEK_CELL_MAX_CHIPS);
    assert.deepEqual(result.chips.map(c => c.task.id), chips.slice(0, WEEK_CELL_MAX_CHIPS).map(c => c.task.id));
    assert.equal(result.overflow, 2);
});

test("lead flag is preserved on shown chips", () => {
    const chips = [chip({ task: { id: "t1" }, solid: true, lead: true })];
    const result = visibleWeekChips(chips);
    assert.equal(result.chips[0].lead, true);
});
