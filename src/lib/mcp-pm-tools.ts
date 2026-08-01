import type { Prisma } from "@prisma/client";

import { createDailyLogCore } from "./daily-log-core";
import {
    executeConfirmed,
    issueConfirmation,
} from "./mcp-schedule-tools";
import type { McpActorContext } from "./mcp-actor";
import { prisma } from "./prisma";
import { ensureStandardFolders } from "./project-folders";
import { appendPunchItemsInTransaction } from "./punch-items";
import { lockTaskAssignmentParent } from "./schedule-core";

type PmDb = Pick<
    Prisma.TransactionClient,
    "activityLog" | "dailyLog" | "fileFolder" | "lead" | "project" | "projectFile" | "scheduleTask" | "taskPunchItem"
>;

type OwnerInput = {
    projectId?: string;
    leadId?: string;
};

type FolderVisibility = "team" | "shared";

function ownerWhere(owner: { projectId: string | null; leadId: string | null }) {
    return {
        projectId: owner.projectId,
        leadId: owner.leadId,
    };
}

function sameOwner(
    left: { projectId: string | null; leadId: string | null },
    right: { projectId: string | null; leadId: string | null },
): boolean {
    return left.projectId === right.projectId && left.leadId === right.leadId;
}

async function resolveOwner(
    input: OwnerInput,
    db: Pick<Prisma.TransactionClient, "lead" | "project"> = prisma,
): Promise<{ projectId: string | null; leadId: string | null; name: string }> {
    if ((input.projectId ? 1 : 0) + (input.leadId ? 1 : 0) !== 1) {
        throw new Error("Provide exactly one of projectId or leadId.");
    }
    if (input.projectId) {
        const project = await db.project.findUnique({
            where: { id: input.projectId },
            select: { id: true, name: true },
        });
        if (!project) throw new Error("Project not found");
        return { projectId: project.id, leadId: null, name: project.name };
    }
    const lead = await db.lead.findUnique({
        where: { id: input.leadId! },
        select: { id: true, name: true },
    });
    if (!lead) throw new Error("Lead not found");
    return { projectId: null, leadId: lead.id, name: lead.name };
}

async function writeActivity(
    db: Pick<Prisma.TransactionClient, "activityLog">,
    actor: McpActorContext,
    input: {
        projectId?: string | null;
        leadId?: string | null;
        action: string;
        entityType: string;
        entityId: string;
        entityName: string;
        metadata?: Record<string, unknown>;
    },
): Promise<void> {
    const actorName = `SYSTEM:${actor.actorLabel}`;
    await db.activityLog.create({
        data: {
            projectId: input.projectId ?? null,
            leadId: input.leadId ?? null,
            actorType: "SYSTEM",
            actorName,
            action: input.action,
            entityType: input.entityType,
            entityId: input.entityId,
            entityName: input.entityName,
            metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        },
    });
}

async function executePmConfirmed<T extends Record<string, unknown>>(
    toolName: string,
    args: unknown,
    confirmToken: string,
    actor: McpActorContext,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
) {
    return executeConfirmed(toolName, args, confirmToken, write, actor.actorLabel, "MCP");
}

export async function listProjectFiles(input: OwnerInput) {
    const owner = await resolveOwner(input);
    if (owner.projectId) {
        const topLevelCount = await prisma.fileFolder.count({
            where: { projectId: owner.projectId, parentId: null },
        });
        if (topLevelCount === 0) await ensureStandardFolders(owner.projectId);
    }

    const [folders, files] = await Promise.all([
        prisma.fileFolder.findMany({
            where: ownerWhere(owner),
            orderBy: [{ name: "asc" }, { id: "asc" }],
            select: {
                id: true,
                name: true,
                visibility: true,
                parentId: true,
                createdAt: true,
            },
        }),
        prisma.projectFile.findMany({
            where: ownerWhere(owner),
            orderBy: [{ createdAt: "desc" }, { name: "asc" }],
            select: {
                id: true,
                name: true,
                size: true,
                mimeType: true,
                visibility: true,
                folderId: true,
                createdAt: true,
                folder: { select: { name: true, visibility: true } },
            },
        }),
    ]);

    type FileRow = {
        id: string;
        name: string;
        size: number;
        mimeType: string;
        visibility: string;
        folder: string | null;
        createdAt: Date;
    };
    type FolderNode = {
        id: string;
        name: string;
        visibility: string;
        parentFolderId: string | null;
        createdAt: Date;
        files: FileRow[];
        children: FolderNode[];
    };
    const nodes = new Map<string, FolderNode>();
    for (const folder of folders) {
        nodes.set(folder.id, {
            id: folder.id,
            name: folder.name,
            visibility: folder.visibility,
            parentFolderId: folder.parentId,
            createdAt: folder.createdAt,
            files: [],
            children: [],
        });
    }
    const unfiled: FileRow[] = [];
    for (const file of files) {
        const row = {
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            visibility: file.visibility ?? file.folder?.visibility ?? "team",
            folder: file.folder?.name ?? null,
            createdAt: file.createdAt,
        };
        const node = file.folderId ? nodes.get(file.folderId) : null;
        if (node) node.files.push(row);
        else unfiled.push(row);
    }
    const roots: FolderNode[] = [];
    for (const folder of folders) {
        const node = nodes.get(folder.id)!;
        const parent = folder.parentId ? nodes.get(folder.parentId) : null;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }
    return {
        target: {
            projectId: owner.projectId,
            leadId: owner.leadId,
            name: owner.name,
        },
        folders: roots,
        unfiled,
        note: "No file URLs are returned here. Use read_file for extracted text or get_file_link for a viewable/download link.",
    };
}

