import assert from "node:assert/strict";
import { test } from "node:test";

import { CLIENT_STAGE_LABELS, clientStageIndex } from "../src/lib/client-stages";
import { buildProjectTracker, type PortalTrackerTask } from "../src/lib/portal-tracker";

function task(overrides: Partial<PortalTrackerTask> = {}): PortalTrackerTask {
    return {
        id: "task-1",
        name: "Framing inspection prep",
        startDate: "2026-08-26",
        endDate: "2026-08-27",
        color: "#4c9a2a",
        progress: 50,
        status: "In Progress",
        type: "task",
        order: 1,
        costCodeName: null,
        clientStage: "Framing",
        scheduledTime: null,
        confirmationStatus: null,
        assignments: [],
        subAssignments: [],
        ...overrides,
    };
}

test("Inspections is the ninth stage immediately before Complete", () => {
    assert.equal(CLIENT_STAGE_LABELS.length, 9);
    assert.deepEqual(CLIENT_STAGE_LABELS.slice(-2), ["Inspections", "Complete"]);
    assert.equal(clientStageIndex("Inspections"), 7);
    assert.equal(clientStageIndex("Complete"), 8);
});

test("a client-shared scheduled inspection advances the automatic tracker to Inspections", () => {
    const tracker = buildProjectTracker([task()], null, true);
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Inspections");
});

test("an unshared scheduled inspection cannot affect the client tracker", () => {
    const tracker = buildProjectTracker([task()], null, false);
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Framing");
});

test("schedule task names and clientStage values cannot derive the Inspections stage", () => {
    const tracker = buildProjectTracker([
        task({ name: "Final inspection", clientStage: "Inspections", costCodeName: "Inspection" }),
    ], null, false);
    const current = tracker.stages.find(stage => stage.state === "current");
    const inspections = tracker.stages.find(stage => stage.label === "Inspections");
    assert.notEqual(current?.label, "Inspections");
    assert.equal(inspections?.taskCount, 0);
});

test("a shared scheduled inspection prevents a completed schedule from reporting Complete", () => {
    const tracker = buildProjectTracker([task({ status: "Complete", progress: 100 })], null, true);
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Inspections");
    assert.notEqual(tracker.stages.find(stage => stage.label === "Complete")?.state, "current");
});

test("a shared scheduled inspection caps a later staff override at Inspections", () => {
    const tracker = buildProjectTracker([task({ status: "Complete", progress: 100 })], "Complete", true);
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Inspections");
    assert.notEqual(tracker.stages.find(stage => stage.label === "Complete")?.state, "current");
});
