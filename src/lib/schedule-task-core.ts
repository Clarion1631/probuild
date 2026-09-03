import { Prisma } from "@prisma/client";

import { getDefaultColorForTaskName } from "@/app/projects/[id]/schedule/schedule-utils";
import { CLOSED_PROJECT_STATUSES } from "./gpt-estimate";
import { CLIENT_STAGES, clientStageIndex } from "./client-stages";
import {
    deriveEstimateItemHours,
    lockTaskAssignmentParent,
    parseStartDateInput,
    touchTaskAssignmentRevision,
    type ScheduleActor,
} from "./schedule-core";

export const SCHEDULE_TASK_TYPES = ["task", "milestone", "appointment"] as const;
export const SCHEDULE_CONFIRMATION_STATUSES = ["planned", "requested", "confirmed"] as const;
export const SCHEDULE_TASK_STATUSES = ["Not Started", "In Progress", "Complete", "Blocked"] as const;
const SCHEDULE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type ScheduleTaskType = typeof SCHEDULE_TASK_TYPES[number];
export type ScheduleConfirmationStatus = typeof SCHEDULE_CONFIRMATION_STATUSES[number];
export type ScheduleTaskStatus = typeof SCHEDULE_TASK_STATUSES[number];

export interface ScheduleTaskCommentAuthor {
    userId: string | null;
    fallbackLabel: string;
}

export interface CreateScheduleTaskInput {
    name: string;
    startDate: string;
    endDate: string;
    color?: string;
    status?: string;
    assignee?: string;
    parentId?: string;
    type?: ScheduleTaskType;
    estimateItemId?: string | null;
    crewIds?: string[];
    leadUserId?: string | null;
    estimatedHours?: number | null;
    doneWhen?: string | null;
    note?: string;
    scheduledTime?: string | null;
    confirmationStatus?: ScheduleConfirmationStatus | null;
}

export interface UpdateScheduleTaskInput {
    name?: string;
    startDate?: string;
    endDate?: string;
    color?: string;
    progress?: number;
    status?: string;
    assignee?: string;
    order?: number;
    estimatedHours?: number | null;
    type?: ScheduleTaskType;
    estimateItemId?: string | null;
    doneWhen?: string | null;
    blockedReason?: string | null;
    scheduledTime?: string | null;
    confirmationStatus?: ScheduleConfirmationStatus | null;
    /** Client tracker stage override; null clears it back to auto-derive. */
    clientStage?: string | null;
}

function assertScheduleTaskType(type: string): asserts type is ScheduleTaskType {
    if (!(SCHEDULE_TASK_TYPES as readonly string[]).includes(type)) {
        throw new Error("Invalid schedule task type");
    }
}

function assertScheduleTaskStatus(status: string): asserts status is ScheduleTaskStatus {
    if (!(SCHEDULE_TASK_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`Invalid schedule task status "${status}"`);
    }
}

function normalizeScheduledTime(value: string | null | undefined): string | null {
    const normalized = value?.trim() || null;
    if (normalized && !SCHEDULE_TIME_PATTERN.test(normalized)) {
        throw new Error("Scheduled time must use 24-hour HH:MM format");
    }
    return normalized;
}

function assertConfirmationStatus(value: string): asserts value is ScheduleConfirmationStatus {
    if (!(SCHEDULE_CONFIRMATION_STATUSES as readonly string[]).includes(value)) {
        throw new Error("Invalid appointment confirmation status");
    }
}

function taskCommentCreateData(
    taskId: string,
    text: string,
    author: ScheduleTaskCommentAuthor,
) {
    return {
        taskId,
        text,
        userId: author.userId,
        subcontractorName: author.userId ? null : author.fallbackLabel,
    };
}

