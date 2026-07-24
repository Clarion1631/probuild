import { Prisma } from "@prisma/client";

import { isTaskActiveOnDay } from "@/app/company-dashboard/schedule-board/dispatch-exceptions";
import { prisma } from "@/lib/prisma";
import { canonicalContractEstimateQuery } from "@/lib/schedule-core";

export const TASK_MATERIAL_STATUSES = ["pending", "staged", "missing", "resolved"] as const;
export type TaskMaterialStatus = (typeof TASK_MATERIAL_STATUSES)[number];

export const TASK_MATERIAL_SOURCE_KINDS = ["manual", "estimate", "ai"] as const;
export type TaskMaterialSourceKind = (typeof TASK_MATERIAL_SOURCE_KINDS)[number];

export interface TaskMaterialActor {
    userId: string;
    role: string;
    name: string;
}

export interface TaskMaterialInput {
    text: string;
    quantity?: number | null;
    unit?: string | null;
    location?: string | null;
}

export interface TaskMaterialUpdateInput {
    text?: string;
    quantity?: number | null;
    unit?: string | null;
    location?: string | null;
}

export interface TaskMaterialRow {
    id: string;
    taskId: string;
    text: string;
    quantity: number | null;
    unit: string | null;
    location: string | null;
    status: TaskMaterialStatus;
    sourceKind: TaskMaterialSourceKind;
    sourceEstimateItemId: string | null;
    resolutionNote: string | null;
    order: number;
    createdById: string | null;
    createdByName: string | null;
    createdAt: string;
    updatedAt: string;
    statusChangedById: string | null;
    statusChangedAt: string | null;
}

export interface StagingCounts {
    pending: number;
    staged: number;
    missing: number;
}

export interface StagingMaterialRow {
    id: string;
    taskId: string;
    taskName: string;
    text: string;
    quantity: number | null;
    unit: string | null;
    location: string | null;
    status: TaskMaterialStatus;
    resolutionNote: string | null;
    order: number;
}

export interface StagingProjectGroup {
    projectId: string;
    projectName: string;
    projectLocation: string | null;
    projectColor: string | null;
    materials: StagingMaterialRow[];
    counts: StagingCounts;
}

export interface StagingQueue {
    dayISO: string;
    projects: StagingProjectGroup[];
    counts: StagingCounts;
}

const MATERIAL_SELECT = {
    id: true,
    taskId: true,
    text: true,
    quantity: true,
    unit: true,
    location: true,
    status: true,
    sourceKind: true,
    sourceEstimateItemId: true,
    resolutionNote: true,
    order: true,
    createdById: true,
    createdBy: { select: { name: true, email: true } },
    createdAt: true,
    updatedAt: true,
    statusChangedById: true,
    statusChangedAt: true,
} satisfies Prisma.TaskMaterialSelect;

type SelectedTaskMaterial = Prisma.TaskMaterialGetPayload<{ select: typeof MATERIAL_SELECT }>;

function cleanRequiredText(value: string, label: string, maxLength: number): string {
    const cleaned = value.trim();
    if (!cleaned) throw new Error(`${label} is required`);
    if (cleaned.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters`);
    return cleaned;
}

function cleanOptionalText(
    value: string | null | undefined,
    label: string,
    maxLength: number,
): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const cleaned = value.trim();
    if (!cleaned) return null;
    if (cleaned.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters`);
    return cleaned;
}

function cleanQuantity(value: number | null | undefined): number | null | undefined {
    if (value === undefined || value === null) return value;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error("Quantity must be a non-negative number");
    }
    return value;
}

function assertMaterialStatus(value: string): asserts value is TaskMaterialStatus {
    if (!(TASK_MATERIAL_STATUSES as readonly string[]).includes(value)) {
        throw new Error("Invalid material status");
    }
}

function serializeMaterial(row: SelectedTaskMaterial): TaskMaterialRow {
    assertMaterialStatus(row.status);
    if (!(TASK_MATERIAL_SOURCE_KINDS as readonly string[]).includes(row.sourceKind)) {
        throw new Error("Invalid material source");
    }
    return {
        id: row.id,
        taskId: row.taskId,
        text: row.text,
        quantity: row.quantity === null ? null : Number(row.quantity),
        unit: row.unit,
        location: row.location,
        status: row.status,
        sourceKind: row.sourceKind as TaskMaterialSourceKind,
        sourceEstimateItemId: row.sourceEstimateItemId,
        resolutionNote: row.resolutionNote,
        order: row.order,
        createdById: row.createdById,
        createdByName: row.createdBy?.name ?? row.createdBy?.email ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        statusChangedById: row.statusChangedById,
        statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
    };
}

