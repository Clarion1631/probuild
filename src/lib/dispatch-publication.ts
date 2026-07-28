import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { withTxRetry } from "./tx-retry";
import {
    setProjectStartDateInTransaction,
    shiftNotStartedTasksInTransaction,
    touchTaskAssignmentRevision,
} from "./schedule-core";
import {
    buildDispatchPlan,
    hashDispatchIntents,
    normalizeDispatchAssignments,
    normalizeDispatchIntents,
    reconciliationFromChanges,
    type DispatchChange,
    type DispatchConflict,
    type DispatchIntent,
    type DispatchProjectSnapshot,
    type DispatchReconciliationState,
    type DispatchTaskSnapshot,
    type DispatchUserSnapshot,
} from "./dispatch-intent";

export interface PublishDispatchInput {
    clientRequestId: string;
    actor: {
        userId: string | null;
        name: string;
    };
    intents: DispatchIntent[];
    dryRun?: boolean;
}

export interface PublishDispatchSuccess {
    ok: true;
    publicationId: string | null;
    replayed: boolean;
    dryRun: boolean;
    changes: DispatchChange[];
    reconciliation: DispatchReconciliationState;
    deliveryCount: number;
    notes: string[];
}

export interface PublishDispatchFailure {
    ok: false;
    code:
        | "STALE_DISPATCH"
        | "INVALID_DISPATCH"
        | "NO_CHANGES"
        | "REQUEST_ID_CONFLICT"
        | "FORBIDDEN"
        | "DISPATCH_FAILED";
    message: string;
    conflicts: DispatchConflict[];
}

export type PublishDispatchResult =
    | PublishDispatchSuccess
    | PublishDispatchFailure;

type DbClient = Prisma.TransactionClient | typeof prisma;

interface ExistingPublication {
    id: string;
    requestHash: string;
    changes: {
        projectId: string;
        targetType: string;
        targetId: string;
        kind: string;
        before: Prisma.JsonValue;
        after: Prisma.JsonValue;
        summary: string;
    }[];
    deliveries: { id: string }[];
}

function invalid(message: string): PublishDispatchFailure {
    return {
        ok: false,
        code: "INVALID_DISPATCH",
        message,
        conflicts: [],
    };
}

function asJsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function changesFromPublication(publication: ExistingPublication): DispatchChange[] {
    return publication.changes.map(change => ({
        projectId: change.projectId,
        targetType: change.targetType === "PROJECT" ? "PROJECT" : "TASK",
        targetId: change.targetId,
        kind: change.kind === "PROJECT_START"
            ? "PROJECT_START"
            : change.kind === "TASK_CREW"
                ? "TASK_CREW"
                : "TASK_DATES",
        before: asJsonRecord(change.before),
        after: asJsonRecord(change.after),
        summary: change.summary,
    }));
}

async function findExistingPublication(
    client: DbClient,
    clientRequestId: string,
): Promise<ExistingPublication | null> {
    return client.dispatchPublication.findUnique({
        where: { clientRequestId },
        select: {
            id: true,
            requestHash: true,
            changes: {
                orderBy: { position: "asc" },
                select: {
                    projectId: true,
                    targetType: true,
                    targetId: true,
                    kind: true,
                    before: true,
                    after: true,
                    summary: true,
                },
            },
            deliveries: { select: { id: true } },
        },
    });
}

function replayResult(
    publication: ExistingPublication,
    requestHash: string,
): PublishDispatchResult {
    if (publication.requestHash !== requestHash) {
        return {
            ok: false,
            code: "REQUEST_ID_CONFLICT",
            message: "This dispatch request ID was already used for different changes.",
            conflicts: [],
        };
    }
    const changes = changesFromPublication(publication);
    return {
        ok: true,
        publicationId: publication.id,
        replayed: true,
        dryRun: false,
        changes,
        reconciliation: reconciliationFromChanges(changes),
        deliveryCount: publication.deliveries.length,
        notes: [],
    };
}

function isClientRequestUniqueError(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        return false;
    }
    return /clientRequestId/i.test(JSON.stringify(error.meta ?? {}));
}

function changedCrewTaskIds(
    changes: DispatchChange[],
): Set<string> {
    return new Set(changes
        .filter(change => change.kind === "TASK_CREW")
        .map(change => change.targetId));
}

function changedDateTaskIds(
    changes: DispatchChange[],
): Set<string> {
    return new Set(changes
        .filter(change => change.kind === "TASK_DATES")
        .map(change => change.targetId));
}

