/**
 * Unit tests for resolveScheduleTaskForPunch's binding decision
 * (src/lib/punch-task-binding.ts), exercised against a mocked DbClient so no
 * real database is needed.
 *
 * Focus: the P1 gate fix — an accepted dispatch suggestion
 * (suggestedScheduleTaskId) breaks the "ambiguous" tie (multiple active
 * assigned leaf tasks) the same way dispatch's own ranking already broke it
 * for the picker, instead of dropping the binding to null.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScheduleTaskForPunch, type PunchBindingInput } from "../src/lib/punch-task-binding";

const DAY = "2026-08-25";
// Active on DAY per isTaskActiveOnDay: startKey <= dayKey < endDate slice.
const ACTIVE_START = new Date("2026-08-24T00:00:00.000Z");
const ACTIVE_END = new Date("2026-08-26T00:00:00.000Z");
// Not active on DAY — ended before it.
const INACTIVE_END = new Date("2026-08-25T00:00:00.000Z");

interface FakeTask {
    id: string;
    parentId: string | null;
    estimateItemId: string | null;
    startDate: Date;
    endDate: Date;
    status: string;
    type: string;
    assignments: { id: string }[];
}

function fakeDb(tasks: FakeTask[]) {
    return {
        scheduleTask: {
            findMany: async (_args: unknown) => tasks,
        },
    } as unknown as Parameters<typeof resolveScheduleTaskForPunch>[1];
}

function input(overrides: Partial<PunchBindingInput> = {}): PunchBindingInput {
    return {
        userId: "user-1",
        projectId: "project-1",
        dayKey: DAY,
        ...overrides,
    };
}

test("single active assigned task binds via soleAssignedTask", async () => {
    const db = fakeDb([
        {
            id: "task-A",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-1" }],
        },
    ]);

    const result = await resolveScheduleTaskForPunch(input(), db);

    assert.deepEqual(result, {
        taskId: "task-A",
        basis: "soleAssignedTask",
        candidateIds: ["task-A"],
    });
});

test("multiple active assigned tasks + accepted suggestion naming one of them binds via acceptedSuggestion", async () => {
    const db = fakeDb([
        {
            id: "task-A",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-1" }],
        },
        {
            id: "task-B",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-2" }],
        },
    ]);

    const result = await resolveScheduleTaskForPunch(
        input({ suggestedScheduleTaskId: "task-B" }),
        db,
    );

    assert.deepEqual(result, {
        taskId: "task-B",
        basis: "acceptedSuggestion",
        candidateIds: ["task-A", "task-B"],
    });
});

test("multiple active assigned tasks + accepted suggestion NOT among them falls back to ambiguous", async () => {
    const db = fakeDb([
        {
            id: "task-A",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-1" }],
        },
        {
            id: "task-B",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-2" }],
        },
        // The "accepted" task exists on the project but is NOT one of the
        // candidate set — e.g. the caller isn't assigned to it, so a
        // forged/stale suggestedScheduleTaskId must not win the tie.
        {
            id: "task-C-not-assigned",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [],
        },
    ]);

    const result = await resolveScheduleTaskForPunch(
        input({ suggestedScheduleTaskId: "task-C-not-assigned" }),
        db,
    );

    assert.deepEqual(result, {
        taskId: null,
        skipped: "ambiguous",
        candidateIds: ["task-A", "task-B"],
    });
});

test("multiple active assigned tasks + no suggestion at all falls back to ambiguous (unchanged behaviour)", async () => {
    const db = fakeDb([
        {
            id: "task-A",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-1" }],
        },
        {
            id: "task-B",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-2" }],
        },
    ]);

    const result = await resolveScheduleTaskForPunch(input(), db);

    assert.deepEqual(result, {
        taskId: null,
        skipped: "ambiguous",
        candidateIds: ["task-A", "task-B"],
    });
});

test("accepted suggestion naming a task that is active but the caller isn't assigned to is ignored", async () => {
    const db = fakeDb([
        {
            id: "task-A",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-1" }],
        },
        {
            id: "task-B",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-2" }],
        },
        {
            id: "task-D-inactive",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: INACTIVE_END, // not active on DAY
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-3" }],
        },
    ]);

    const result = await resolveScheduleTaskForPunch(
        input({ suggestedScheduleTaskId: "task-D-inactive" }),
        db,
    );

    assert.deepEqual(result, {
        taskId: null,
        skipped: "ambiguous",
        candidateIds: ["task-A", "task-B"],
    });
});

test("no candidates + accepted suggestion still reports noCandidate (suggestion never widens who can bind)", async () => {
    const db = fakeDb([]);

    const result = await resolveScheduleTaskForPunch(
        input({ suggestedScheduleTaskId: "task-anything" }),
        db,
    );

    assert.deepEqual(result, {
        taskId: null,
        skipped: "noCandidate",
        candidateIds: [],
    });
});

test("estimateItemId match still wins outright even when a suggestion is also present", async () => {
    const db = fakeDb([
        {
            id: "task-A",
            parentId: null,
            estimateItemId: "item-1",
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-1" }],
        },
        {
            id: "task-B",
            parentId: null,
            estimateItemId: null,
            startDate: ACTIVE_START,
            endDate: ACTIVE_END,
            status: "In Progress",
            type: "task",
            assignments: [{ id: "assign-2" }],
        },
    ]);

    const result = await resolveScheduleTaskForPunch(
        input({ estimateItemId: "item-1", suggestedScheduleTaskId: "task-B" }),
        db,
    );

    assert.deepEqual(result, {
        taskId: "task-A",
        basis: "estimateItem",
        candidateIds: ["task-A"],
    });
});