function activityData(input: {
    projectId: string;
    actor: TaskMaterialActor;
    action: string;
    entityId: string;
    entityName: string;
    metadata?: Record<string, unknown>;
}): Prisma.ActivityLogUncheckedCreateInput {
    return {
        projectId: input.projectId,
        actorType: "TEAM",
        actorName: input.actor.name,
        action: input.action,
        entityType: "task_material",
        entityId: input.entityId,
        entityName: input.entityName,
        metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    };
}

async function materialContext(
    materialId: string,
): Promise<{ material: SelectedTaskMaterial; projectId: string }> {
    const material = await prisma.taskMaterial.findUnique({
        where: { id: materialId },
        select: {
            ...MATERIAL_SELECT,
            task: { select: { projectId: true } },
        },
    });
    if (!material) throw new Error("Material not found");
    if (!material.task.projectId) throw new Error("Task is not attached to a project");
    return { material, projectId: material.task.projectId };
}

export async function getTaskMaterialsCore(taskId: string): Promise<TaskMaterialRow[]> {
    const rows = await prisma.taskMaterial.findMany({
        where: { taskId },
        select: MATERIAL_SELECT,
        orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(serializeMaterial);
}

export async function addTaskMaterialCore(input: {
    taskId: string;
    input: TaskMaterialInput;
    actor: TaskMaterialActor;
}): Promise<TaskMaterialRow> {
    const text = cleanRequiredText(input.input.text, "Material text", 500);
    const quantity = cleanQuantity(input.input.quantity);
    const unit = cleanOptionalText(input.input.unit, "Unit", 40);
    const location = cleanOptionalText(input.input.location, "Location", 120);

    const created = await prisma.$transaction(async tx => {
        const task = await tx.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: { projectId: true },
        });
        if (!task) throw new Error("Task not found");
        if (!task.projectId) throw new Error("Task is not attached to a project");
        const maxOrder = await tx.taskMaterial.aggregate({
            where: { taskId: input.taskId },
            _max: { order: true },
        });
        const row = await tx.taskMaterial.create({
            data: {
                taskId: input.taskId,
                text,
                quantity,
                unit,
                location,
                sourceKind: "manual",
                createdById: input.actor.userId,
                order: (maxOrder._max.order ?? -1) + 1,
            },
            select: MATERIAL_SELECT,
        });
        await tx.activityLog.create({
            data: activityData({
                projectId: task.projectId,
                actor: input.actor,
                action: "add_task_material",
                entityId: row.id,
                entityName: row.text,
                metadata: { taskId: input.taskId, sourceKind: "manual" },
            }),
        });
        return row;
    });
    return serializeMaterial(created);
}

export async function updateTaskMaterialCore(input: {
    materialId: string;
    input: TaskMaterialUpdateInput;
    actor: TaskMaterialActor;
}): Promise<TaskMaterialRow> {
    const existing = await materialContext(input.materialId);
    const data: Prisma.TaskMaterialUncheckedUpdateInput = {};
    if (input.input.text !== undefined) {
        data.text = cleanRequiredText(input.input.text, "Material text", 500);
    }
    if (input.input.quantity !== undefined) {
        data.quantity = cleanQuantity(input.input.quantity);
    }
    if (input.input.unit !== undefined) {
        data.unit = cleanOptionalText(input.input.unit, "Unit", 40);
    }
    if (input.input.location !== undefined) {
        data.location = cleanOptionalText(input.input.location, "Location", 120);
    }
    if (Object.keys(data).length === 0) throw new Error("No material changes provided");

    const updated = await prisma.$transaction(async tx => {
        const row = await tx.taskMaterial.update({
            where: { id: input.materialId },
            data,
            select: MATERIAL_SELECT,
        });
        await tx.activityLog.create({
            data: activityData({
                projectId: existing.projectId,
                actor: input.actor,
                action: "update_task_material",
                entityId: row.id,
                entityName: row.text,
                metadata: { taskId: row.taskId, fields: Object.keys(data) },
            }),
        });
        return row;
    });
    return serializeMaterial(updated);
}

