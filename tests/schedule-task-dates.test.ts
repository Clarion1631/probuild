import assert from "node:assert/strict";
import test from "node:test";
import { updateScheduleTaskInTransaction } from "@/lib/schedule-task-core";
import { ScheduleTaskValidationError } from "@/lib/schedule-task-result";

// Convention (src/lib/schedule-dates.ts): ScheduleTask.endDate is EXCLUSIVE —
// the day AFTER the last day of work. A one-day task on 9/3 is stored as
// start 9/3, end 9/4. Non-milestones must have end STRICTLY after start;
// milestones always store end == start.

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

test("moving a one-day task (9/3..9/4) to 9/4..9/5 is accepted", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-04T00:00:00Z") });
    await updateScheduleTaskInTransaction(tx, TASK_ID, { startDate: "2026-09-04", endDate: "2026-09-05" }, actor, PROJECT_ID);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.startDate.toISOString().slice(0, 10), "2026-09-04");
    assert.equal(updates[0].data.endDate.toISOString().slice(0, 10), "2026-09-05");
});

test("shrinking to end === start is rejected", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-07T00:00:00Z") });
    await assert.rejects(
        () => updateScheduleTaskInTransaction(tx, TASK_ID, { endDate: "2026-09-03" }, actor, PROJECT_ID),
        (err: unknown) => {
            assert.ok(err instanceof ScheduleTaskValidationError);
            assert.match((err as Error).message, /must be after its start date/);
            return true;
        },
    );
    assert.equal(updates.length, 0);
});

test("an end date before the start date is still rejected", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-07T00:00:00Z") });
    await assert.rejects(
        () => updateScheduleTaskInTransaction(tx, TASK_ID, { endDate: "2026-09-02" }, actor, PROJECT_ID),
        (err: unknown) => {
            assert.ok(err instanceof ScheduleTaskValidationError);
            assert.match((err as Error).message, /must be after its start date/);
            return true;
        },
    );
    assert.equal(updates.length, 0);
});

test("a milestone patch stores end === start regardless of the requested endDate", async () => {
    const { tx, updates } = fakeTx({ startDate: new Date("2026-09-03T00:00:00Z"), endDate: new Date("2026-09-03T00:00:00Z"), type: "milestone" });
    await updateScheduleTaskInTransaction(tx, TASK_ID, { startDate: "2026-09-10", endDate: "2026-09-20" }, actor, PROJECT_ID);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.startDate.toISOString().slice(0, 10), "2026-09-10");
    assert.equal(updates[0].data.endDate.toISOString().slice(0, 10), "2026-09-10");
});