type CreateFolderInput = OwnerInput & {
    name: string;
    parentFolderId?: string;
    visibility?: FolderVisibility;
    confirmToken?: string;
};

async function resolveFolderCreate(
    input: CreateFolderInput,
    db: PmDb,
) {
    const owner = await resolveOwner(input, db);
    const name = input.name.trim();
    if (!name) throw new Error("Folder name is required");
    const parentFolderId = input.parentFolderId ?? null;
    const visibility = input.visibility ?? "team";
    const parent = parentFolderId
        ? await db.fileFolder.findUnique({
            where: { id: parentFolderId },
            select: { id: true, name: true, visibility: true, projectId: true, leadId: true },
        })
        : null;
    if (parentFolderId && !parent) throw new Error("Parent folder not found");
    if (parent && !sameOwner(owner, parent)) {
        throw new Error("Parent folder must belong to the same project or lead.");
    }
    if (parent && visibility === "shared" && parent.visibility !== "shared") {
        throw new Error(`Parent folder "${parent.name}" is not shared, so a shared child folder would be unreachable in the customer portal.`);
    }
    const existing = await db.fileFolder.findFirst({
        where: {
            ...ownerWhere(owner),
            parentId: parentFolderId,
            name: { equals: name, mode: "insensitive" },
        },
        select: { id: true, name: true },
    });
    if (existing) throw new Error(`Folder "${existing.name}" already exists at that level.`);
    return { owner, name, parentFolderId, visibility };
}

export async function createFolderWithConfirmation(
    input: CreateFolderInput,
    actor: McpActorContext,
) {
    const args = {
        projectId: input.projectId,
        leadId: input.leadId,
        name: input.name.trim(),
        parentFolderId: input.parentFolderId,
        visibility: input.visibility ?? "team",
    };
    if (!input.confirmToken) {
        const plan = await resolveFolderCreate(input, prisma);
        return issueConfirmation(
            "create_folder",
            args,
            `Create ${plan.visibility} folder "${plan.name}"${plan.parentFolderId ? " inside the selected parent folder" : ""} on "${plan.owner.name}".`,
            actor.actorLabel,
        );
    }
    return executePmConfirmed("create_folder", args, input.confirmToken, actor, async tx => {
        const plan = await resolveFolderCreate(input, tx);
        const folder = await tx.fileFolder.create({
            data: {
                ...ownerWhere(plan.owner),
                name: plan.name,
                parentId: plan.parentFolderId,
                visibility: plan.visibility,
            },
            select: { id: true, name: true, visibility: true, parentId: true },
        });
        await writeActivity(tx, actor, {
            ...ownerWhere(plan.owner),
            action: "created_folder",
            entityType: "file_folder",
            entityId: folder.id,
            entityName: folder.name,
            metadata: { visibility: folder.visibility, parentFolderId: folder.parentId },
        });
        return {
            folderId: folder.id,
            name: folder.name,
            visibility: folder.visibility,
            parentFolderId: folder.parentId,
        };
    });
}

type MoveFileInput = {
    fileId: string;
    folderId: string | null;
    visibility?: FolderVisibility;
    confirmToken?: string;
};