export async function createScheduleTaskInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    data: CreateScheduleTaskInput,
    actor: ScheduleActor,
    commentAuthor?: ScheduleTaskCommentAuthor | null,
) {
    const name = data.name.trim();
    if (!name) throw new Error("Task name is required");
    const type = data.type ?? "task";
    assertScheduleTaskType(type);
    if (data.status !== undefined) assertScheduleTaskStatus(data.status);
    if (data.status === "Blocked") throw new Error("Blocked tasks require a reason");

    const startDate = parseStartDateInput(data.startDate);
    const requestedEndDate = parseStartDateInput(data.endDate);
    const endDate = type === "milestone" ? startDate : requestedEndDate;
    if (type !== "milestone" && endDate < startDate) {
        throw new Error("Task end date cannot be before its start date");
    }
    if (data.estimatedHours != null && (!Number.isFinite(data.estimatedHours) || data.estimatedHours < 0)) {
        throw new Error("Estimated hours must be zero or greater");
    }

    const scheduledTime = normalizeScheduledTime(data.scheduledTime);
    if (data.confirmationStatus) assertConfirmationStatus(data.confirmationStatus);
    if (type !== "appointment" && (scheduledTime || data.confirmationStatus)) {
        throw new Error("Scheduled time and confirmation status are appointment-only fields");
    }
    const confirmationStatus = type === "appointment" ? (data.confirmationStatus ?? "planned") : null;
    const estimateItemId = data.estimateItemId?.trim() || null;
    const crewIds = [...new Set((data.crewIds ?? []).filter(Boolean))];
    const leadUserId = data.leadUserId ?? null;
    if (leadUserId && !crewIds.includes(leadUserId)) {
        throw new Error("Task lead must be assigned to the crew");
    }
    const note = data.note?.trim() || null;

    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new Error("Project not found");

    const estimateItem = estimateItemId
        ? await tx.estimateItem.findUnique({
            where: { id: estimateItemId },
            select: {
                id: true,
                type: true,
                quantity: true,
                budgetUnit: true,
                estimate: { select: { projectId: true } },
                scheduleTask: { select: { id: true, name: true } },
                _count: { select: { subItems: true } },
            },
        })
        : null;
    if (estimateItemId) {
        if (!estimateItem || estimateItem.estimate.projectId !== projectId) {
            throw new Error("Estimate item does not belong to this project");
        }
        if (estimateItem.type === "Section") {
            throw new Error("Estimate sections cannot be scheduled as tasks");
        }
        if (estimateItem.scheduleTask) {
            throw new Error(`Already linked to "${estimateItem.scheduleTask.name}"`);
        }
    }

    const maxOrder = await tx.scheduleTask.aggregate({
        where: { projectId },
        _max: { order: true },
    });
    if (crewIds.length > 0) {
        const activeCrew = await tx.user.findMany({
            where: { id: { in: crewIds }, status: "ACTIVATED" },
            select: { id: true },
        });
        if (activeCrew.length !== crewIds.length) {
            throw new Error("Task crew members must be ACTIVATED users");
        }
    }

    const createData: Prisma.ScheduleTaskUncheckedCreateInput = {
        projectId,
        name,
        startDate,
        endDate,
        color: data.color || getDefaultColorForTaskName(name) || "#4c9a2a",
        status: data.status || "Not Started",
        assignee: data.assignee || null,
        parentId: data.parentId || null,
        order: (maxOrder._max.order ?? -1) + 1,
        type,
        estimateItemId,
        estimatedHours: data.estimatedHours ?? (estimateItem
            ? deriveEstimateItemHours({
                quantity: estimateItem.quantity,
                budgetUnit: estimateItem.budgetUnit,
                childCount: estimateItem._count.subItems,
            })
            : null),
        doneWhen: data.doneWhen?.trim() || null,
        scheduledTime,
        confirmationStatus,
    };
    const created = await tx.scheduleTask.create({ data: createData });
    if (crewIds.length > 0) {
        await tx.taskAssignment.createMany({
            data: crewIds.map(userId => ({
                taskId: created.id,
                userId,
                role: userId === leadUserId ? "lead" : "assigned",
            })),
        });
    }
    if (note && commentAuthor) {
        await tx.taskComment.create({
            data: taskCommentCreateData(created.id, note, commentAuthor),
        });
    }
    await tx.activityLog.create({
        data: {
            projectId,
            actorType: actor.type,
            actorName: actor.name,
            action: "created_schedule_task",
            entityType: "task",
            entityId: created.id,
            entityName: created.name,
            metadata: JSON.stringify({
                name,
                startDate: startDate.toISOString().slice(0, 10),
                endDate: endDate.toISOString().slice(0, 10),
                color: createData.color,
                status: createData.status,
                type,
                estimateItemId,
                crewIds,
                leadUserId,
                estimatedHours: createData.estimatedHours,
                doneWhen: createData.doneWhen,
                note,
                scheduledTime,
                confirmationStatus,
            }),
        },
    });
    return created;
}

