// Behavioral verification for PR-B1's atomic Dispatch publication core.
//
// This script intentionally exercises the session-free transaction core rather
// than the authenticated Server Action wrapper. It creates isolated fixtures,
// verifies all 15 design-review cases, and removes every row it creates.
//
// Run only after scripts/apply-dispatch-b1-schema.mjs has been applied by the
// release orchestrator and the Prisma client has been regenerated:
//   npx tsx scripts/verify-dispatch-publication.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import {
    publishDispatch,
    type PublishDispatchInput,
    type PublishDispatchResult,
} from "../src/lib/dispatch-publication";
import type {
    DispatchAssignment,
    ProjectStartIntent,
    TaskCrewIntent,
    TaskDatesIntent,
} from "../src/lib/dispatch-intent";
import { setTaskCrew } from "../src/lib/schedule-core";

const DAY = 86_400_000;
const BASE = Date.UTC(2042, 0, 5);
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const REQUEST_PREFIX = `dispatch-b1-verify-${RUN_ID}`;

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function day(offset: number): Date {
    return new Date(BASE + offset * DAY);
}

function dayKey(offset: number): string {
    return day(offset).toISOString().slice(0, 10);
}

function requestId(label: string): string {
    return `${REQUEST_PREFIX}-${label}-${randomUUID()}`;
}

function actor(fixture: Fixture): PublishDispatchInput["actor"] {
    return {
        userId: fixture.publisher.id,
        name: fixture.publisher.name ?? fixture.publisher.email,
    };
}

function expectFailure(
    result: PublishDispatchResult,
    code: Extract<PublishDispatchResult, { ok: false }>["code"],
): Extract<PublishDispatchResult, { ok: false }> {
    assert.equal(result.ok, false, `expected ${code}, received ${JSON.stringify(result)}`);
    assert.equal(result.code, code);
    return result;
}

async function createFixture(label: string) {
    const suffix = `${RUN_ID}-${label}-${randomUUID().slice(0, 8)}`;
    const client = await prisma.client.create({
        data: { name: `Dispatch B1 verify ${suffix}`, initials: "DV" },
    });
    const publisher = await prisma.user.create({
        data: {
            email: `dispatch-publisher-${suffix}@example.invalid`,
            name: `Dispatch Publisher ${label}`,
            role: "MANAGER",
            status: "ACTIVATED",
        },
    });
    const crewA = await prisma.user.create({
        data: {
            email: `dispatch-crew-a-${suffix}@example.invalid`,
            name: `Crew A ${label}`,
            role: "FIELD_CREW",
            status: "ACTIVATED",
        },
    });
    const crewB = await prisma.user.create({
        data: {
            email: `dispatch-crew-b-${suffix}@example.invalid`,
            name: `Crew B ${label}`,
            role: "FIELD_CREW",
            status: "ACTIVATED",
        },
    });
    const inactiveCrew = await prisma.user.create({
        data: {
            email: `dispatch-crew-inactive-${suffix}@example.invalid`,
            name: `Inactive Crew ${label}`,
            role: "FIELD_CREW",
            status: "DISABLED",
        },
    });
    const project = await prisma.project.create({
        data: {
            name: `Dispatch project ${label}`,
            clientId: client.id,
            status: "Waiting to Start",
            startDate: day(0),
            type: "Verify",
        },
    });
    const taskA = await prisma.scheduleTask.create({
        data: {
            projectId: project.id,
            name: `Framing ${label}`,
            startDate: day(0),
            endDate: day(3),
            status: "Not Started",
            order: 0,
        },
    });
    const taskB = await prisma.scheduleTask.create({
        data: {
            projectId: project.id,
            name: `Paint ${label}`,
            startDate: day(4),
            endDate: day(6),
            status: "Not Started",
            order: 1,
        },
    });
    await prisma.taskAssignment.createMany({
        data: [
            { taskId: taskA.id, userId: crewA.id, role: "lead" },
            { taskId: taskB.id, userId: crewA.id, role: "assigned" },
        ],
    });
    return { client, publisher, crewA, crewB, inactiveCrew, project, taskA, taskB };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
    await prisma.dispatchPublication.deleteMany({
        where: { clientRequestId: { startsWith: REQUEST_PREFIX } },
    });
    await prisma.project.deleteMany({ where: { id: fixture.project.id } });
    await prisma.client.deleteMany({ where: { id: fixture.client.id } });
    await prisma.user.deleteMany({
        where: {
            id: {
                in: [
                    fixture.publisher.id,
                    fixture.crewA.id,
                    fixture.crewB.id,
                    fixture.inactiveCrew.id,
                ],
            },
        },
    });
}

