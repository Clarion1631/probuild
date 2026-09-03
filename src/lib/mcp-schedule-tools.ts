import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";

import { addDays } from "@/app/projects/[id]/schedule/schedule-utils";
import { prisma } from "./prisma";
import { displayEndDate } from "./schedule-dates";
import { ScheduleTaskValidationError } from "./schedule-task-result";
import {
    applyChangeOrderToScheduleInTransaction,
    canonicalContractEstimateQuery,
    generateScheduleFromEstimateInTransaction,
    parseStartDateInput,
    setProjectCrewInTransaction,
    setProjectStartDateInTransaction,
    setTaskCrewInTransaction,
    type ScheduleActor,
} from "./schedule-core";
import {
    SCHEDULE_TASK_STATUSES,
    SCHEDULE_TASK_TYPES,
    createScheduleTaskInTransaction,
    setTaskLeadInTransaction,
    updateScheduleTaskInTransaction,
    type CreateScheduleTaskInput,
    type ScheduleTaskStatus,
    type ScheduleTaskType,
} from "./schedule-task-core";
import { withTxRetry } from "./tx-retry";
import {
    mcpActivityActorName,
    type McpActorLabel,
} from "./mcp-actor";

const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MCP_ACTOR_LABEL: McpActorLabel = "justin-ai";

function scheduleActor(actorLabel: McpActorLabel): ScheduleActor {
    return { type: "SYSTEM", name: mcpActivityActorName(actorLabel) };
}

type CanonicalValue =
    | null
    | boolean
    | number
    | string
    | CanonicalValue[]
    | { [key: string]: CanonicalValue };

export interface McpConfirmationPreview {
    confirmationRequired: true;
    preview: string;
    confirmToken: string;
    expiresAt: string;
    instruction: string;
}

export interface PlanScheduleTaskInput {
    name: string;
    startDate: string;
    endDate: string;
    type?: ScheduleTaskType;
    crewNames?: string[];
    leadName?: string;
    doneWhen?: string;
    scheduledTime?: string;
    estimatedHours?: number;
}