export async function updateScheduleTaskInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    data: UpdateScheduleTaskInput,
    actor: ScheduleActor,
    expectedProjectId?: string,
) {
    const locked = await lockTaskAssignmentParent(tx, taskId, expectedProjectId);
    const persisted = await tx.scheduleTask.findUnique({
        where: { id: taskId },
        select: {
            id: true,
            name: true,
            projectId: true,
            type: true,
            status: true,
            blockedReason: true,
            startDate: true,
            endDate: true,
            project: { select: { status: true } },
        },
    });
    if (!persisted || persisted.projectId !== locked.projectId) throw new Error("Task not found");

    if (data.type !== undefined) assertScheduleTaskType(data.type);
    if (data.status !== undefined) assertScheduleTaskStatus(data.status);
    const nextType = data.type ?? persisted.type;
    const nextStatus = data.status ?? persisted.status;
    const updateData: Prisma.ScheduleTaskUncheckedUpdateInput = {};

    if (data.name !== undefined) {
        const name = data.name.trim();
        if (!name) throw new Error("Task name is required");
        updateData.name = name;
    }
    if (data.color !== undefined) updateData.color = data.color;
    if (data.progress !== undefined) {
        if (!Number.isFinite(data.progress)) throw new Error("Progress must be a number");
        updateData.progress = Math.min(100, Math.max(0, Math.round(data.progress)));
    }
    if (data.status !== undefined) updateData.status = data.status;
    if (data.assignee !== undefined) updateData.assignee = data.assignee;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.estimatedHours !== undefined) {
        if (data.estimatedHours != null && (!Number.isFinite(data.estimatedHours) || data.estimatedHours < 0)) {
            throw new Error("Estimated hours must be zero or greater");
        }
        updateData.estimatedHours = data.estimatedHours;
    }
    if (data.type !== undefined) updateData.type = data.type;
    if (data.doneWhen !== undefined) updateData.doneWhen = data.doneWhen?.trim() || null;
    if (data.clientStage !== undefined) {
        const label = data.clientStage?.trim() || null;
        if (label !== null && clientStageIndex(label) === null) {
            throw new Error(`Unknown client stage "${label}"`);
        }
        // Store the canonical label so the tracker's lookup can stay exact.
        updateData.clientStage = label === null
            ? null
            : CLIENT_STAGES[clientStageIndex(label)!].label;
    }
    if (data.status !== undefined || data.blockedReason !== undefined) {
        if (nextStatus === "Blocked") {
            const reasonSource = data.blockedReason !== undefined ? data.blockedReason : persisted.blockedReason;
            const reason = reasonSource?.trim();
            if (!reason) throw new Error("Blocked tasks require a reason");
            updateData.blockedReason = reason;
        } else {
            updateData.blockedReason = null;
        }
    }
    if (data.scheduledTime !== undefined) {
        const scheduledTime = normalizeScheduledTime(data.scheduledTime);
        if (nextType !== "appointment" && scheduledTime) {
            throw new Error("Scheduled time is only available for appointments");
        }
        updateData.scheduledTime = scheduledTime;
    }
    if (data.confirmationStatus !== undefined) {
        if (data.confirmationStatus) assertConfirmationStatus(data.confirmationStatus);
        if (nextType !== "appointment" && data.confirmationStatus) {
            throw new Error("Confirmation status is only available for appointments");
        }
        updateData.confirmationStatus = data.confirmationStatus;
    }
    if (data.type !== undefined && data.type !== "appointment") {
        updateData.scheduledTime = null;
        updateData.confirmationStatus = null;
    }
    if (data.estimateItemId !== undefined) {
        updateData.estimateItemId = data.estimateItemId;
        if (data.estimateItemId) {
            const existing = await tx.scheduleTask.findFirst({
                where: { estimateItemId: data.estimateItemId, id: { not: taskId } },
                select: { id: true, name: true },
            });
            if (existing) throw new Error(`Already linked to "${existing.name}"`);
            const item = await tx.estimateItem.findUnique({
                where: { id: data.estimateItemId },
                select: { type: true, quantity: true, budgetUnit: true },
            });
            if (item && (item.type === "Labor" || item.budgetUnit === "hours")) {
                updateData.estimatedHours = item.quantity || null;
            }
        }
    }

    const hasDatePatch = data.startDate !== undefined || data.endDate !== undefined;
    if (hasDatePatch) {
        if (!persisted.project) throw new Error("Task is not attached to a project");
        if (CLOSED_PROJECT_STATUSES.includes(persisted.project.status)) {
            throw new Error(`Cannot update a task on a closed project (${persisted.project.status})`);
        }
        if (data.type !== undefined && data.type !== persisted.type) {
            throw new Error("Change task type separately before editing its dates");
        }
        const startDate = data.startDate === undefined ? persisted.startDate : parseStartDateInput(data.startDate);
        const requestedEndDate = data.endDate === undefined ? persisted.endDate : parseStartDateInput(data.endDate);
        const endDate = persisted.type === "milestone" ? startDate : requestedEndDate;
        if (persisted.type !== "milestone" && endDate < startDate) {
            throw new Error("Task end date cannot be before its start date");
        }
        updateData.startDate = startDate;
        updateData.endDate = endDate;
    }

    const saved = await tx.scheduleTask.update({
        where: { id: taskId },
        data: updateData,
    });
    if (hasDatePatch) {
        await tx.activityLog.create({
            data: {
                projectId: locked.projectId,
                actorType: actor.type,
                actorName: actor.name,
                action: "updated_company_schedule_task_dates",
                entityType: "task",
                entityId: taskId,
                entityName: persisted.name,
                metadata: JSON.stringify({
                    previousStartDate: persisted.startDate.toISOString().slice(0, 10),
                    previousEndDate: persisted.endDate.toISOString().slice(0, 10),
                    startDate: saved.startDate.toISOString().slice(0, 10),
                    endDate: saved.endDate.toISOString().slice(0, 10),
                    type: persisted.type,
                }),
            },
        });
    }
    return saved;
}