async function resolveMoveFile(input: MoveFileInput, db: PmDb) {
    const file = await db.projectFile.findUnique({
        where: { id: input.fileId },
        select: {
            id: true,
            name: true,
            projectId: true,
            leadId: true,
            folderId: true,
            visibility: true,
            folder: { select: { name: true, visibility: true } },
        },
    });
    if (!file) throw new Error("File not found");
    const targetFolder = input.folderId
        ? await db.fileFolder.findUnique({
            where: { id: input.folderId },
            select: { id: true, name: true, visibility: true, projectId: true, leadId: true },
        })
        : null;
    if (input.folderId && !targetFolder) throw new Error("Target folder not found");
    if (targetFolder && !sameOwner(file, targetFolder)) {
        throw new Error("Cross-project/lead moves are refused; the file and folder must belong to the same project or lead.");
    }

    const currentEffective = file.visibility ?? file.folder?.visibility ?? "team";
    const targetFolderVisibility = targetFolder?.visibility ?? "team";
    const nextEffective = input.visibility ?? file.visibility ?? targetFolderVisibility;
    if (
        currentEffective === "team"
        && targetFolderVisibility === "shared"
        && input.visibility !== "shared"
    ) {
        throw new Error("Moving this team file into a shared folder could expose it to the customer. Pass visibility \"shared\" explicitly in the same call to approve that change.");
    }
    if (targetFolder && targetFolder.visibility !== "shared" && nextEffective === "shared") {
        throw new Error(`Folder "${targetFolder.name}" is not shared, so a shared file inside it would be unreachable in the customer portal.`);
    }
    return {
        file,
        targetFolder,
        currentEffective,
        nextVisibility: input.visibility,
        nextEffective,
    };
}

export async function moveFileWithConfirmation(
    input: MoveFileInput,
    actor: McpActorContext,
) {
    const args = {
        fileId: input.fileId,
        folderId: input.folderId,
        visibility: input.visibility,
    };
    if (!input.confirmToken) {
        const plan = await resolveMoveFile(input, prisma);
        return issueConfirmation(
            "move_file",
            args,
            `Move "${plan.file.name}" to ${plan.targetFolder ? `folder "${plan.targetFolder.name}"` : "the top level"} with effective visibility ${plan.nextEffective}.`,
            actor.actorLabel,
        );
    }
    return executePmConfirmed("move_file", args, input.confirmToken, actor, async tx => {
        const plan = await resolveMoveFile(input, tx);
        const file = await tx.projectFile.update({
            where: { id: input.fileId },
            data: {
                folderId: input.folderId,
                ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            },
            select: {
                id: true,
                name: true,
                folderId: true,
                visibility: true,
                projectId: true,
                leadId: true,
            },
        });
        await writeActivity(tx, actor, {
            projectId: file.projectId,
            leadId: file.leadId,
            action: "moved_file",
            entityType: "project_file",
            entityId: file.id,
            entityName: file.name,
            metadata: {
                fromFolderId: plan.file.folderId,
                toFolderId: file.folderId,
                visibility: file.visibility,
            },
        });
        return {
            fileId: file.id,
            name: file.name,
            folderId: file.folderId,
            visibility: file.visibility ?? plan.nextEffective,
        };
    });
}

export async function listDailyLogs(input: {
    projectId: string;
    since?: string;
    limit?: number;
}) {
    const project = await prisma.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, name: true },
    });
    if (!project) throw new Error("Project not found");
    const limit = input.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("limit must be a whole number from 1 through 100");
    }
    const since = input.since ? new Date(`${input.since}T00:00:00.000Z`) : null;
    if (since && Number.isNaN(since.getTime())) throw new Error("since must use YYYY-MM-DD");
    const logs = await prisma.dailyLog.findMany({
        where: {
            projectId: input.projectId,
            ...(since ? { date: { gte: since } } : {}),
        },
        take: limit,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        select: {
            id: true,
            date: true,
            weather: true,
            crewOnSite: true,
            workPerformed: true,
            materialsDelivered: true,
            issues: true,
            sharedToPortal: true,
            _count: { select: { photos: true } },
        },
    });
    return {
        project: { id: project.id, name: project.name },
        logs: logs.map(log => ({
            id: log.id,
            date: log.date.toISOString().slice(0, 10),
            weather: log.weather,
            crewOnSite: log.crewOnSite,
            workPerformed: log.workPerformed,
            materialsDelivered: log.materialsDelivered,
            issues: log.issues,
            photoCount: log._count.photos,
            sharedToPortal: log.sharedToPortal,
        })),
    };
}

type CreateDailyLogInput = {
    projectId: string;
    date: string;
    weather?: string;
    crewOnSite?: string;
    workPerformed: string;
    materialsDelivered?: string;
    issues?: string;
    photos?: Array<{ fileId: string; caption?: string }>;
    confirmToken?: string;
};

