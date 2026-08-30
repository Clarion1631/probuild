/**
 * Unit tests for deriveCrewConflicts(), the pure derivation backing
 * getCrewConflicts() in schedule-core.ts.
 *
 * Gate item: conflicts must come ONLY from TaskAssignment windows, never
 * from project-level crew membership — the auto-crew rule puts every
 * dispatchable user on every In Progress project, so treating membership
 * itself as a scheduling window would manufacture a conflict for the whole
 * roster whenever two active projects' date ranges merely overlap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCrewConflicts, type CrewConflictAssignment } from "../src/lib/crew-conflicts";

const RANGE_FROM = new Date("2026-08-01T00:00:00.000Z");
const RANGE_TO = new Date("2026-09-01T00:00:00.000Z");

function assignment(overrides: Partial<CrewConflictAssignment> & Pick<CrewConflictAssignment, "taskId" | "taskStart" | "taskEnd" | "projectId">): CrewConflictAssignment {
    return {
        userId: "user-1",
        userName: "Ada Lovelace",
        taskName: `Task ${overrides.taskId}`,
        projectName: `Project ${overrides.projectId}`,
        ...overrides,
    };
}

test("two projects sharing a crew member with NO task assignments produce zero conflicts", () => {
    // No TaskAssignment rows at all — only project-level crew membership,
    // which must never be treated as a scheduling window on its own.
    const conflicts = deriveCrewConflicts([], RANGE_FROM, RANGE_TO);
    assert.deepEqual(conflicts, []);
});

test("overlapping task assignments on different projects for the same user produce a conflict", () => {
    const assignments: CrewConflictAssignment[] = [
        assignment({
            taskId: "task-a", projectId: "project-a",
            taskStart: new Date("2026-08-10T00:00:00.000Z"),
            taskEnd: new Date("2026-08-15T00:00:00.000Z"),
        }),
        assignment({
            taskId: "task-b", projectId: "project-b",
            taskStart: new Date("2026-08-12T00:00:00.000Z"),
            taskEnd: new Date("2026-08-20T00:00:00.000Z"),
        }),
    ];

    const conflicts = deriveCrewConflicts(assignments, RANGE_FROM, RANGE_TO);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].userId, "user-1");
    assert.equal(conflicts[0].pairs.length, 1);
    const pair = conflicts[0].pairs[0];
    assert.ok(pair.taskA, "conflict pair must carry taskA");
    assert.ok(pair.taskB, "conflict pair must carry taskB");
    assert.equal(pair.overlapStart, "2026-08-12T00:00:00.000Z");
    assert.equal(pair.overlapEnd, "2026-08-15T00:00:00.000Z");
});

test("non-overlapping task assignments on different projects produce zero conflicts", () => {
    const assignments: CrewConflictAssignment[] = [
        assignment({
            taskId: "task-a", projectId: "project-a",
            taskStart: new Date("2026-08-01T00:00:00.000Z"),
            taskEnd: new Date("2026-08-05T00:00:00.000Z"),
        }),
        assignment({
            taskId: "task-b", projectId: "project-b",
            taskStart: new Date("2026-08-10T00:00:00.000Z"),
            taskEnd: new Date("2026-08-15T00:00:00.000Z"),
        }),
    ];

    const conflicts = deriveCrewConflicts(assignments, RANGE_FROM, RANGE_TO);
    assert.deepEqual(conflicts, []);
});

test("overlapping tasks on the SAME project never count as a conflict", () => {
    const assignments: CrewConflictAssignment[] = [
        assignment({
            taskId: "task-a", projectId: "project-a",
            taskStart: new Date("2026-08-10T00:00:00.000Z"),
            taskEnd: new Date("2026-08-15T00:00:00.000Z"),
        }),
        assignment({
            taskId: "task-b", projectId: "project-a",
            taskStart: new Date("2026-08-12T00:00:00.000Z"),
            taskEnd: new Date("2026-08-20T00:00:00.000Z"),
        }),
    ];

    const conflicts = deriveCrewConflicts(assignments, RANGE_FROM, RANGE_TO);
    assert.deepEqual(conflicts, []);
});

test("overlap outside the [from, to) visible range is excluded", () => {
    const assignments: CrewConflictAssignment[] = [
        assignment({
            taskId: "task-a", projectId: "project-a",
            taskStart: new Date("2026-07-01T00:00:00.000Z"),
            taskEnd: new Date("2026-07-10T00:00:00.000Z"),
        }),
        assignment({
            taskId: "task-b", projectId: "project-b",
            taskStart: new Date("2026-07-05T00:00:00.000Z"),
            taskEnd: new Date("2026-07-08T00:00:00.000Z"),
        }),
    ];

    const conflicts = deriveCrewConflicts(assignments, RANGE_FROM, RANGE_TO);
    assert.deepEqual(conflicts, []);
});

test("different users on overlapping tasks never conflict with each other", () => {
    const assignments: CrewConflictAssignment[] = [
        assignment({
            userId: "user-1", taskId: "task-a", projectId: "project-a",
            taskStart: new Date("2026-08-10T00:00:00.000Z"),
            taskEnd: new Date("2026-08-15T00:00:00.000Z"),
        }),
        assignment({
            userId: "user-2", taskId: "task-b", projectId: "project-b",
            taskStart: new Date("2026-08-10T00:00:00.000Z"),
            taskEnd: new Date("2026-08-15T00:00:00.000Z"),
        }),
    ];

    const conflicts = deriveCrewConflicts(assignments, RANGE_FROM, RANGE_TO);
    assert.deepEqual(conflicts, []);
});