export async function setTaskMaterialStatusCore(input: {
    materialId: string;
    status: string;
    resolutionNote?: string | null;
    actor: TaskMaterialActor;
}): Promise<TaskMaterialRow> {
    assertMaterialStatus(input.status);
    const note = cleanOptionalText(input.resolutionNote, "Resolution note", 500) ?? null;
    if (input.status === "resolved" && !note) {
        throw new Error("Resolved materials require a resolution note");
    }
    const existing = await materialContext(input.materialId);
    const updated = await prisma.$transaction(async tx => {
        const row = await tx.taskMaterial.update({
            where: { id: input.materialId },
            data: {
                status: input.status,
                resolutionNote: input.status === "pending" || input.status === "staged" ? null : note,
                statusChangedById: input.actor.userId,
                statusChangedAt: new Date(),
            },
            select: MATERIAL_SELECT,
        });
        await tx.activityLog.create({
            data: activityData({
                projectId: existing.projectId,
                actor: input.actor,
                action: "set_task_material_status",
                entityId: row.id,
                entityName: row.text,
                metadata: {
                    taskId: row.taskId,
                    previousStatus: existing.material.status,
                    status: row.status,
                    resolutionNote: row.resolutionNote,
                },
            }),
        });
        return row;
    });
    return serializeMaterial(updated);
}

export async function deleteTaskMaterialCore(input: {
    materialId: string;
    actor: TaskMaterialActor;
}): Promise<{ id: string; taskId: string; projectId: string }> {
    const existing = await materialContext(input.materialId);
    const canDelete = ["ADMIN", "MANAGER"].includes(input.actor.role)
        || existing.material.createdById === input.actor.userId;
    if (!canDelete) {
        throw new Error("Only the creator, an admin, or a manager can delete this material");
    }
    await prisma.$transaction(async tx => {
        await tx.taskMaterial.delete({ where: { id: input.materialId } });
        await tx.activityLog.create({
            data: activityData({
                projectId: existing.projectId,
                actor: input.actor,
                action: "delete_task_material",
                entityId: existing.material.id,
                entityName: existing.material.text,
                metadata: {
                    taskId: existing.material.taskId,
                    sourceKind: existing.material.sourceKind,
                },
            }),
        });
    });
    return {
        id: existing.material.id,
        taskId: existing.material.taskId,
        projectId: existing.projectId,
    };
}

export async function importEstimateMaterialsCore(input: {
    taskId: string;
    actor: TaskMaterialActor;
}): Promise<{ created: number }> {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ScheduleTask" WHERE id = ${input.taskId} FOR UPDATE`;
        const task = await tx.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: { projectId: true, estimateItemId: true, name: true },
        });
        if (!task) throw new Error("Task not found");
        if (!task.projectId) throw new Error("Task is not attached to a project");
        if (!task.estimateItemId) throw new Error("Task is not linked to an estimate item");

        const estimate = await tx.estimate.findFirst({
            ...canonicalContractEstimateQuery(task.projectId),
            select: { id: true },
        });
        if (!estimate) throw new Error("No canonical contract estimate found");

        const linkedRoot = await tx.estimateItem.findFirst({
            where: { id: task.estimateItemId, estimateId: estimate.id },
            select: { id: true },
        });
        if (!linkedRoot) {
            throw new Error("Task estimate lineage is outside the canonical contract estimate");
        }

        const candidates = await tx.estimateItem.findMany({
            where: {
                estimateId: estimate.id,
                type: "Material",
                OR: [
                    { id: linkedRoot.id },
                    { parentId: linkedRoot.id },
                ],
            },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            select: {
                id: true,
                name: true,
                quantity: true,
                budgetUnit: true,
            },
        });
        const existingSourceIds = new Set((await tx.taskMaterial.findMany({
            where: {
                taskId: input.taskId,
                sourceEstimateItemId: { in: candidates.map(candidate => candidate.id) },
            },
            select: { sourceEstimateItemId: true },
        })).flatMap(row => row.sourceEstimateItemId ? [row.sourceEstimateItemId] : []));
        const pendingCreates = candidates.filter(candidate => !existingSourceIds.has(candidate.id));
        if (pendingCreates.length === 0) return { created: 0 };

        const maxOrder = await tx.taskMaterial.aggregate({
            where: { taskId: input.taskId },
            _max: { order: true },
        });
        const firstOrder = (maxOrder._max.order ?? -1) + 1;
        await tx.taskMaterial.createMany({
            data: pendingCreates.map((candidate, index) => ({
                taskId: input.taskId,
                text: cleanRequiredText(candidate.name, "Material text", 500),
                quantity: candidate.quantity,
                unit: cleanOptionalText(candidate.budgetUnit, "Unit", 40),
                status: "pending",
                sourceKind: "estimate",
                sourceEstimateItemId: candidate.id,
                createdById: input.actor.userId,
                order: firstOrder + index,
            })),
        });
        await tx.activityLog.create({
            data: {
                projectId: task.projectId,
                actorType: "TEAM",
                actorName: input.actor.name,
                action: "import_estimate_materials",
                entityType: "schedule_task",
                entityId: input.taskId,
                entityName: task.name,
                metadata: JSON.stringify({
                    estimateId: estimate.id,
                    sourceEstimateItemIds: pendingCreates.map(candidate => candidate.id),
                    created: pendingCreates.length,
                }),
            },
        });
        return { created: pendingCreates.length };
    });
}

