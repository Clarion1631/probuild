import { createHash } from "node:crypto";

export type DispatchAssignmentRole = "assigned" | "lead";

export interface DispatchAssignment {
    userId: string;
    role: DispatchAssignmentRole;
}

export interface ExpectedDispatchTask {
    taskId: string;
    expectedUpdatedAt: string;
    expectedAssignments: DispatchAssignment[];
}

export interface ProjectStartIntent {
    kind: "PROJECT_START";
    projectId: string;
    expectedUpdatedAt: string;
    // Complete task snapshot. Whole-project moves use it to detect tasks added,
    // deleted, revised, or re-crewed after the review was opened.
    expectedTasks: ExpectedDispatchTask[];
    startDate: string;
    shiftMode: "ALL_TASKS" | "NOT_STARTED_TASKS" | "MARKER_ONLY";
}

export interface TaskDatesIntent {
    kind: "TASK_DATES";
    projectId: string;
    taskId: string;
    expectedUpdatedAt: string;
    expectedAssignments: DispatchAssignment[];
    startDate: string;
    endDate: string;
}

export interface TaskCrewIntent {
    kind: "TASK_CREW";
    projectId: string;
    taskId: string;
    expectedUpdatedAt: string;
    expectedAssignments: DispatchAssignment[];
    assignments: DispatchAssignment[];
}

export type DispatchIntent =
    | ProjectStartIntent
    | TaskDatesIntent
    | TaskCrewIntent;

export type DispatchConflictReason =
    | "MISSING"
    | "REVISION_CHANGED"
    | "ASSIGNMENTS_CHANGED"
    | "TASK_SET_CHANGED";

export interface DispatchConflict {
    targetType: "PROJECT" | "TASK";
    targetId: string;
    reason: DispatchConflictReason;
}

export interface DispatchProjectSnapshot {
    id: string;
    name: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
    updatedAt: string;
}

export interface DispatchTaskSnapshot {
    id: string;
    projectId: string;
    name: string;
    type: string;
    status: string;
    startDate: string;
    endDate: string;
    updatedAt: string;
    assignments: DispatchAssignment[];
}

export interface DispatchUserSnapshot {
    id: string;
    name: string;
    status: string;
}

export interface DispatchChange {
    projectId: string;
    targetType: "PROJECT" | "TASK";
    targetId: string;
    kind: DispatchIntent["kind"];
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    summary: string;
}

export interface PersistedDispatchProjectState {
    startDate: string | null;
    endDate: string | null;
}

export interface PersistedDispatchTaskState {
    startDate: string;
    endDate: string;
}

export interface DispatchReconciliationState {
    projects: Record<string, PersistedDispatchProjectState>;
    tasks: Record<string, PersistedDispatchTaskState>;
    assignments: Record<string, DispatchAssignment[]>;
}

export interface DispatchProjectOperation {
    projectId: string;
    shiftMode: ProjectStartIntent["shiftMode"];
    shiftDays: number;
}

export interface DispatchPlan {
    changes: DispatchChange[];
    reconciliation: DispatchReconciliationState;
    recipientIds: string[];
    projectOperations: DispatchProjectOperation[];
    finalProjects: Record<string, PersistedDispatchProjectState>;
    finalTasks: Record<string, PersistedDispatchTaskState>;
    finalAssignments: Record<string, DispatchAssignment[]>;
}

export type DispatchPlanResult =
    | { ok: true; plan: DispatchPlan }
    | {
        ok: false;
        code: "STALE_DISPATCH" | "INVALID_DISPATCH" | "NO_CHANGES";
        message: string;
        conflicts: DispatchConflict[];
    };

const CLOSED_PROJECT_STATUSES = new Set([
    "Closed Complete",
    "Closed Lost",
    "Cancelled",
]);

