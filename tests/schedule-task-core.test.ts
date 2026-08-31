/**
 * Unit tests for schedule-task-core.ts's type/estimateItemId invariant: an
 * estimate-linked task must stay type "task" (see
 * scheduleTaskTypeEstimateInvariantError's doc comment). The pure guard is
 * exercised directly; updateScheduleTaskInTransaction is exercised through a
 * minimal fake Prisma.TransactionClient so the invariant is proven wired
 * into the real update path, not just the guard in isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import {
    scheduleTaskTypeEstimateInvariantError,
    updateScheduleTaskInTransaction,
} from "../src/lib/schedule-task-core";

// ── scheduleTaskTypeEstimateInvariantError (pure) ───────────────────────────

test("scheduleTaskTypeEstimateInvariantError: null when estimate-linked and type is task", () => {
    assert.equal(scheduleTaskTypeEstimateInvariantError("task", "ei1"), null);
});

test("scheduleTaskTypeEstimateInvariantError: null when not estimate-linked, regardless of type", () => {
    assert.equal(scheduleTaskTypeEstimateInvariantError("milestone", null), null);
    assert.equal(scheduleTaskTypeEstimateInvariantError("appointment", null), null);
    assert.equal(scheduleTaskTypeEstimateInvariantError("task", null), null);
});

test("scheduleTaskTypeEstimateInvariantError: an error when estimate-linked and type is milestone", () => {
    const error = scheduleTaskTypeEstimateInvariantError("milestone", "ei1");
    assert.ok(error);
    assert.match(error!, /must stay type "Task"/);
});

test("scheduleTaskTypeEstimateInvariantError: an error when estimate-linked and type is appointment", () => {
    assert.ok(scheduleTaskTypeEstimateInvariantError("appointment", "ei1"));
});

// ── updateScheduleTaskInTransaction (fake tx) ───────────────────────────────

const actor = { type: "TEAM" as const, name: "Justin" };

interface FakePersistedTask {
    id: string;
    name: string;
    projectId: string;
    type: string;
    status: string;
    blockedReason: string | null;
    startDate: Date;
    endDate: Date;
    estimateItemId: string | null;
    project: { status: string } | null;
}

function fakeTx(persisted: FakePersistedTask, opts: { linkedElsewhere?: { id: string; name: string } | null } = {}) {
    let scheduleTaskFindUniqueCalls = 0;
    const tx = {
        $queryRaw: async () => [],
        scheduleTask: {
            findUnique: async () => {
                scheduleTaskFindUniqueCalls++;
                // Call 1: lockTaskAssignmentParent's re-lock (id/projectId/name only).
                if (scheduleTaskFindUniqueCalls === 1) {
                    return { id: persisted.id, projectId: persisted.projectId, name: persisted.name };
                }
                // Call 2+: updateScheduleTaskInTransaction's own persisted lookup.
                return persisted;
            },
            findFirst: async () => opts.linkedElsewhere ?? null,
            update: async ({ data }: { data: Record<string, unknown> }) => ({ ...persisted, ...data }),
        },
        estimateItem: {
            findUnique: async () => null,
        },
        activityLog: {
            create: async () => ({}),
        },
    };
    return tx as unknown as Prisma.TransactionClient;
}

function persistedTask(overrides: Partial<FakePersistedTask> = {}): FakePersistedTask {
    return {
        id: "t1",
        name: "Hang drywall",
        projectId: "p1",
        type: "task",
        status: "Not Started",
        blockedReason: null,
        startDate: new Date("2026-08-29T00:00:00.000Z"),
        endDate: new Date("2026-08-30T00:00:00.000Z"),
        estimateItemId: "ei1",
        project: { status: "In Progress" },
        ...overrides,
    };
}

test("updateScheduleTaskInTransaction: rejects changing type away from task while estimate-linked", async () => {
    const persisted = persistedTask({ estimateItemId: "ei1", type: "task" });
    await assert.rejects(
        updateScheduleTaskInTransaction(fakeTx(persisted), "t1", { type: "milestone" }, actor, "p1"),
        /must stay type "Task"/,
    );
});

test("updateScheduleTaskInTransaction: rejects linking an estimate item to a task whose type is being changed to appointment in the same update", async () => {
    const persisted = persistedTask({ estimateItemId: null, type: "milestone" });
    await assert.rejects(
        updateScheduleTaskInTransaction(fakeTx(persisted), "t1", { type: "appointment", estimateItemId: "ei1" }, actor, "p1"),
        /must stay type "Task"/,
    );
});

test("updateScheduleTaskInTransaction: rejects setting estimateItemId on a task that is already a non-task type", async () => {
    const persisted = persistedTask({ estimateItemId: null, type: "milestone" });
    await assert.rejects(
        updateScheduleTaskInTransaction(fakeTx(persisted), "t1", { estimateItemId: "ei1" }, actor, "p1"),
        /must stay type "Task"/,
    );
});

test("updateScheduleTaskInTransaction: allows unlinking a task and changing its type in the same update", async () => {
    const persisted = persistedTask({ estimateItemId: "ei1", type: "task" });
    const saved = await updateScheduleTaskInTransaction(fakeTx(persisted), "t1", { type: "milestone", estimateItemId: null }, actor, "p1");
    assert.equal(saved.type, "milestone");
    assert.equal(saved.estimateItemId, null);
});

test("updateScheduleTaskInTransaction: allows a plain name edit on an estimate-linked task", async () => {
    const persisted = persistedTask({ estimateItemId: "ei1", type: "task" });
    const saved = await updateScheduleTaskInTransaction(fakeTx(persisted), "t1", { name: "Hang drywall in hall bath" }, actor, "p1");
    assert.equal(saved.name, "Hang drywall in hall bath");
});