function canonicalize(value: unknown): CanonicalValue {
    if (value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(item => canonicalize(item));
    if (typeof value === "object") {
        const output: { [key: string]: CanonicalValue } = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const child = (value as Record<string, unknown>)[key];
            if (child !== undefined) output[key] = canonicalize(child);
        }
        return output;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    throw new Error(`Unsupported confirmation argument type: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

export function scheduleArgsHash(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function issueConfirmation(
    toolName: string,
    args: unknown,
    preview: string,
    actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL,
): Promise<McpConfirmationPreview> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
    await prisma.mcpConfirmation.create({
        data: {
            token,
            toolName,
            actorLabel,
            argsHash: scheduleArgsHash(args),
            preview,
            expiresAt,
        },
    });
    return {
        confirmationRequired: true,
        preview,
        confirmToken: token,
        expiresAt: expiresAt.toISOString(),
        instruction:
            "Show this preview to the user. Call the same tool again with this confirmToken only after explicit approval. The token is single-use and expires in 10 minutes.",
    };
}

export async function executeConfirmed<T extends Record<string, unknown>>(
    toolName: string,
    args: unknown,
    confirmToken: string,
    // eslint-disable-next-line no-unused-vars
    write: (tx: Prisma.TransactionClient) => Promise<T>,
    actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL,
    confirmationKind = "schedule",
): Promise<T & { confirmed: true }> {
    const argsHash = scheduleArgsHash(args);
    return withTxRetry(() => prisma.$transaction(async tx => {
        const row = await tx.mcpConfirmation.findUnique({
            where: { token: confirmToken },
            select: {
                toolName: true,
                actorLabel: true,
                argsHash: true,
                expiresAt: true,
                consumedAt: true,
            },
        });
        if (!row) throw new Error(`Invalid ${confirmationKind} confirmation token`);
        if (row.actorLabel !== actorLabel) {
            throw new Error("Confirmation token belongs to a different MCP actor/key; request a new preview");
        }
        if (row.toolName !== toolName || row.argsHash !== argsHash) {
            throw new Error("Confirmation token does not match this tool and its arguments; request a new preview");
        }
        if (row.expiresAt <= new Date()) throw new Error(`${confirmationKind[0].toUpperCase()}${confirmationKind.slice(1)} confirmation token has expired`);
        if (row.consumedAt) throw new Error(`${confirmationKind[0].toUpperCase()}${confirmationKind.slice(1)} confirmation token was already used`);

        const claim = await tx.mcpConfirmation.updateMany({
            where: {
                token: confirmToken,
                toolName,
                actorLabel,
                argsHash,
                expiresAt: { gt: new Date() },
                consumedAt: null,
            },
            data: { consumedAt: new Date() },
        });
        if (claim.count !== 1) {
            throw new Error(`${confirmationKind[0].toUpperCase()}${confirmationKind.slice(1)} confirmation token was already consumed by another request`);
        }

        const result = await write(tx);
        return { ...result, confirmed: true as const };
    }));
}

function cleanCrewNames(names: string[] | undefined): string[] {
    return [...new Set((names ?? []).map(name => name.trim()).filter(Boolean))];
}

async function resolveCrewNames(
    tx: Prisma.TransactionClient,
    names: string[],
): Promise<{ id: string; name: string }[]> {
    if (names.length === 0) return [];
    const users = await tx.user.findMany({
        where: { status: "ACTIVATED" },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, email: true },
    });
    const resolved: { id: string; name: string }[] = [];
    for (const raw of names) {
        const needle = raw.trim().toLocaleLowerCase();
        const fullMatches = users.filter(user => (user.name ?? "").trim().toLocaleLowerCase() === needle);
        const matches = fullMatches.length > 0
            ? fullMatches
            : users.filter(user => (user.name ?? "").trim().split(/\s+/)[0]?.toLocaleLowerCase() === needle);
        if (matches.length === 0) {
            throw new Error(`No ACTIVATED crew member matches "${raw}"`);
        }
        if (matches.length > 1) {
            throw new Error(
                `Crew name "${raw}" is ambiguous. Candidates: ${matches
                    .map(user => `${user.name || user.email} (${user.id})`)
                    .join(", ")}`,
            );
        }
        const match = matches[0];
        if (!resolved.some(user => user.id === match.id)) {
            resolved.push({ id: match.id, name: match.name || match.email });
        }
    }
    return resolved;
}

function validatePlannedTask(task: PlanScheduleTaskInput): void {
    if (!task.name.trim()) throw new ScheduleTaskValidationError("Task name is required");
    const type = task.type ?? "task";
    if (!(SCHEDULE_TASK_TYPES as readonly string[]).includes(type)) {
        throw new ScheduleTaskValidationError(`Invalid schedule task type "${type}"`);
    }
    const startDate = parseStartDateInput(task.startDate);
    const endDate = parseStartDateInput(task.endDate);
    if (type !== "milestone" && endDate <= startDate) {
        throw new ScheduleTaskValidationError("Task end date must be after its start date (the end date is the day after the last day of work)");
    }
    if (task.estimatedHours != null && (!Number.isFinite(task.estimatedHours) || task.estimatedHours < 0)) {
        throw new ScheduleTaskValidationError("Estimated hours must be zero or greater");
    }
    if (task.scheduledTime !== undefined) {
        if (type !== "appointment") throw new Error("Scheduled time is only available for appointments");
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.scheduledTime.trim())) {
            throw new Error("Scheduled time must use 24-hour HH:MM format");
        }
    }
}

async function resolvePlanTask(
    tx: Prisma.TransactionClient,
    task: PlanScheduleTaskInput,
): Promise<{ create: CreateScheduleTaskInput; crew: { id: string; name: string }[]; lead: { id: string; name: string } | null }> {
    validatePlannedTask(task);
    const crewNames = cleanCrewNames(task.crewNames);
    const crew = await resolveCrewNames(tx, crewNames);
    const lead = task.leadName
        ? (await resolveCrewNames(tx, [task.leadName]))[0]
        : null;
    if (lead && !crew.some(member => member.id === lead.id)) {
        throw new Error(`Task lead "${task.leadName}" must also appear in crewNames`);
    }
    return {
        create: {
            name: task.name.trim(),
            startDate: task.startDate,
            endDate: task.endDate,
            type: task.type,
            crewIds: crew.map(member => member.id),
            leadUserId: lead?.id ?? null,
            doneWhen: task.doneWhen,
            scheduledTime: task.scheduledTime,
            estimatedHours: task.estimatedHours,
        },
        crew,
        lead,
    };
}

async function resolveProject(input: { projectId?: string; jobName?: string }) {
    if ((input.projectId ? 1 : 0) + (input.jobName ? 1 : 0) !== 1) {
        throw new Error("Provide exactly one of projectId or jobName");
    }
    if (input.projectId) {
        const project = await prisma.project.findUnique({
            where: { id: input.projectId },
            select: { id: true, name: true, status: true, startDate: true, endDate: true },
        });
        if (!project) throw new Error("Project not found");
        return project;
    }
    const projects = await prisma.project.findMany({
        where: { name: { equals: input.jobName!.trim(), mode: "insensitive" } },
        take: 3,
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, status: true, startDate: true, endDate: true },
    });
    if (projects.length === 0) throw new Error(`No project named "${input.jobName}"`);
    if (projects.length > 1) {
        throw new Error(`Project name "${input.jobName}" is ambiguous; use projectId`);
    }
    return projects[0];
}

export async function getProjectSchedule(input: { projectId?: string; jobName?: string }) {
    const project = await resolveProject(input);
    const tasks = await prisma.scheduleTask.findMany({
        where: { projectId: project.id },
        orderBy: [{ order: "asc" }, { startDate: "asc" }, { id: "asc" }],
        select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            status: true,
            progress: true,
            type: true,
            doneWhen: true,
            scheduledTime: true,
            confirmationStatus: true,
            estimatedHours: true,
            assignments: {
                orderBy: { createdAt: "asc" },
                select: {
                    role: true,
                    user: { select: { id: true, name: true, email: true } },
                },
            },
        },
    });
    const taskIds = tasks.map(task => task.id);
    const materialRows = taskIds.length > 0
        ? await prisma.taskMaterial.groupBy({
            by: ["taskId", "status"],
            where: { taskId: { in: taskIds } },
            _count: { id: true },
        })
        : [];
    const materialCounts = new Map<string, { pending: number; staged: number; missing: number; resolved: number; total: number }>();
    for (const row of materialRows) {
        const counts = materialCounts.get(row.taskId) ?? {
            pending: 0,
            staged: 0,
            missing: 0,
            resolved: 0,
            total: 0,
        };
        if (row.status === "pending" || row.status === "staged" || row.status === "missing" || row.status === "resolved") {
            counts[row.status] = row._count.id;
        }
        counts.total += row._count.id;
        materialCounts.set(row.taskId, counts);
    }
    return {
        projectId: project.id,
        jobName: project.name,
        status: project.status,
        startDate: project.startDate?.toISOString().slice(0, 10) ?? null,
        endDate: project.endDate?.toISOString().slice(0, 10) ?? null,
        tasks: tasks.map(task => {
            const crew = task.assignments.map(assignment => ({
                userId: assignment.user.id,
                name: assignment.user.name || assignment.user.email,
                role: assignment.role,
            }));
            return {
                id: task.id,
                name: task.name,
                startDate: task.startDate.toISOString().slice(0, 10),
                endDate: task.endDate.toISOString().slice(0, 10),
                status: task.status,
                progress: task.progress,
                type: task.type,
                doneWhen: task.doneWhen,
                scheduledTime: task.scheduledTime,
                confirmationStatus: task.confirmationStatus,
                estimatedHours: task.estimatedHours,
                crew,
                leadName: crew.find(member => member.role === "lead")?.name ?? null,
                materialCounts: materialCounts.get(task.id) ?? {
                    pending: 0,
                    staged: 0,
                    missing: 0,
                    resolved: 0,
                    total: 0,
                },
            };
        }),
    };
}

export async function planSchedule(input: {
    projectId: string;
    tasks: PlanScheduleTaskInput[];
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    if (input.tasks.length === 0) throw new Error("plan_schedule requires at least one task");
    if (input.tasks.length > 50) throw new Error("plan_schedule accepts at most 50 tasks");
    const args = { projectId: input.projectId, tasks: input.tasks };

    if (!input.confirmToken) {
        const resolved = await prisma.$transaction(async tx => {
            const project = await tx.project.findUnique({
                where: { id: input.projectId },
                select: { id: true, name: true },
            });
            if (!project) throw new Error("Project not found");
            const tasks = [];
            for (const task of input.tasks) tasks.push(await resolvePlanTask(tx, task));
            return { project, tasks };
        });
        const preview = [
            `Create ${resolved.tasks.length} schedule task${resolved.tasks.length === 1 ? "" : "s"} on "${resolved.project.name}":`,
            ...resolved.tasks.map((task, index) => {
                const source = input.tasks[index];
                const crew = task.crew.map(member => member.name).join(", ") || "unassigned";
                return `${index + 1}. ${source.name.trim()} — ${source.startDate} to ${source.endDate}; crew: ${crew}${task.lead ? `; lead: ${task.lead.name}` : ""}`;
            }),
        ].join("\n");
        return issueConfirmation("plan_schedule", args, preview, actorLabel);
    }

    return executeConfirmed("plan_schedule", args, input.confirmToken, async tx => {
        const project = await tx.project.findUnique({
            where: { id: input.projectId },
            select: { id: true },
        });
        if (!project) throw new Error("Project not found");
        const created = [];
        for (const task of input.tasks) {
            const resolved = await resolvePlanTask(tx, task);
            created.push(await createScheduleTaskInTransaction(tx, input.projectId, resolved.create, actor));
        }
        return {
            projectId: input.projectId,
            created: created.map(task => ({
                id: task.id,
                name: task.name,
                startDate: task.startDate.toISOString().slice(0, 10),
                endDate: task.endDate.toISOString().slice(0, 10),
            })),
        };
    }, actorLabel);
}

async function validateTaskDates(input: { taskId: string; startDate?: string; endDate?: string }) {
    if (input.startDate === undefined && input.endDate === undefined) {
        throw new Error("Provide startDate and/or endDate");
    }
    const task = await prisma.scheduleTask.findUnique({
        where: { id: input.taskId },
        select: { id: true, name: true, type: true, startDate: true, endDate: true },
    });
    if (!task) throw new Error("Task not found");
    const startDate = input.startDate === undefined ? task.startDate : parseStartDateInput(input.startDate);
    const requestedEndDate = input.endDate === undefined ? task.endDate : parseStartDateInput(input.endDate);
    const endDate = task.type === "milestone" ? startDate : requestedEndDate;
    if (task.type !== "milestone" && endDate <= startDate) {
        throw new ScheduleTaskValidationError("Task end date must be after its start date (the end date is the day after the last day of work)");
    }
    return { task, startDate, endDate };
}

export async function updateTaskDates(input: {
    taskId: string;
    startDate?: string;
    endDate?: string;
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    const args = { taskId: input.taskId, startDate: input.startDate, endDate: input.endDate };
    if (!input.confirmToken) {
        const { task, startDate, endDate } = await validateTaskDates(args);
        // Preview shows the INCLUSIVE end (last day of work) — the user never
        // sees the stored exclusive value.
        const prevStartKey = task.startDate.toISOString().slice(0, 10);
        const prevEndKey = task.endDate.toISOString().slice(0, 10);
        const nextStartKey = startDate.toISOString().slice(0, 10);
        const nextEndKey = endDate.toISOString().slice(0, 10);
        return issueConfirmation(
            "update_task_dates",
            args,
            `Move "${task.name}" from ${prevStartKey}–${displayEndDate(prevStartKey, prevEndKey, task.type)} to ${nextStartKey}–${displayEndDate(nextStartKey, nextEndKey, task.type)}.`,
            actorLabel,
        );
    }
    return executeConfirmed("update_task_dates", args, input.confirmToken, async tx => {
        const task = await updateScheduleTaskInTransaction(tx, input.taskId, {
            startDate: input.startDate,
            endDate: input.endDate,
        }, actor);
        return {
            taskId: task.id,
            startDate: task.startDate.toISOString().slice(0, 10),
            endDate: task.endDate.toISOString().slice(0, 10),
        };
    }, actorLabel);
}

export async function setTaskStatus(input: {
    taskId: string;
    status: ScheduleTaskStatus;
    blockedReason?: string;
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    if (!(SCHEDULE_TASK_STATUSES as readonly string[]).includes(input.status)) {
        throw new Error(`Invalid schedule task status "${input.status}"`);
    }
    const blockedReason = input.blockedReason?.trim();
    if (input.status === "Blocked" && !blockedReason) throw new Error("Blocked tasks require a reason");
    const args = { taskId: input.taskId, status: input.status, blockedReason };
    if (!input.confirmToken) {
        const task = await prisma.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: { name: true, status: true },
        });
        if (!task) throw new Error("Task not found");
        return issueConfirmation(
            "set_task_status",
            args,
            `Change "${task.name}" from ${task.status} to ${input.status}${blockedReason ? ` — ${blockedReason}` : ""}.`,
            actorLabel,
        );
    }
    return executeConfirmed("set_task_status", args, input.confirmToken, async tx => {
        const task = await updateScheduleTaskInTransaction(tx, input.taskId, {
            status: input.status,
            blockedReason,
        }, actor);
        return { taskId: task.id, status: task.status, blockedReason: task.blockedReason };
    }, actorLabel);
}

export async function assignTaskCrew(input: {
    taskId: string;
    crewNames: string[];
    leadName?: string;
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    const crewNames = cleanCrewNames(input.crewNames);
    const args = { taskId: input.taskId, crewNames, leadName: input.leadName?.trim() || undefined };
    const resolve = async (tx: Prisma.TransactionClient) => {
        const task = await tx.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: { id: true, name: true },
        });
        if (!task) throw new Error("Task not found");
        const crew = await resolveCrewNames(tx, crewNames);
        const lead = input.leadName ? (await resolveCrewNames(tx, [input.leadName]))[0] : null;
        if (lead && !crew.some(member => member.id === lead.id)) {
            throw new Error(`Task lead "${input.leadName}" must also appear in crewNames`);
        }
        return { task, crew, lead };
    };

    if (!input.confirmToken) {
        const resolved = await prisma.$transaction(resolve);
        return issueConfirmation(
            "assign_task_crew",
            args,
            `Replace crew on "${resolved.task.name}" with ${resolved.crew.map(member => member.name).join(", ") || "nobody"}${resolved.lead ? `; lead: ${resolved.lead.name}` : ""}.`,
            actorLabel,
        );
    }
    return executeConfirmed("assign_task_crew", args, input.confirmToken, async tx => {
        const resolved = await resolve(tx);
        await setTaskCrewInTransaction(tx, {
            taskId: input.taskId,
            userIds: resolved.crew.map(member => member.id),
            actor,
        });
        const assignments = await setTaskLeadInTransaction(
            tx,
            input.taskId,
            resolved.lead?.id ?? null,
            actor,
        );
        return {
            taskId: input.taskId,
            assignments: assignments.map(assignment => ({
                id: assignment.id,
                userId: assignment.userId,
                name: assignment.user.name || assignment.user.email,
                role: assignment.role,
            })),
        };
    }, actorLabel);
}

export async function listCrewAvailability(input: { startDate: string; days: number }) {
    const startDate = parseStartDateInput(input.startDate);
    if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 14) {
        throw new Error("days must be a whole number from 1 through 14");
    }
    const endDate = addDays(startDate, input.days);
    const [crew, assignments] = await Promise.all([
        prisma.user.findMany({
            where: { status: "ACTIVATED", role: "FIELD_CREW" },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            select: { id: true, name: true },
        }),
        prisma.taskAssignment.findMany({
            where: {
                user: { status: "ACTIVATED", role: "FIELD_CREW" },
                task: {
                    projectId: { not: null },
                    OR: [
                        { type: "milestone", startDate: { gte: startDate, lt: endDate } },
                        { type: { not: "milestone" }, startDate: { lt: endDate }, endDate: { gt: startDate } },
                    ],
                },
            },
            select: {
                userId: true,
                task: { select: { id: true, name: true, type: true, startDate: true, endDate: true } },
            },
        }),
    ]);
    const days = Array.from({ length: input.days }, (_, index) => addDays(startDate, index));
    return {
        startDate: input.startDate,
        days: input.days,
        crew: crew.map(member => ({
            userId: member.id,
            name: member.name || "Unnamed crew member",
            days: days.map(date => {
                const next = addDays(date, 1);
                const bookedTasks = assignments
                    .filter(assignment => assignment.userId === member.id)
                    .filter(assignment => {
                        const taskEnd = assignment.task.type === "milestone"
                            ? addDays(assignment.task.startDate, 1)
                            : assignment.task.endDate;
                        return assignment.task.startDate < next && taskEnd > date;
                    })
                    .map(assignment => assignment.task.name)
                    .filter((name, index, all) => all.indexOf(name) === index);
                return {
                    date: date.toISOString().slice(0, 10),
                    status: bookedTasks.length > 0 ? "booked" : "free",
                    bookedTasks,
                };
            }),
        })),
    };
}

export async function setProjectStartDateWithConfirmation(input: {
    projectId: string;
    startDate: string | null;
    shiftJobTasks?: boolean;
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    if (input.startDate !== null) parseStartDateInput(input.startDate);
    const args = {
        projectId: input.projectId,
        startDate: input.startDate,
        shiftJobTasks: input.shiftJobTasks ?? true,
    };
    if (!input.confirmToken) {
        const project = await prisma.project.findUnique({
            where: { id: input.projectId },
            select: { name: true, startDate: true, _count: { select: { scheduleTasks: true } } },
        });
        if (!project) throw new Error("Project not found");
        return issueConfirmation(
            "set_project_start_date",
            args,
            `Set "${project.name}" start date from ${project.startDate?.toISOString().slice(0, 10) ?? "unset"} to ${input.startDate ?? "unset"}${args.shiftJobTasks ? `; up to ${project._count.scheduleTasks} schedule tasks may shift with the job` : "; tasks will stay in place"}.`,
            actorLabel,
        );
    }
    return executeConfirmed("set_project_start_date", args, input.confirmToken, async tx => {
        const result = await setProjectStartDateInTransaction(tx, {
            projectId: input.projectId,
            startDate: input.startDate === null ? null : parseStartDateInput(input.startDate),
            shiftJobTasks: args.shiftJobTasks,
            actor,
        });
        if (input.startDate !== null) {
            const taskCount = await tx.scheduleTask.count({ where: { projectId: input.projectId } });
            const qualifying = await tx.estimate.findFirst({
                ...canonicalContractEstimateQuery(input.projectId),
                select: { id: true, code: true },
            });
            if (taskCount === 0 && qualifying) {
                const generated = await generateScheduleFromEstimateInTransaction(tx, {
                    estimateId: qualifying.id,
                    mode: "merge",
                    requireEmptyProject: true,
                    actor,
                });
                result.notes.push(`Schedule auto-generated from estimate ${qualifying.code} (${generated.created.length} tasks).`);
            }
        }
        return result as unknown as Record<string, unknown>;
    }, actorLabel);
}

export async function generateProjectScheduleWithConfirmation(input: {
    estimateId: string;
    mode?: "merge" | "regenerate";
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    const args = { estimateId: input.estimateId, mode: input.mode ?? "merge" };
    if (!input.confirmToken) {
        const estimate = await prisma.estimate.findUnique({
            where: { id: input.estimateId },
            select: {
                code: true,
                status: true,
                project: { select: { name: true, startDate: true, _count: { select: { scheduleTasks: true } } } },
                _count: { select: { items: true, paymentSchedules: true } },
            },
        });
        if (!estimate) throw new Error("Estimate not found");
        if (!estimate.project) throw new Error("Estimate is not attached to a project");
        return issueConfirmation(
            "generate_project_schedule",
            args,
            `${args.mode === "regenerate" ? "Regenerate" : "Merge"} the schedule for "${estimate.project.name}" from estimate ${estimate.code}: ${estimate._count.items} estimate lines and ${estimate._count.paymentSchedules} payment milestones; ${estimate.project._count.scheduleTasks} tasks currently exist.`,
            actorLabel,
        );
    }
    return executeConfirmed("generate_project_schedule", args, input.confirmToken, async tx =>
        generateScheduleFromEstimateInTransaction(tx, {
            estimateId: input.estimateId,
            mode: args.mode,
            actor,
        }) as unknown as Promise<Record<string, unknown>>,
        actorLabel,
    );
}

export async function assignProjectCrewWithConfirmation(input: {
    projectId: string;
    userIds: string[];
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    const userIds = [...new Set(input.userIds)];
    const args = { projectId: input.projectId, userIds };
    if (!input.confirmToken) {
        const [project, users] = await Promise.all([
            prisma.project.findUnique({
                where: { id: input.projectId },
                select: { name: true },
            }),
            prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, name: true, email: true, status: true },
            }),
        ]);
        if (!project) throw new Error("Project not found");
        const found = new Set(users.map(user => user.id));
        const missing = userIds.filter(id => !found.has(id));
        if (missing.length > 0) throw new Error(`Unknown user id(s): ${missing.join(", ")}`);
        return issueConfirmation(
            "assign_project_crew",
            args,
            `Replace project crew on "${project.name}" with ${users.map(user => user.name || user.email).join(", ") || "nobody"}.`,
            actorLabel,
        );
    }
    return executeConfirmed("assign_project_crew", args, input.confirmToken, async tx =>
        setProjectCrewInTransaction(tx, { projectId: input.projectId, userIds, actor }) as unknown as Promise<Record<string, unknown>>,
        actorLabel,
    );
}

export async function applyChangeOrderToScheduleWithConfirmation(input: {
    changeOrderId: string;
    mode?: "merge" | "regenerate";
    confirmToken?: string;
}, actorLabel: McpActorLabel = DEFAULT_MCP_ACTOR_LABEL) {
    const actor = scheduleActor(actorLabel);
    const args = { changeOrderId: input.changeOrderId, mode: input.mode ?? "merge" };
    if (!input.confirmToken) {
        const changeOrder = await prisma.changeOrder.findUnique({
            where: { id: input.changeOrderId },
            select: {
                code: true,
                title: true,
                status: true,
                project: { select: { name: true } },
                _count: { select: { items: true, paymentSchedules: true } },
            },
        });
        if (!changeOrder) throw new Error("Change order not found");
        return issueConfirmation(
            "apply_change_order_to_schedule",
            args,
            `${args.mode === "regenerate" ? "Regenerate" : "Apply"} ${changeOrder.code} "${changeOrder.title}" on "${changeOrder.project.name}" to the schedule: ${changeOrder._count.items} items and ${changeOrder._count.paymentSchedules} milestones.`,
            actorLabel,
        );
    }
    return executeConfirmed("apply_change_order_to_schedule", args, input.confirmToken, async tx =>
        applyChangeOrderToScheduleInTransaction(tx, {
            changeOrderId: input.changeOrderId,
            mode: args.mode,
            actor,
        }) as unknown as Promise<Record<string, unknown>>,
        actorLabel,
    );
}