async function applyPlan(
    tx: Prisma.TransactionClient,
    input: PublishDispatchInput,
    requestHash: string,
    plan: Extract<ReturnType<typeof buildDispatchPlan>, { ok: true }>["plan"],
    projects: DispatchProjectSnapshot[],
    tasks: DispatchTaskSnapshot[],
    users: DispatchUserSnapshot[],
): Promise<PublishDispatchSuccess> {
    const projectsById = new Map(projects.map(project => [project.id, project]));
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    const usersById = new Map(users.map(user => [user.id, user]));
    const notes: string[] = [];
    const changedProjectIds = new Set(plan.changes
        .filter(change => change.targetType === "PROJECT")
        .map(change => change.targetId));

    for (const operation of plan.projectOperations.sort((left, right) =>
        left.projectId.localeCompare(right.projectId),
    )) {
        if (!changedProjectIds.has(operation.projectId) && operation.shiftDays === 0) continue;
        const projectState = plan.finalProjects[operation.projectId]!;
        const markerResult = await setProjectStartDateInTransaction(tx, {
            projectId: operation.projectId,
            startDate: projectState.startDate
                ? new Date(`${projectState.startDate}T00:00:00.000Z`)
                : null,
            shiftJobTasks: operation.shiftMode === "ALL_TASKS",
            actor: { type: "TEAM", name: input.actor.name },
            writeActivityLog: false,
        });
        notes.push(...markerResult.notes);
        if (operation.shiftMode === "NOT_STARTED_TASKS" && operation.shiftDays !== 0) {
            const shiftResult = await shiftNotStartedTasksInTransaction(tx, {
                projectId: operation.projectId,
                deltaDays: operation.shiftDays,
                actor: { type: "TEAM", name: input.actor.name },
                writeActivityLog: false,
            });
            notes.push(...shiftResult.notes);
        }
    }

    const dateTaskIds = changedDateTaskIds(plan.changes);
    const persistedDateRows = dateTaskIds.size > 0
        ? await tx.scheduleTask.findMany({
            where: { id: { in: [...dateTaskIds] } },
            select: { id: true, startDate: true, endDate: true },
        })
        : [];
    const persistedDatesById = new Map(persistedDateRows.map(task => [task.id, task]));
    for (const taskId of [...dateTaskIds].sort((left, right) => {
        const leftTask = tasksById.get(left)!;
        const rightTask = tasksById.get(right)!;
        return leftTask.projectId.localeCompare(rightTask.projectId) || left.localeCompare(right);
    })) {
        const state = plan.finalTasks[taskId]!;
        const persisted = persistedDatesById.get(taskId);
        if (persisted
            && persisted.startDate.toISOString().slice(0, 10) === state.startDate
            && persisted.endDate.toISOString().slice(0, 10) === state.endDate) {
            continue;
        }
        await tx.scheduleTask.update({
            where: { id: taskId },
            data: {
                startDate: new Date(`${state.startDate}T00:00:00.000Z`),
                endDate: new Date(`${state.endDate}T00:00:00.000Z`),
            },
        });
    }

    const crewTaskIds = changedCrewTaskIds(plan.changes);
    for (const taskId of [...crewTaskIds].sort((left, right) => {
        const leftTask = tasksById.get(left)!;
        const rightTask = tasksById.get(right)!;
        return leftTask.projectId.localeCompare(rightTask.projectId) || left.localeCompare(right);
    })) {
        const current = new Map(tasksById.get(taskId)!.assignments.map(assignment => [assignment.userId, assignment]));
        const desired = new Map(plan.finalAssignments[taskId]!.map(assignment => [assignment.userId, assignment]));
        const removeIds = [...current.keys()].filter(userId => !desired.has(userId));
        if (removeIds.length > 0) {
            await tx.taskAssignment.deleteMany({
                where: { taskId, userId: { in: removeIds } },
            });
        }
        for (const assignment of desired.values()) {
            const existing = current.get(assignment.userId);
            if (!existing) {
                await tx.taskAssignment.create({
                    data: { taskId, userId: assignment.userId, role: assignment.role },
                });
            } else if (existing.role !== assignment.role) {
                await tx.taskAssignment.update({
                    where: { taskId_userId: { taskId, userId: assignment.userId } },
                    data: { role: assignment.role },
                });
            }
        }
        // Assignment rows have no updatedAt of their own. Touch the parent task
        // under the already-held lock so every assignment mutation advances the
        // optimistic revision contract.
        await touchTaskAssignmentRevision(tx, taskId);
    }

    const publication = await tx.dispatchPublication.create({
        data: {
            clientRequestId: input.clientRequestId,
            requestHash,
            publishedById: input.actor.userId,
            publishedByName: input.actor.name,
        },
    });
    await tx.dispatchPublicationChange.createMany({
        data: plan.changes.map((change, position) => ({
            publicationId: publication.id,
            position,
            projectId: change.projectId,
            targetType: change.targetType,
            targetId: change.targetId,
            kind: change.kind,
            before: change.before as Prisma.InputJsonValue,
            after: change.after as Prisma.InputJsonValue,
            summary: change.summary,
        })),
    });

    const taskRecipientIds = new Map<string, Set<string>>();
    for (const task of tasks) {
        taskRecipientIds.set(task.id, new Set([
            ...task.assignments.map(assignment => assignment.userId),
            ...(plan.finalAssignments[task.id] ?? []).map(assignment => assignment.userId),
        ]));
    }
    for (const userId of plan.recipientIds) {
        const relevantTaskChanges = plan.changes.filter(change =>
            change.targetType === "TASK"
            && taskRecipientIds.get(change.targetId)?.has(userId),
        );
        const relevantProjectIds = new Set(relevantTaskChanges.map(change => change.projectId));
        const payloadChanges = plan.changes.filter(change =>
            change.targetType === "TASK"
                ? relevantTaskChanges.includes(change)
                : relevantProjectIds.has(change.projectId),
        );
        const destination = `user:${userId}`;
        await tx.chatDelivery.create({
            data: {
                publicationId: publication.id,
                destination,
                kind: "dispatch_publication",
                payload: {
                    publicationId: publication.id,
                    destination,
                    recipient: {
                        userId,
                        name: usersById.get(userId)?.name ?? userId,
                    },
                    publishedBy: {
                        userId: input.actor.userId,
                        name: input.actor.name,
                    },
                    publishedAt: publication.publishedAt.toISOString(),
                    changes: payloadChanges.map(change => ({
                        projectId: change.projectId,
                        targetType: change.targetType,
                        targetId: change.targetId,
                        kind: change.kind,
                        before: change.before,
                        after: change.after,
                        summary: change.summary,
                    })),
                } as Prisma.InputJsonValue,
                status: "PENDING",
            },
        });
    }

    const publicationProjectIds = [...new Set(plan.changes.map(change => change.projectId))].sort();
    for (const projectId of publicationProjectIds) {
        const projectChanges = plan.changes.filter(change => change.projectId === projectId);
        await tx.activityLog.create({
            data: {
                projectId,
                actorType: "TEAM",
                actorName: input.actor.name,
                action: "published_dispatch",
                entityType: "dispatch_publication",
                entityId: publication.id,
                entityName: projectsById.get(projectId)?.name ?? "Dispatch",
                metadata: JSON.stringify({
                    publicationId: publication.id,
                    clientRequestId: input.clientRequestId,
                    changes: projectChanges.map(change => change.summary),
                    deliveryPending: true,
                }),
            },
        });
    }

    return {
        ok: true,
        publicationId: publication.id,
        replayed: false,
        dryRun: false,
        changes: plan.changes,
        reconciliation: plan.reconciliation,
        deliveryCount: plan.recipientIds.length,
        notes,
    };
}

