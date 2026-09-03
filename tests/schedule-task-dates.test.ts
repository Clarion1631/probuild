import assert from "node:assert/strict";
import test from "node:test";
import { updateScheduleTaskInTransaction } from "@/lib/schedule-task-core";

// Regression: the Calendar quick-add creates one-day tasks with
// startDate === endDate, and the update path used to reject any patch that
// kept end === start ("must be after its start date"), so dragging or editing
// a one-day task always failed with "Failed to save". Create and update must
// agree: only end < start is rejected.

const PROJECT_ID = "proj-1";
const TASK_ID = "task-1";

function fakeTx(persisted: { startDate: Date; endDate: Date; type?: string }) {
    const updates: any[] = [];
    const tx: any = {
        $queryRaw: async () => [],
        scheduleTask: {
            findUnique: async () => ({
                id: TASK_ID,
                name: "Form Inspection",
                projectId: PROJECT_ID,
                type: persisted.type ?? "task",
                status: "Not Started",
                blockedReason: null,
                startDate: persisted.startDate,
                endDate: persisted.endDate,
                project: { status: "ACTIVE" },
            }),
            update: async (args: any) => { updates.push(args); return { id: TASK_ID, ...args.data }; },
        },
        activityLog: { create: async () => ({}) },
    };
    return { tx, updates };
}

const actor = { type: "TEAM" as const, name: "Richard" };

test("moving a one-day task (end === start) is accepted", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-03T00:00:00Z") });
    await updateScheduleTaskInTransaction(tx, TASK_ID, { startDate: "2026-09-04", endDate: "2026-09-04" }, actor, PROJECT_ID);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.startDate.toISOString().slice(0, 10), "2026-09-04");
    assert.equal(updates[0].data.endDate.toISOString().slice(0, 10), "2026-09-04");
});

test("shrinking a multi-day task down to a single day is accepted", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-07T00:00:00Z") });
    await updateScheduleTaskInTransaction(tx, TASK_ID, { endDate: "2026-09-03" }, actor, PROJECT_ID);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.endDate.toISOString().slice(0, 10), "2026-09-03");
});

test("an end date before the start date is still rejected", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-07T00:00:00Z") });
    await assert.rejects(
        () => updateScheduleTaskInTransaction(tx, TASK_ID, { endDate: "2026-09-02" }, actor, PROJECT_ID),
        /cannot be before its start date/,
    );
    assert.equal(updates.length, 0);
});