function parseDay(value: string, label: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${label} must use YYYY-MM-DD`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`${label} is not a real calendar date`);
    }
    return parsed;
}

function dateOnly(value: string | null): string | null {
    return value ? value.slice(0, 10) : null;
}

function addDays(value: string, amount: number): string {
    const parsed = parseDay(value.slice(0, 10), "date");
    parsed.setUTCDate(parsed.getUTCDate() + amount);
    return parsed.toISOString().slice(0, 10);
}

function dayDelta(before: string, after: string): number {
    return Math.round((parseDay(after, "after date").getTime() - parseDay(before, "before date").getTime()) / 86_400_000);
}

export function normalizeDispatchAssignments(
    assignments: DispatchAssignment[],
): DispatchAssignment[] {
    const byUser = new Map<string, DispatchAssignment>();
    for (const assignment of assignments) {
        if (!assignment.userId?.trim()) throw new Error("Dispatch assignments require a userId");
        if (assignment.role !== "assigned" && assignment.role !== "lead") {
            throw new Error(`Unsupported task assignment role: ${String(assignment.role)}`);
        }
        if (byUser.has(assignment.userId)) {
            throw new Error(`Duplicate task assignment for user ${assignment.userId}`);
        }
        byUser.set(assignment.userId, {
            userId: assignment.userId,
            role: assignment.role,
        });
    }
    const normalized = [...byUser.values()].sort((left, right) =>
        left.userId.localeCompare(right.userId) || left.role.localeCompare(right.role),
    );
    if (normalized.filter(assignment => assignment.role === "lead").length > 1) {
        throw new Error("A task can have at most one lead");
    }
    return normalized;
}

export function dispatchAssignmentsEqual(
    left: DispatchAssignment[],
    right: DispatchAssignment[],
): boolean {
    const normalizedLeft = normalizeDispatchAssignments(left);
    const normalizedRight = normalizeDispatchAssignments(right);
    return normalizedLeft.length === normalizedRight.length
        && normalizedLeft.every((assignment, index) =>
            assignment.userId === normalizedRight[index]?.userId
            && assignment.role === normalizedRight[index]?.role,
        );
}

function normalizeRevision(value: string, label: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
    return parsed.toISOString();
}

export function normalizeDispatchIntents(intents: DispatchIntent[]): DispatchIntent[] {
    if (!Array.isArray(intents) || intents.length === 0) return [];
    if (intents.length > 1_000) throw new Error("A dispatch cannot contain more than 1,000 intents");

    const normalized = intents.map((intent): DispatchIntent => {
        if (!intent.projectId?.trim()) throw new Error("Dispatch intents require a projectId");
        if (intent.kind === "PROJECT_START") {
            parseDay(intent.startDate, "Project start date");
            if (!["ALL_TASKS", "NOT_STARTED_TASKS", "MARKER_ONLY"].includes(intent.shiftMode)) {
                throw new Error(`Unsupported project shift mode: ${String(intent.shiftMode)}`);
            }
            const expectedTasks = intent.expectedTasks
                .map(task => {
                    if (!task.taskId?.trim()) throw new Error("Expected tasks require a taskId");
                    return {
                        taskId: task.taskId,
                        expectedUpdatedAt: normalizeRevision(task.expectedUpdatedAt, "Task revision"),
                        expectedAssignments: normalizeDispatchAssignments(task.expectedAssignments),
                    };
                })
                .sort((left, right) => left.taskId.localeCompare(right.taskId));
            if (new Set(expectedTasks.map(task => task.taskId)).size !== expectedTasks.length) {
                throw new Error("Project dispatch snapshots cannot contain duplicate tasks");
            }
            return {
                ...intent,
                expectedUpdatedAt: normalizeRevision(intent.expectedUpdatedAt, "Project revision"),
                expectedTasks,
            };
        }
        if (!intent.taskId?.trim()) throw new Error("Task dispatch intents require a taskId");
        if (intent.kind === "TASK_DATES") {
            const startDate = parseDay(intent.startDate, "Task start date");
            const endDate = parseDay(intent.endDate, "Task end date");
            if (endDate < startDate) throw new Error("Task end date cannot be before its start date");
            return {
                ...intent,
                expectedUpdatedAt: normalizeRevision(intent.expectedUpdatedAt, "Task revision"),
                expectedAssignments: normalizeDispatchAssignments(intent.expectedAssignments),
            };
        }
        return {
            ...intent,
            expectedUpdatedAt: normalizeRevision(intent.expectedUpdatedAt, "Task revision"),
            expectedAssignments: normalizeDispatchAssignments(intent.expectedAssignments),
            assignments: normalizeDispatchAssignments(intent.assignments),
        };
    });

    const seen = new Set<string>();
    for (const intent of normalized) {
        const targetId = intent.kind === "PROJECT_START" ? intent.projectId : intent.taskId;
        const key = `${intent.kind}:${targetId}`;
        if (seen.has(key)) throw new Error(`Duplicate dispatch intent: ${key}`);
        seen.add(key);
    }
    return normalized.sort((left, right) => {
        const leftTarget = left.kind === "PROJECT_START" ? left.projectId : left.taskId;
        const rightTarget = right.kind === "PROJECT_START" ? right.projectId : right.taskId;
        return left.projectId.localeCompare(right.projectId)
            || leftTarget.localeCompare(rightTarget)
            || left.kind.localeCompare(right.kind);
    });
}

export function hashDispatchIntents(intents: DispatchIntent[]): string {
    return createHash("sha256")
        .update(JSON.stringify(normalizeDispatchIntents(intents)))
        .digest("hex");
}

function assignmentSummary(
    assignments: DispatchAssignment[],
    usersById: Map<string, DispatchUserSnapshot>,
): string {
    if (assignments.length === 0) return "Unassigned";
    return assignments.map(assignment => {
        const name = usersById.get(assignment.userId)?.name ?? assignment.userId;
        return assignment.role === "lead" ? `${name} (lead)` : name;
    }).join(", ");
}

function taskCrewSummary(
    task: DispatchTaskSnapshot,
    before: DispatchAssignment[],
    after: DispatchAssignment[],
    usersById: Map<string, DispatchUserSnapshot>,
): string {
    const beforeByUser = new Map(before.map(assignment => [assignment.userId, assignment]));
    const afterByUser = new Map(after.map(assignment => [assignment.userId, assignment]));
    const rows: string[] = [];
    for (const assignment of after) {
        const previous = beforeByUser.get(assignment.userId);
        const name = usersById.get(assignment.userId)?.name ?? assignment.userId;
        if (!previous) {
            rows.push(`${name} \u2192 ${task.name} (add)`);
        } else if (previous.role !== assignment.role) {
            rows.push(`${name} on ${task.name}: ${previous.role} \u2192 ${assignment.role}`);
        }
    }
    for (const assignment of before) {
        if (afterByUser.has(assignment.userId)) continue;
        const name = usersById.get(assignment.userId)?.name ?? assignment.userId;
        rows.push(`${name} removed from ${task.name}`);
    }
    return rows.length > 0
        ? rows.join("; ")
        : `${task.name}: ${assignmentSummary(before, usersById)} \u2192 ${assignmentSummary(after, usersById)}`;
}

function taskDateSummary(
    task: DispatchTaskSnapshot,
    before: PersistedDispatchTaskState,
    after: PersistedDispatchTaskState,
): string {
    const startDelta = dayDelta(before.startDate, after.startDate);
    const endDelta = dayDelta(before.endDate, after.endDate);
    if (startDelta === endDelta && startDelta !== 0) {
        return `${task.name}: ${startDelta > 0 ? "+" : ""}${startDelta} day${Math.abs(startDelta) === 1 ? "" : "s"} (${after.startDate})`;
    }
    return `${task.name}: ${before.startDate}–${before.endDate} → ${after.startDate}–${after.endDate}`;
}

function invalid(message: string): DispatchPlanResult {
    return { ok: false, code: "INVALID_DISPATCH", message, conflicts: [] };
}

export function buildDispatchPlan(input: {
    intents: DispatchIntent[];
    projects: DispatchProjectSnapshot[];
    tasks: DispatchTaskSnapshot[];
    users: DispatchUserSnapshot[];
}): DispatchPlanResult {
    let intents: DispatchIntent[];
    try {
        intents = normalizeDispatchIntents(input.intents);
    } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
    }
    if (intents.length === 0) {
        return { ok: false, code: "NO_CHANGES", message: "There are no dispatch changes to queue.", conflicts: [] };
    }

    const projectsById = new Map(input.projects.map(project => [project.id, project]));
    const tasksById = new Map(input.tasks.map(task => [
        task.id,
        { ...task, assignments: normalizeDispatchAssignments(task.assignments) },
    ]));
    const usersById = new Map(input.users.map(user => [user.id, user]));
    const conflicts: DispatchConflict[] = [];

    for (const intent of intents) {
        const project = projectsById.get(intent.projectId);
        if (!project) {
            conflicts.push({ targetType: "PROJECT", targetId: intent.projectId, reason: "MISSING" });
            continue;
        }
        if (intent.kind === "PROJECT_START") {
            if (project.updatedAt !== intent.expectedUpdatedAt) {
                conflicts.push({ targetType: "PROJECT", targetId: project.id, reason: "REVISION_CHANGED" });
            }
            const actualTasks = [...tasksById.values()]
                .filter(task => task.projectId === project.id)
                .sort((left, right) => left.id.localeCompare(right.id));
            const expectedIds = intent.expectedTasks.map(task => task.taskId);
            if (actualTasks.length !== expectedIds.length
                || actualTasks.some((task, index) => task.id !== expectedIds[index])) {
                conflicts.push({ targetType: "PROJECT", targetId: project.id, reason: "TASK_SET_CHANGED" });
            }
            for (const expectedTask of intent.expectedTasks) {
                const task = tasksById.get(expectedTask.taskId);
                if (!task || task.projectId !== project.id) {
                    conflicts.push({ targetType: "TASK", targetId: expectedTask.taskId, reason: "MISSING" });
                    continue;
                }
                if (task.updatedAt !== expectedTask.expectedUpdatedAt) {
                    conflicts.push({ targetType: "TASK", targetId: task.id, reason: "REVISION_CHANGED" });
                }
                if (!dispatchAssignmentsEqual(task.assignments, expectedTask.expectedAssignments)) {
                    conflicts.push({ targetType: "TASK", targetId: task.id, reason: "ASSIGNMENTS_CHANGED" });
                }
            }
            continue;
        }

        const task = tasksById.get(intent.taskId);
        if (!task || task.projectId !== intent.projectId) {
            conflicts.push({ targetType: "TASK", targetId: intent.taskId, reason: "MISSING" });
            continue;
        }
        if (task.updatedAt !== intent.expectedUpdatedAt) {
            conflicts.push({ targetType: "TASK", targetId: task.id, reason: "REVISION_CHANGED" });
        }
        if (!dispatchAssignmentsEqual(task.assignments, intent.expectedAssignments)) {
            conflicts.push({ targetType: "TASK", targetId: task.id, reason: "ASSIGNMENTS_CHANGED" });
        }
    }
    if (conflicts.length > 0) {
        return {
            ok: false,
            code: "STALE_DISPATCH",
            message: "Dispatch changed while you were reviewing.",
            conflicts: [...new Map(conflicts.map(conflict => [
                `${conflict.targetType}:${conflict.targetId}:${conflict.reason}`,
                conflict,
            ])).values()],
        };
    }

    const finalProjects: Record<string, PersistedDispatchProjectState> = {};
    const finalTasks: Record<string, PersistedDispatchTaskState> = {};
    const finalAssignments: Record<string, DispatchAssignment[]> = {};
    for (const project of input.projects) {
        finalProjects[project.id] = {
            startDate: dateOnly(project.startDate),
            endDate: dateOnly(project.endDate),
        };
    }
    for (const task of tasksById.values()) {
        finalTasks[task.id] = {
            startDate: dateOnly(task.startDate)!,
            endDate: dateOnly(task.endDate)!,
        };
        finalAssignments[task.id] = normalizeDispatchAssignments(task.assignments);
    }

    const projectOperations: DispatchProjectOperation[] = [];
    for (const intent of intents) {
        if (intent.kind !== "PROJECT_START") continue;
        const project = projectsById.get(intent.projectId)!;
        if (CLOSED_PROJECT_STATUSES.has(project.status)) {
            return invalid(`Cannot dispatch a closed project (${project.status})`);
        }
        if (intent.shiftMode === "ALL_TASKS" && project.status !== "Waiting to Start") {
            return invalid("ALL_TASKS is only valid for Waiting to Start projects");
        }
        if (intent.shiftMode === "NOT_STARTED_TASKS" && project.status !== "In Progress") {
            return invalid("NOT_STARTED_TASKS is only valid for In Progress projects");
        }
        const beforeStart = dateOnly(project.startDate);
        const shiftDays = beforeStart ? dayDelta(beforeStart, intent.startDate) : 0;
        if (Math.abs(shiftDays) > 365) {
            return invalid("Project moves cannot exceed 365 days in one dispatch");
        }
        const projectState = finalProjects[project.id]!;
        projectState.startDate = intent.startDate;
        if (projectState.endDate && projectState.endDate <= intent.startDate) {
            projectState.endDate = null;
        }
        if (shiftDays !== 0 && intent.shiftMode !== "MARKER_ONLY") {
            for (const task of tasksById.values()) {
                if (task.projectId !== project.id) continue;
                if (intent.shiftMode === "NOT_STARTED_TASKS" && task.status !== "Not Started") continue;
                finalTasks[task.id] = {
                    startDate: addDays(finalTasks[task.id]!.startDate, shiftDays),
                    endDate: addDays(finalTasks[task.id]!.endDate, shiftDays),
                };
            }
        }
        projectOperations.push({
            projectId: project.id,
            shiftMode: intent.shiftMode,
            shiftDays,
        });
    }

    for (const intent of intents) {
        if (intent.kind === "TASK_DATES") {
            const task = tasksById.get(intent.taskId)!;
            if (task.type === "milestone" && intent.endDate !== intent.startDate) {
                return invalid(`Milestone "${task.name}" must start and end on the same day`);
            }
            if (task.type !== "milestone" && intent.endDate <= intent.startDate) {
                return invalid(`Task "${task.name}" must end after it starts`);
            }
            finalTasks[task.id] = {
                startDate: intent.startDate,
                endDate: intent.endDate,
            };
        }
        if (intent.kind === "TASK_CREW") {
            finalAssignments[intent.taskId] = normalizeDispatchAssignments(intent.assignments);
        }
    }

    const desiredUserIds = new Set(Object.values(finalAssignments).flatMap(assignments =>
        assignments.map(assignment => assignment.userId),
    ));
    const unknownUserIds = [...desiredUserIds].filter(userId => !usersById.has(userId));
    if (unknownUserIds.length > 0) {
        return invalid(`Unknown user id(s): ${unknownUserIds.join(", ")}`);
    }
    for (const intent of intents) {
        if (intent.kind !== "TASK_CREW") continue;
        const beforeIds = new Set(intent.expectedAssignments.map(assignment => assignment.userId));
        const inactiveAdditions = intent.assignments.filter(assignment =>
            !beforeIds.has(assignment.userId)
            && usersById.get(assignment.userId)?.status !== "ACTIVATED",
        );
        if (inactiveAdditions.length > 0) {
            return invalid(`Task crew additions must be ACTIVATED users: ${inactiveAdditions.map(row =>
                usersById.get(row.userId)?.name ?? row.userId,
            ).join(", ")}`);
        }
    }

    const changes: DispatchChange[] = [];
    for (const project of [...input.projects].sort((left, right) => left.id.localeCompare(right.id))) {
        const before = {
            startDate: dateOnly(project.startDate),
            endDate: dateOnly(project.endDate),
        };
        const after = finalProjects[project.id]!;
        if (before.startDate !== after.startDate || before.endDate !== after.endDate) {
            changes.push({
                projectId: project.id,
                targetType: "PROJECT",
                targetId: project.id,
                kind: "PROJECT_START",
                before,
                after: { ...after },
                summary: `${project.name}: start ${before.startDate ?? "Unscheduled"} → ${after.startDate ?? "Unscheduled"}${before.endDate && !after.endDate ? "; saved end date cleared" : ""}`,
            });
        }
    }

    const changedTaskIds = new Set<string>();
    for (const task of [...tasksById.values()].sort((left, right) =>
        left.projectId.localeCompare(right.projectId) || left.id.localeCompare(right.id),
    )) {
        const beforeDates = {
            startDate: dateOnly(task.startDate)!,
            endDate: dateOnly(task.endDate)!,
        };
        const afterDates = finalTasks[task.id]!;
        if (beforeDates.startDate !== afterDates.startDate || beforeDates.endDate !== afterDates.endDate) {
            changes.push({
                projectId: task.projectId,
                targetType: "TASK",
                targetId: task.id,
                kind: "TASK_DATES",
                before: beforeDates,
                after: { ...afterDates },
                summary: taskDateSummary(task, beforeDates, afterDates),
            });
            changedTaskIds.add(task.id);
        }
        const beforeCrew = normalizeDispatchAssignments(task.assignments);
        const afterCrew = finalAssignments[task.id]!;
        if (!dispatchAssignmentsEqual(beforeCrew, afterCrew)) {
            changes.push({
                projectId: task.projectId,
                targetType: "TASK",
                targetId: task.id,
                kind: "TASK_CREW",
                before: { assignments: beforeCrew },
                after: { assignments: afterCrew },
                summary: taskCrewSummary(task, beforeCrew, afterCrew, usersById),
            });
            changedTaskIds.add(task.id);
        }
    }

    if (changes.length === 0) {
        return { ok: false, code: "NO_CHANGES", message: "There are no dispatch changes to queue.", conflicts: [] };
    }

    const recipientIds = new Set<string>();
    for (const taskId of changedTaskIds) {
        const task = tasksById.get(taskId)!;
        for (const assignment of [
            ...task.assignments,
            ...finalAssignments[taskId]!,
        ]) {
            if (usersById.get(assignment.userId)?.status === "ACTIVATED") {
                recipientIds.add(assignment.userId);
            }
        }
    }

    const reconciliation: DispatchReconciliationState = {
        projects: {},
        tasks: {},
        assignments: {},
    };
    for (const change of changes) {
        if (change.targetType === "PROJECT") {
            reconciliation.projects[change.targetId] = { ...finalProjects[change.targetId]! };
        } else {
            reconciliation.tasks[change.targetId] = { ...finalTasks[change.targetId]! };
            reconciliation.assignments[change.targetId] = [...finalAssignments[change.targetId]!];
        }
    }

    return {
        ok: true,
        plan: {
            changes,
            reconciliation,
            recipientIds: [...recipientIds].sort(),
            projectOperations,
            finalProjects,
            finalTasks,
            finalAssignments,
        },
    };
}

export function reconciliationFromChanges(
    changes: DispatchChange[],
): DispatchReconciliationState {
    const reconciliation: DispatchReconciliationState = {
        projects: {},
        tasks: {},
        assignments: {},
    };
    for (const change of changes) {
        if (change.targetType === "PROJECT") {
            reconciliation.projects[change.targetId] = {
                startDate: typeof change.after.startDate === "string" ? change.after.startDate : null,
                endDate: typeof change.after.endDate === "string" ? change.after.endDate : null,
            };
            continue;
        }
        if (change.kind === "TASK_DATES") {
            if (typeof change.after.startDate === "string" && typeof change.after.endDate === "string") {
                reconciliation.tasks[change.targetId] = {
                    startDate: change.after.startDate,
                    endDate: change.after.endDate,
                };
            }
        }
        if (change.kind === "TASK_CREW") {
            const assignments = Array.isArray(change.after.assignments)
                ? change.after.assignments.filter((row): row is DispatchAssignment =>
                    Boolean(row)
                    && typeof row === "object"
                    && "userId" in row
                    && "role" in row
                    && typeof row.userId === "string"
                    && (row.role === "assigned" || row.role === "lead"),
                )
                : [];
            reconciliation.assignments[change.targetId] = normalizeDispatchAssignments(assignments);
        }
    }
    return reconciliation;
}