export async function setTaskLeadInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    userId: string | null,
    actor: ScheduleActor,
    expectedProjectId?: string,
) {
    const locked = await lockTaskAssignmentParent(tx, taskId, expectedProjectId);
    const task = await tx.scheduleTask.findUnique({
        where: { id: taskId },
        select: {
            id: true,
            name: true,
            projectId: true,
            assignments: { select: { userId: true, role: true } },
        },
    });
    if (!task || task.projectId !== locked.projectId) throw new Error("Task not found");
    if (userId && !task.assignments.some(assignment => assignment.userId === userId)) {
        throw new Error("Task lead must be assigned to the crew");
    }
    const previousLeadUserId = task.assignments.find(assignment => assignment.role === "lead")?.userId ?? null;
    await tx.taskAssignment.updateMany({
        where: { taskId, role: "lead" },
        data: { role: "assigned" },
    });
    if (userId) {
        await tx.taskAssignment.update({
            where: { taskId_userId: { taskId, userId } },
            data: { role: "lead" },
        });
    }
    await touchTaskAssignmentRevision(tx, taskId);
    await tx.activityLog.create({
        data: {
            projectId: locked.projectId,
            actorType: actor.type,
            actorName: actor.name,
            action: "set_task_lead",
            entityType: "task",
            entityId: taskId,
            entityName: task.name,
            metadata: JSON.stringify({ previousLeadUserId, leadUserId: userId }),
        },
    });
    return tx.taskAssignment.findMany({
        where: { taskId },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { id: true, name: true, email: true } } },
    });
}