export async function publishDispatch(
    rawInput: PublishDispatchInput,
): Promise<PublishDispatchResult> {
    const clientRequestId = rawInput.clientRequestId?.trim();
    if (!clientRequestId || clientRequestId.length > 200) {
        return invalid("clientRequestId is required and cannot exceed 200 characters");
    }
    const actorName = rawInput.actor?.name?.trim();
    if (!actorName) return invalid("A publisher name is required");

    let intents: DispatchIntent[];
    let requestHash: string;
    try {
        intents = normalizeDispatchIntents(rawInput.intents);
        requestHash = hashDispatchIntents(intents);
    } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
    }
    const input: PublishDispatchInput = {
        ...rawInput,
        clientRequestId,
        actor: { userId: rawInput.actor.userId ?? null, name: actorName },
        intents,
    };

    const existing = await findExistingPublication(prisma, clientRequestId);
    if (existing) return replayResult(existing, requestHash);

    try {
        return await withTxRetry(() => prisma.$transaction(async tx => {
            const firstReplayCheck = await findExistingPublication(tx, clientRequestId);
            if (firstReplayCheck) return replayResult(firstReplayCheck, requestHash);

            const projectIds = [...new Set(intents.map(intent => intent.projectId))].sort();
            if (projectIds.length > 0) {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "Project"
                    WHERE "id" IN (${Prisma.join(projectIds)})
                    ORDER BY "id"
                    FOR UPDATE
                `;
            }
            const lockedTaskRows = projectIds.length > 0
                ? await tx.$queryRaw<{ id: string; projectId: string }[]>`
                    SELECT "id", "projectId"
                    FROM "ScheduleTask"
                    WHERE "projectId" IN (${Prisma.join(projectIds)})
                    ORDER BY "projectId", "id"
                    FOR UPDATE
                `
                : [];
            const taskIds = lockedTaskRows.map(task => task.id);
            if (taskIds.length > 0) {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "TaskAssignment"
                    WHERE "taskId" IN (${Prisma.join(taskIds)})
                    ORDER BY "taskId", "userId"
                    FOR UPDATE
                `;
            }

            // The first transaction with this key may have committed while this
            // one waited on a target lock. Recheck before any stale comparison.
            const replayAfterLocks = await findExistingPublication(tx, clientRequestId);
            if (replayAfterLocks) return replayResult(replayAfterLocks, requestHash);

            const [projectRows, taskRows] = await Promise.all([
                tx.project.findMany({
                    where: { id: { in: projectIds } },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        name: true,
                        status: true,
                        startDate: true,
                        endDate: true,
                        updatedAt: true,
                    },
                }),
                tx.scheduleTask.findMany({
                    where: { id: { in: taskIds } },
                    orderBy: [{ projectId: "asc" }, { id: "asc" }],
                    select: {
                        id: true,
                        projectId: true,
                        name: true,
                        type: true,
                        status: true,
                        startDate: true,
                        endDate: true,
                        updatedAt: true,
                        assignments: {
                            orderBy: [{ userId: "asc" }, { role: "asc" }],
                            select: { userId: true, role: true },
                        },
                    },
                }),
            ]);

            const desiredUserIds = intents.flatMap(intent =>
                intent.kind === "TASK_CREW"
                    ? intent.assignments.map(assignment => assignment.userId)
                    : [],
            );
            const userIds = [...new Set([
                ...taskRows.flatMap(task => task.assignments.map(assignment => assignment.userId)),
                ...desiredUserIds,
            ])].sort();
            const userRows = userIds.length > 0
                ? await tx.user.findMany({
                    where: { id: { in: userIds } },
                    orderBy: { id: "asc" },
                    select: { id: true, name: true, email: true, status: true },
                })
                : [];

            const projects: DispatchProjectSnapshot[] = projectRows.map(project => ({
                id: project.id,
                name: project.name,
                status: project.status,
                startDate: project.startDate?.toISOString() ?? null,
                endDate: project.endDate?.toISOString() ?? null,
                updatedAt: project.updatedAt.toISOString(),
            }));
            const tasks: DispatchTaskSnapshot[] = taskRows
                .filter((task): task is typeof task & { projectId: string } => Boolean(task.projectId))
                .map(task => ({
                    id: task.id,
                    projectId: task.projectId,
                    name: task.name,
                    type: task.type,
                    status: task.status,
                    startDate: task.startDate.toISOString(),
                    endDate: task.endDate.toISOString(),
                    updatedAt: task.updatedAt.toISOString(),
                    assignments: normalizeDispatchAssignments(task.assignments.map(assignment => ({
                        userId: assignment.userId,
                        role: assignment.role === "lead" ? "lead" : "assigned",
                    }))),
                }));
            const users: DispatchUserSnapshot[] = userRows.map(user => ({
                id: user.id,
                name: user.name || user.email,
                status: user.status,
            }));

            const planned = buildDispatchPlan({ intents, projects, tasks, users });
            if (!planned.ok) return planned;
            if (input.dryRun) {
                return {
                    ok: true,
                    publicationId: null,
                    replayed: false,
                    dryRun: true,
                    changes: planned.plan.changes,
                    reconciliation: planned.plan.reconciliation,
                    deliveryCount: planned.plan.recipientIds.length,
                    notes: [],
                } satisfies PublishDispatchSuccess;
            }
            return applyPlan(tx, input, requestHash, planned.plan, projects, tasks, users);
        }, {
            maxWait: 5_000,
            timeout: 20_000,
        }));
    } catch (error) {
        if (!isClientRequestUniqueError(error)) throw error;
        const concurrent = await findExistingPublication(prisma, clientRequestId);
        if (!concurrent) throw error;
        return replayResult(concurrent, requestHash);
    }
}