async function resolveDailyLogPhotos(
    db: PmDb,
    projectId: string,
    photos: Array<{ fileId: string; caption?: string }>,
) {
    const uniqueIds = [...new Set(photos.map(photo => photo.fileId))];
    const files = uniqueIds.length > 0
        ? await db.projectFile.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true, name: true, url: true, mimeType: true, projectId: true },
        })
        : [];
    const byId = new Map(files.map(file => [file.id, file]));
    return photos.map(photo => {
        const file = byId.get(photo.fileId);
        if (!file) throw new Error(`ProjectFile not found: ${photo.fileId}`);
        if (file.projectId !== projectId) {
            throw new Error(`Photo file "${file.name}" must belong to the same project as the daily log.`);
        }
        if (!file.mimeType.startsWith("image/")) {
            throw new Error(`ProjectFile "${file.name}" is not an image.`);
        }
        return {
            fileId: file.id,
            name: file.name,
            url: file.url,
            caption: photo.caption?.trim() || undefined,
        };
    });
}

export async function createDailyLogWithConfirmation(
    input: CreateDailyLogInput,
    actor: McpActorContext,
) {
    if (!actor.actorUserId) {
        throw new Error(`The ${actor.actorLabel} attribution user is not seeded yet, so a daily log cannot be created safely.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must use YYYY-MM-DD");
    const workPerformed = input.workPerformed.trim();
    if (!workPerformed) throw new Error("workPerformed is required");
    const photos = input.photos ?? [];
    const args = {
        projectId: input.projectId,
        date: input.date,
        weather: input.weather?.trim() || undefined,
        crewOnSite: input.crewOnSite?.trim() || undefined,
        workPerformed,
        materialsDelivered: input.materialsDelivered?.trim() || undefined,
        issues: input.issues?.trim() || undefined,
        photos: photos.map(photo => ({
            fileId: photo.fileId,
            caption: photo.caption?.trim() || undefined,
        })),
    };
    if (!input.confirmToken) {
        const project = await prisma.project.findUnique({
            where: { id: input.projectId },
            select: { name: true },
        });
        if (!project) throw new Error("Project not found");
        const resolvedPhotos = await resolveDailyLogPhotos(prisma, input.projectId, args.photos);
        return issueConfirmation(
            "create_daily_log",
            args,
            `Create the ${input.date} daily log on "${project.name}" with ${resolvedPhotos.length} photo${resolvedPhotos.length === 1 ? "" : "s"}: ${workPerformed}`,
            actor.actorLabel,
        );
    }
    return executePmConfirmed("create_daily_log", args, input.confirmToken, actor, async tx => {
        const project = await tx.project.findUnique({
            where: { id: input.projectId },
            select: { id: true, name: true },
        });
        if (!project) throw new Error("Project not found");
        const resolvedPhotos = await resolveDailyLogPhotos(tx, input.projectId, args.photos);
        const log = await createDailyLogCore({
            projectId: input.projectId,
            actorUserId: actor.actorUserId!,
            date: args.date,
            weather: args.weather,
            crewOnSite: args.crewOnSite,
            workPerformed: args.workPerformed,
            materialsDelivered: args.materialsDelivered,
            issues: args.issues,
            photoUrls: resolvedPhotos.map(photo => ({
                url: photo.url,
                caption: photo.caption,
            })),
        }, tx);
        await writeActivity(tx, actor, {
            projectId: input.projectId,
            action: "created_daily_log",
            entityType: "daily_log",
            entityId: log.id,
            entityName: `${project.name} daily log ${args.date}`,
            metadata: { photoFileIds: resolvedPhotos.map(photo => photo.fileId) },
        });
        return {
            dailyLogId: log.id,
            projectId: input.projectId,
            date: log.date.toISOString().slice(0, 10),
            photoCount: log.photos.length,
            sharedToPortal: log.sharedToPortal,
        };
    });
}

export async function listPunchItems(input: {
    taskId?: string;
    projectId?: string;
    status?: "open" | "completed" | "all";
}) {
    if ((input.taskId ? 1 : 0) + (input.projectId ? 1 : 0) !== 1) {
        throw new Error("Provide exactly one of taskId or projectId.");
    }
    const status = input.status ?? "open";
    const items = await prisma.taskPunchItem.findMany({
        where: {
            ...(input.taskId ? { taskId: input.taskId } : { task: { projectId: input.projectId } }),
            ...(status === "all" ? {} : { completed: status === "completed" }),
        },
        orderBy: [{ task: { order: "asc" } }, { order: "asc" }, { createdAt: "asc" }],
        select: {
            id: true,
            taskId: true,
            name: true,
            completed: true,
            completedAt: true,
            assignee: true,
            order: true,
            task: {
                select: {
                    name: true,
                    projectId: true,
                },
            },
        },
    });
    return {
        status,
        items: items.map(item => ({
            id: item.id,
            taskId: item.taskId,
            taskName: item.task.name,
            projectId: item.task.projectId,
            name: item.name,
            assignee: item.assignee,
            order: item.order,
            completed: item.completed,
            completedAt: item.completedAt,
        })),
    };
}

type AddPunchItemsInput = {
    taskId: string;
    items: string[];
    confirmToken?: string;
};

export async function addPunchItemsWithConfirmation(
    input: AddPunchItemsInput,
    actor: McpActorContext,
) {
    if (input.items.length < 1 || input.items.length > 30) {
        throw new Error("add_punch_items accepts between 1 and 30 items.");
    }
    const items = input.items.map(item => item.trim());
    if (items.some(item => !item)) throw new Error("Punch item names cannot be empty.");
    const args = { taskId: input.taskId, items };
    if (!input.confirmToken) {
        const task = await prisma.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: { name: true, project: { select: { name: true } } },
        });
        if (!task) throw new Error("Task not found");
        return issueConfirmation(
            "add_punch_items",
            args,
            `Add ${items.length} punch item${items.length === 1 ? "" : "s"} to "${task.name}" on "${task.project?.name ?? "the job"}":\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
            actor.actorLabel,
        );
    }
    return executePmConfirmed("add_punch_items", args, input.confirmToken, actor, async tx => {
        const task = await tx.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: { id: true, name: true, projectId: true },
        });
        if (!task) throw new Error("Task not found");
        // Lock Project → ScheduleTask in the canonical order when the task has a
        // project (lead tasks don't): writeActivity's Project FK would otherwise
        // take Project after the task lock, inverting against schedule mutations
        // that lock Project first (deadlock risk).
        if (task.projectId) await lockTaskAssignmentParent(tx, task.id, task.projectId);
        const created = await appendPunchItemsInTransaction(tx, input.taskId, items, actor.actorUserId);
        await writeActivity(tx, actor, {
            projectId: task.projectId,
            action: "added_punch_items",
            entityType: "schedule_task",
            entityId: task.id,
            entityName: task.name,
            metadata: { punchItemIds: created.map(item => item.id) },
        });
        return {
            taskId: task.id,
            created: created.map(item => ({ id: item.id, name: item.name, order: item.order })),
        };
    });
}

