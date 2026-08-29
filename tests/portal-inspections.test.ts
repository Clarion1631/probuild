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

test("Inspections is not a client tracker stage", () => {
    assert.equal(CLIENT_STAGE_LABELS.length, 8);
    assert.deepEqual(CLIENT_STAGE_LABELS.slice(-2), ["Punch list", "Complete"]);
    assert.equal(clientStageIndex("Inspections"), null);
    assert.equal(clientStageIndex("Complete"), 7);
});

test("inspection records do not participate in automatic tracker state", () => {
    const tracker = buildProjectTracker([task()]);
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Framing");
});

test("a stale Inspections clientStage value cannot create a tracker stage", () => {
    const tracker = buildProjectTracker([
        task({ name: "Final inspection", clientStage: "Inspections", costCodeName: "Inspection" }),
    ]);
    const current = tracker.stages.find(stage => stage.state === "current");
    const inspections = tracker.stages.find(stage => stage.label === "Inspections");
    assert.notEqual(current?.label, "Inspections");
    assert.equal(inspections, undefined);
});

test("a completed schedule reports Complete", () => {
    const tracker = buildProjectTracker([task({ status: "Complete", progress: 100 })]);
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Complete");
});

test("a staff override can pin the tracker at Complete", () => {
    const tracker = buildProjectTracker([task({ status: "Complete", progress: 100 })], "Complete");
    const current = tracker.stages.find(stage => stage.state === "current");
    assert.equal(current?.label, "Complete");
});