async function assignmentsForTask(taskId: string): Promise<DispatchAssignment[]> {
    const rows = await prisma.taskAssignment.findMany({
        where: { taskId },
        orderBy: [{ userId: "asc" }, { role: "asc" }],
        select: { userId: true, role: true },
    });
    return rows.map(row => ({
        userId: row.userId,
        role: row.role === "lead" ? "lead" : "assigned",
    }));
}

async function taskDatesIntent(
    taskId: string,
    startDate: string,
    endDate: string,
): Promise<TaskDatesIntent> {
    const task = await prisma.scheduleTask.findUniqueOrThrow({
        where: { id: taskId },
        select: { projectId: true, updatedAt: true },
    });
    assert.ok(task.projectId);
    return {
        kind: "TASK_DATES",
        projectId: task.projectId,
        taskId,
        expectedUpdatedAt: task.updatedAt.toISOString(),
        expectedAssignments: await assignmentsForTask(taskId),
        startDate,
        endDate,
    };
}

async function taskCrewIntent(
    taskId: string,
    assignments: DispatchAssignment[],
): Promise<TaskCrewIntent> {
    const task = await prisma.scheduleTask.findUniqueOrThrow({
        where: { id: taskId },
        select: { projectId: true, updatedAt: true },
    });
    assert.ok(task.projectId);
    return {
        kind: "TASK_CREW",
        projectId: task.projectId,
        taskId,
        expectedUpdatedAt: task.updatedAt.toISOString(),
        expectedAssignments: await assignmentsForTask(taskId),
        assignments,
    };
}

async function projectStartIntent(
    projectId: string,
    startDate: string,
    shiftMode: ProjectStartIntent["shiftMode"] = "ALL_TASKS",
): Promise<ProjectStartIntent> {
    const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
            updatedAt: true,
            scheduleTasks: {
                orderBy: { id: "asc" },
                select: {
                    id: true,
                    updatedAt: true,
                    assignments: {
                        orderBy: [{ userId: "asc" }, { role: "asc" }],
                        select: { userId: true, role: true },
                    },
                },
            },
        },
    });
    return {
        kind: "PROJECT_START",
        projectId,
        expectedUpdatedAt: project.updatedAt.toISOString(),
        expectedTasks: project.scheduleTasks.map(task => ({
            taskId: task.id,
            expectedUpdatedAt: task.updatedAt.toISOString(),
            expectedAssignments: task.assignments.map(assignment => ({
                userId: assignment.userId,
                role: assignment.role === "lead" ? "lead" : "assigned",
            })),
        })),
        startDate,
        shiftMode,
    };
}

async function publish(
    fixture: Fixture,
    label: string,
    intents: PublishDispatchInput["intents"],
    options?: { dryRun?: boolean; clientRequestId?: string },
): Promise<PublishDispatchResult> {
    return publishDispatch({
        clientRequestId: options?.clientRequestId ?? requestId(label),
        actor: actor(fixture),
        intents,
        dryRun: options?.dryRun,
    });
}

async function withFixture(
    label: string,
    run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
    const fixture = await createFixture(label);
    try {
        await run(fixture);
        console.log(`PASS ${label}`);
    } finally {
        await cleanupFixture(fixture);
    }
}