function emptyCounts(): StagingCounts {
    return { pending: 0, staged: 0, missing: 0 };
}

function addStatus(counts: StagingCounts, status: TaskMaterialStatus): void {
    if (status === "pending" || status === "staged" || status === "missing") {
        counts[status] += 1;
    }
}

function assertDayISO(dayISO: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayISO)) throw new Error("Invalid staging day");
    const parsed = new Date(`${dayISO}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dayISO) {
        throw new Error("Invalid staging day");
    }
}

export async function getStagingQueueCore(dayISO: string): Promise<StagingQueue> {
    assertDayISO(dayISO);
    const rows = await prisma.taskMaterial.findMany({
        where: {
            task: {
                project: { is: { status: "In Progress" } },
            },
        },
        select: {
            id: true,
            text: true,
            quantity: true,
            unit: true,
            location: true,
            status: true,
            resolutionNote: true,
            order: true,
            task: {
                select: {
                    id: true,
                    name: true,
                    startDate: true,
                    endDate: true,
                    type: true,
                    order: true,
                    project: {
                        select: {
                            id: true,
                            name: true,
                            location: true,
                            color: true,
                        },
                    },
                },
            },
        },
    });

    const groups = new Map<string, StagingProjectGroup>();
    for (const row of rows) {
        const project = row.task.project;
        if (!project || !isTaskActiveOnDay({
            type: row.task.type,
            startDate: row.task.startDate.toISOString(),
            endDate: row.task.endDate.toISOString(),
        }, dayISO)) continue;
        assertMaterialStatus(row.status);
        let group = groups.get(project.id);
        if (!group) {
            group = {
                projectId: project.id,
                projectName: project.name,
                projectLocation: project.location,
                projectColor: project.color,
                materials: [],
                counts: emptyCounts(),
            };
            groups.set(project.id, group);
        }
        group.materials.push({
            id: row.id,
            taskId: row.task.id,
            taskName: row.task.name,
            text: row.text,
            quantity: row.quantity === null ? null : Number(row.quantity),
            unit: row.unit,
            location: row.location,
            status: row.status,
            resolutionNote: row.resolutionNote,
            order: row.order,
        });
        addStatus(group.counts, row.status);
    }

    const projects = [...groups.values()]
        .map(group => ({
            ...group,
            materials: group.materials.sort((left, right) =>
                left.taskName.localeCompare(right.taskName)
                || left.order - right.order
                || left.text.localeCompare(right.text)),
        }))
        .sort((left, right) => left.projectName.localeCompare(right.projectName));
    const counts = projects.reduce((total, group) => ({
        pending: total.pending + group.counts.pending,
        staged: total.staged + group.counts.staged,
        missing: total.missing + group.counts.missing,
    }), emptyCounts());
    return { dayISO, projects, counts };
}