export async function getProjectContacts(input: { projectId: string }) {
    const project = await prisma.project.findUnique({
        where: { id: input.projectId },
        select: {
            id: true,
            name: true,
            location: true,
            client: {
                select: {
                    name: true,
                    email: true,
                    primaryPhone: true,
                },
            },
            manager: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                },
            },
            crew: {
                orderBy: [{ name: "asc" }, { id: "asc" }],
                select: {
                    id: true,
                    name: true,
                    role: true,
                },
            },
            scheduleTasks: {
                select: {
                    id: true,
                    name: true,
                    subAssignments: {
                        select: {
                            subcontractor: {
                                select: {
                                    id: true,
                                    companyName: true,
                                    trade: true,
                                    contactName: true,
                                    email: true,
                                    phone: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!project) throw new Error("Project not found");

    const subcontractors = new Map<string, {
        id: string;
        company: string;
        trade: string | null;
        contact: { name: string | null; email: string; phone: string | null };
        tasks: Array<{ id: string; name: string }>;
    }>();
    for (const task of project.scheduleTasks) {
        for (const assignment of task.subAssignments) {
            const sub = assignment.subcontractor;
            const current = subcontractors.get(sub.id) ?? {
                id: sub.id,
                company: sub.companyName,
                trade: sub.trade,
                contact: {
                    name: sub.contactName,
                    email: sub.email,
                    phone: sub.phone,
                },
                tasks: [],
            };
            if (!current.tasks.some(existing => existing.id === task.id)) {
                current.tasks.push({ id: task.id, name: task.name });
            }
            subcontractors.set(sub.id, current);
        }
    }

    return {
        project: {
            id: project.id,
            name: project.name,
            location: project.location,
        },
        client: project.client ? {
            name: project.client.name,
            email: project.client.email,
            phone: project.client.primaryPhone,
        } : null,
        manager: project.manager,
        crew: project.crew.map(member => ({
            id: member.id,
            name: member.name,
            role: member.role,
        })),
        subcontractors: [...subcontractors.values()].sort((left, right) =>
            left.company.localeCompare(right.company),
        ),
    };
}