async function main() {
    // 1. Atomic success: project shift + explicit task override + audit/outbox.
    await withFixture("01-atomic-success", async fixture => {
        const projectIntent = await projectStartIntent(fixture.project.id, dayKey(2));
        const explicitTask = await taskDatesIntent(fixture.taskA.id, dayKey(5), dayKey(8));
        const result = await publish(fixture, "atomic-success", [projectIntent, explicitTask]);
        assert.equal(result.ok, true);
        assert.ok(result.publicationId);

        const [project, taskA, taskB, publication] = await Promise.all([
            prisma.project.findUniqueOrThrow({ where: { id: fixture.project.id } }),
            prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } }),
            prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskB.id } }),
            prisma.dispatchPublication.findUniqueOrThrow({
                where: { id: result.publicationId! },
                include: { changes: true, deliveries: true },
            }),
        ]);
        assert.equal(project.startDate?.toISOString().slice(0, 10), dayKey(2));
        assert.equal(taskA.startDate.toISOString().slice(0, 10), dayKey(5));
        assert.equal(taskA.endDate.toISOString().slice(0, 10), dayKey(8));
        assert.equal(taskB.startDate.toISOString().slice(0, 10), dayKey(6));
        assert.equal(taskB.endDate.toISOString().slice(0, 10), dayKey(8));
        assert.equal(publication.changes.length, 3);
        assert.equal(publication.deliveries.length, 1);
        assert.equal(publication.deliveries[0]?.destination, `user:${fixture.crewA.id}`);
    });

    // 2. One stale member rolls the entire requested batch back.
    await withFixture("02-complete-rollback", async fixture => {
        const request = requestId("complete-rollback");
        const taskAIntent = await taskDatesIntent(fixture.taskA.id, dayKey(1), dayKey(4));
        const taskBIntent = await taskDatesIntent(fixture.taskB.id, dayKey(7), dayKey(9));
        await prisma.scheduleTask.update({
            where: { id: fixture.taskB.id },
            data: { updatedAt: new Date(Date.now() + 5_000) },
        });
        const beforeA = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } });
        const result = await publish(fixture, "complete-rollback", [taskAIntent, taskBIntent], { clientRequestId: request });
        expectFailure(result, "STALE_DISPATCH");
        const [afterA, publications] = await Promise.all([
            prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } }),
            prisma.dispatchPublication.count({ where: { clientRequestId: request } }),
        ]);
        assert.equal(afterA.startDate.getTime(), beforeA.startDate.getTime());
        assert.equal(afterA.endDate.getTime(), beforeA.endDate.getTime());
        assert.equal(publications, 0);
    });

    // 3. A task updatedAt mismatch is a typed stale conflict.
    await withFixture("03-task-stale", async fixture => {
        const intent = await taskDatesIntent(fixture.taskA.id, dayKey(2), dayKey(5));
        await prisma.scheduleTask.update({
            where: { id: fixture.taskA.id },
            data: { updatedAt: new Date(Date.now() + 5_000) },
        });
        const failure = expectFailure(await publish(fixture, "task-stale", [intent]), "STALE_DISPATCH");
        assert.ok(failure.conflicts.some(conflict => conflict.targetType === "TASK" && conflict.targetId === fixture.taskA.id));
    });

    // 4. A Project.updatedAt mismatch is a typed stale conflict.
    await withFixture("04-project-stale", async fixture => {
        const intent = await projectStartIntent(fixture.project.id, dayKey(3));
        await prisma.project.update({
            where: { id: fixture.project.id },
            data: { updatedAt: new Date(Date.now() + 5_000) },
        });
        const failure = expectFailure(await publish(fixture, "project-stale", [intent]), "STALE_DISPATCH");
        assert.ok(failure.conflicts.some(conflict => conflict.targetType === "PROJECT" && conflict.targetId === fixture.project.id));
    });

    // 5. Whole-project shifts reject both newly-added and deleted tasks.
    await withFixture("05a-added-task-stale", async fixture => {
        const intent = await projectStartIntent(fixture.project.id, dayKey(2));
        await prisma.scheduleTask.create({
            data: {
                projectId: fixture.project.id,
                name: "Late-added task",
                startDate: day(7),
                endDate: day(8),
            },
        });
        const failure = expectFailure(await publish(fixture, "added-task-stale", [intent]), "STALE_DISPATCH");
        assert.ok(failure.conflicts.some(conflict => conflict.reason === "TASK_SET_CHANGED"));
    });
    await withFixture("05b-deleted-task-stale", async fixture => {
        const intent = await projectStartIntent(fixture.project.id, dayKey(2));
        await prisma.scheduleTask.delete({ where: { id: fixture.taskB.id } });
        const failure = expectFailure(await publish(fixture, "deleted-task-stale", [intent]), "STALE_DISPATCH");
        assert.ok(failure.conflicts.some(conflict => conflict.reason === "TASK_SET_CHANGED"));
    });

    // 6. Assignment writers bump the parent revision; stale snapshots reject.
    await withFixture("06-assignment-stale-revision", async fixture => {
        const intent = await taskDatesIntent(fixture.taskA.id, dayKey(1), dayKey(4));
        const before = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } });
        await setTaskCrew({
            taskId: fixture.taskA.id,
            userIds: [fixture.crewA.id, fixture.crewB.id],
            actor: { type: "TEAM", name: "Concurrent crew editor" },
        });
        const after = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } });
        assert.ok(after.updatedAt.getTime() > before.updatedAt.getTime());
        const failure = expectFailure(await publish(fixture, "assignment-stale", [intent]), "STALE_DISPATCH");
        assert.ok(failure.conflicts.some(conflict => conflict.reason === "ASSIGNMENTS_CHANGED"));
    });

    // 7. Concurrent publishers with distinct request IDs serialize: one wins.
    await withFixture("07-concurrent-publishers", async fixture => {
        const intent = await taskDatesIntent(fixture.taskA.id, dayKey(2), dayKey(5));
        const [left, right] = await Promise.all([
            publish(fixture, "concurrent-left", [intent]),
            publish(fixture, "concurrent-right", [intent]),
        ]);
        const successes = [left, right].filter(result => result.ok);
        const stale = [left, right].filter(result => !result.ok && result.code === "STALE_DISPATCH");
        assert.equal(successes.length, 1);
        assert.equal(stale.length, 1);
    });

    // 8. Exact clientRequestId replay returns the original publication.
    await withFixture("08-idempotent-replay", async fixture => {
        const id = requestId("idempotent-replay");
        const intent = await taskDatesIntent(fixture.taskA.id, dayKey(2), dayKey(5));
        const first = await publish(fixture, "idempotent-replay", [intent], { clientRequestId: id });
        assert.equal(first.ok, true);
        const beforeCounts = await prisma.dispatchPublication.findUniqueOrThrow({
            where: { clientRequestId: id },
            include: { changes: true, deliveries: true },
        });
        const replay = await publish(fixture, "idempotent-replay", [intent], { clientRequestId: id });
        assert.equal(replay.ok, true);
        assert.equal(replay.publicationId, first.publicationId);
        assert.equal(replay.replayed, true);
        const afterCounts = await prisma.dispatchPublication.findUniqueOrThrow({
            where: { clientRequestId: id },
            include: { changes: true, deliveries: true },
        });
        assert.equal(afterCounts.changes.length, beforeCounts.changes.length);
        assert.equal(afterCounts.deliveries.length, beforeCounts.deliveries.length);
    });

    // 9. Reusing an idempotency key for a different request is rejected.
    await withFixture("09-request-hash-conflict", async fixture => {
        const id = requestId("request-hash-conflict");
        const firstIntent = await taskDatesIntent(fixture.taskA.id, dayKey(2), dayKey(5));
        const first = await publish(fixture, "request-hash-conflict", [firstIntent], { clientRequestId: id });
        assert.equal(first.ok, true);
        const changedIntent = { ...firstIntent, startDate: dayKey(3), endDate: dayKey(6) };
        expectFailure(
            await publish(fixture, "request-hash-conflict", [changedIntent], { clientRequestId: id }),
            "REQUEST_ID_CONFLICT",
        );
    });

    // 10. Multiple changed tasks for one user collapse into one delivery.
    await withFixture("10-recipient-dedupe", async fixture => {
        const intents = [
            await taskDatesIntent(fixture.taskA.id, dayKey(1), dayKey(4)),
            await taskDatesIntent(fixture.taskB.id, dayKey(5), dayKey(7)),
        ];
        const result = await publish(fixture, "recipient-dedupe", intents);
        assert.equal(result.ok, true);
        const deliveries = await prisma.chatDelivery.findMany({
            where: { publicationId: result.publicationId! },
        });
        assert.deepEqual(deliveries.map(row => row.destination), [`user:${fixture.crewA.id}`]);
    });

    // 11. Removed assignees receive the cancellation digest.
    await withFixture("11-removed-recipient", async fixture => {
        const intent = await taskCrewIntent(fixture.taskA.id, []);
        const result = await publish(fixture, "removed-recipient", [intent]);
        assert.equal(result.ok, true);
        const delivery = await prisma.chatDelivery.findUnique({
            where: {
                publicationId_destination_kind: {
                    publicationId: result.publicationId!,
                    destination: `user:${fixture.crewA.id}`,
                    kind: "dispatch_publication",
                },
            },
        });
        assert.ok(delivery);
    });

    // 12. A project shift plus explicit override emits one net task change.
    await withFixture("12-net-task-change", async fixture => {
        const intents = [
            await projectStartIntent(fixture.project.id, dayKey(2)),
            await taskDatesIntent(fixture.taskA.id, dayKey(7), dayKey(9)),
        ];
        const result = await publish(fixture, "net-task-change", intents);
        assert.equal(result.ok, true);
        const taskChanges = await prisma.dispatchPublicationChange.findMany({
            where: {
                publicationId: result.publicationId!,
                targetType: "TASK",
                targetId: fixture.taskA.id,
                kind: "TASK_DATES",
            },
        });
        assert.equal(taskChanges.length, 1);
        assert.deepEqual(taskChanges[0]?.before, { startDate: dayKey(0), endDate: dayKey(3) });
        assert.deepEqual(taskChanges[0]?.after, { startDate: dayKey(7), endDate: dayKey(9) });
    });

    // 13. dryRun returns the authoritative diff and writes nothing.
    await withFixture("13-dry-run", async fixture => {
        const id = requestId("dry-run");
        const intent = await taskDatesIntent(fixture.taskA.id, dayKey(2), dayKey(5));
        const before = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } });
        const result = await publish(fixture, "dry-run", [intent], { dryRun: true, clientRequestId: id });
        assert.equal(result.ok, true);
        assert.equal(result.publicationId, null);
        assert.equal(result.changes.length, 1);
        const [after, publications] = await Promise.all([
            prisma.scheduleTask.findUniqueOrThrow({ where: { id: fixture.taskA.id } }),
            prisma.dispatchPublication.count({ where: { clientRequestId: id } }),
        ]);
        assert.equal(after.startDate.getTime(), before.startDate.getTime());
        assert.equal(after.endDate.getTime(), before.endDate.getTime());
        assert.equal(publications, 0);
    });

    // 14. No-op input creates no publication.
    await withFixture("14-no-op", async fixture => {
        const id = requestId("no-op");
        const intent = await taskDatesIntent(fixture.taskA.id, dayKey(0), dayKey(3));
        expectFailure(
            await publish(fixture, "no-op", [intent], { clientRequestId: id }),
            "NO_CHANGES",
        );
        assert.equal(await prisma.dispatchPublication.count({ where: { clientRequestId: id } }), 0);
    });

    // 15. Inactive and unknown crew additions each roll back completely.
    await withFixture("15a-inactive-crew", async fixture => {
        const id = requestId("inactive-crew");
        const intent = await taskCrewIntent(fixture.taskA.id, [
            { userId: fixture.crewA.id, role: "lead" },
            { userId: fixture.inactiveCrew.id, role: "assigned" },
        ]);
        expectFailure(
            await publish(fixture, "inactive-crew", [intent], { clientRequestId: id }),
            "INVALID_DISPATCH",
        );
        assert.deepEqual(await assignmentsForTask(fixture.taskA.id), [{ userId: fixture.crewA.id, role: "lead" }]);
        assert.equal(await prisma.dispatchPublication.count({ where: { clientRequestId: id } }), 0);
    });
    await withFixture("15b-unknown-crew", async fixture => {
        const id = requestId("unknown-crew");
        const intent = await taskCrewIntent(fixture.taskA.id, [
            { userId: fixture.crewA.id, role: "lead" },
            { userId: `missing-${randomUUID()}`, role: "assigned" },
        ]);
        expectFailure(
            await publish(fixture, "unknown-crew", [intent], { clientRequestId: id }),
            "INVALID_DISPATCH",
        );
        assert.deepEqual(await assignmentsForTask(fixture.taskA.id), [{ userId: fixture.crewA.id, role: "lead" }]);
        assert.equal(await prisma.dispatchPublication.count({ where: { clientRequestId: id } }), 0);
    });

    console.log("dispatch publication verification: PASS");
}

main()
    .catch(error => {
        console.error("dispatch publication verification: FAIL");
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        // Last-resort cleanup for an assertion/connection failure inside a case.
        await prisma.dispatchPublication.deleteMany({
            where: { clientRequestId: { startsWith: REQUEST_PREFIX } },
        }).catch(() => undefined);
        await prisma.$disconnect();
    });
