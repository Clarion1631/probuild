import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
    assertPortalProjectAccess,
    assertPortalProjectAccessCore,
    portalVisibilityAllows,
    type PortalProjectAccessInput,
} from "@/lib/portal-project-access";

export { assertPortalProjectAccessCore, portalVisibilityAllows };
export type { PortalProjectAccessInput };

export type ClientStageState = "complete" | "current" | "upcoming";

export type ClientStageDefinition = {
    label: string;
    matchers: readonly string[];
};

export const CLIENT_STAGES = [
    {
        label: "Planning & Permits",
        matchers: [
            "plan", "permit", "design", "preconstruction", "pre-construction",
            "engineering", "architect", "site prep", "mobilization",
        ],
    },
    {
        label: "Demo",
        matchers: ["demo", "demolition", "tear out", "tear-out", "removal", "abatement"],
    },
    {
        label: "Framing",
        matchers: ["frame", "framing", "structural", "sheathing", "carpentry"],
    },
    {
        label: "Rough-ins",
        matchers: [
            "rough", "plumb", "electric", "hvac", "mechanical", "duct",
            "wiring", "low voltage", "low-voltage",
        ],
    },
    {
        label: "Drywall",
        matchers: ["drywall", "sheetrock", "gypsum", "insulation", "taping", "texture", "mud"],
    },
    {
        label: "Finishes",
        matchers: [
            "finish", "paint", "tile", "cabinet", "floor", "counter", "trim",
            "fixture", "appliance", "millwork", "backsplash",
        ],
    },
    {
        label: "Punch list",
        matchers: [
            "punch", "inspection", "touch up", "touch-up", "cleanup", "clean up",
            "final walk", "correction",
        ],
    },
    {
        label: "Complete",
        matchers: ["complete", "completion", "closeout", "close out", "handover", "handoff"],
    },
] as const satisfies readonly ClientStageDefinition[];

export type PortalTrackerAssignment = {
    id: string;
    userId: string;
    firstName: string;
};

export type PortalTrackerSubAssignment = {
    id: string;
    companyName: string;
};

export type PortalTrackerDependency = {
    id: string;
    predecessorId: string;
    dependentId: string;
};

export type PortalTrackerTask = {
    id: string;
    name: string;
    startDate: Date | string;
    endDate: Date | string;
    color: string;
    progress: number;
    status: string;
    type: string;
    order: number;
    costCodeName: string | null;
    scheduledTime: string | null;
    confirmationStatus: string | null;
    assignments: PortalTrackerAssignment[];
    subAssignments: PortalTrackerSubAssignment[];
    dependencies?: PortalTrackerDependency[];
};

export type ProjectTrackerStage = {
    label: string;
    state: ClientStageState;
    pct: number;
};

export type ProjectTracker = {
    stages: ProjectTrackerStage[];
    overallPct: number;
};

export type PortalAppointment = {
    name: string;
    date: string;
    scheduledTime: string | null;
    confirmationStatus: "confirmed" | "pending confirmation";
};

export type PortalDayVisitors = {
    date: string;
    crew: string[];
    subcontractors: string[];
    appointments: PortalAppointment[];
};

export type PortalNextTask = {
    name: string;
    startDate: string;
};

export type PortalProjectTrackerPayload = ProjectTracker & {
    projectColor: string;
    whatsNext: PortalNextTask[];
    whoIsComing: PortalDayVisitors[];
};

export type PortalUpdatePhoto = {
    url: string;
    caption: string | null;
};

export type PortalUpdate = {
    id: string;
    date: string;
    workPerformed: string;
    photos: PortalUpdatePhoto[];
};

export type PortalShareActor = {
    userId: string;
    role: string;
    name: string;
};

export type PortalShareInput = {
    shared: boolean;
    photoIds: string[];
};

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

function dateKey(value: Date | string): string {
    return toDate(value).toISOString().slice(0, 10);
}

function isComplete(task: PortalTrackerTask): boolean {
    return task.status.trim().toLowerCase() === "complete" || task.progress >= 100;
}

function normalizedProgress(task: PortalTrackerTask): number {
    if (isComplete(task)) return 100;
    return Math.max(0, Math.min(100, Math.round(task.progress || 0)));
}

function isStarted(task: PortalTrackerTask): boolean {
    const status = task.status.trim().toLowerCase();
    return !isComplete(task)
        && (
            normalizedProgress(task) > 0
            || status === "in progress"
            || status === "active"
            || status === "blocked"
        );
}

function stageMatchIndex(task: PortalTrackerTask): number | null {
    const haystack = `${task.name} ${task.costCodeName ?? ""}`.toLowerCase();
    const index = CLIENT_STAGES.findIndex(stage =>
        stage.matchers.some(matcher => haystack.includes(matcher)),
    );
    return index >= 0 ? index : null;
}

function chronologicalTasks(tasks: readonly PortalTrackerTask[]): PortalTrackerTask[] {
    return [...tasks].sort((a, b) => {
        const dateDelta = toDate(a.startDate).getTime() - toDate(b.startDate).getTime();
        if (dateDelta !== 0) return dateDelta;
        const orderDelta = a.order - b.order;
        if (orderDelta !== 0) return orderDelta;
        return a.id.localeCompare(b.id);
    });
}

/**
 * Assigns every task to the eight client stages.
 *
 * Fallback: an unmatched task inherits the stage of the closest keyword-
 * matched task in chronological order (earlier anchor wins a tie). When the
 * project has no keyword matches at all, chronological tasks are distributed
 * proportionally across the ordered stages so the tracker remains useful for
 * custom task naming.
 */
function assignStageIndexes(tasks: readonly PortalTrackerTask[]): Map<string, number> {
    const sorted = chronologicalTasks(tasks);
    const direct = sorted.map(stageMatchIndex);
    const anchors = direct
        .map((stageIndex, taskIndex) => stageIndex === null ? null : { taskIndex, stageIndex })
        .filter((anchor): anchor is { taskIndex: number; stageIndex: number } => anchor !== null);
    const assigned = new Map<string, number>();

    sorted.forEach((task, taskIndex) => {
        const directStage = direct[taskIndex];
        if (directStage !== null) {
            assigned.set(task.id, directStage);
            return;
        }

        if (anchors.length > 0) {
            const nearest = anchors.reduce((best, candidate) => {
                const bestDistance = Math.abs(best.taskIndex - taskIndex);
                const candidateDistance = Math.abs(candidate.taskIndex - taskIndex);
                return candidateDistance < bestDistance ? candidate : best;
            });
            assigned.set(task.id, nearest.stageIndex);
            return;
        }

        const proportionalIndex = sorted.length <= 1
            ? 0
            : Math.round((taskIndex * (CLIENT_STAGES.length - 1)) / (sorted.length - 1));
        assigned.set(task.id, proportionalIndex);
    });

    return assigned;
}

export function buildProjectTracker(
    tasks: readonly PortalTrackerTask[],
    stageOverride?: string | null,
): ProjectTracker {
    const assigned = assignStageIndexes(tasks);
    const tasksByStage = CLIENT_STAGES.map((_, stageIndex) =>
        tasks.filter(task => assigned.get(task.id) === stageIndex),
    );

    const allProjectTasksComplete = tasks.length > 0 && tasks.every(isComplete);
    const overrideIndex = stageOverride
        ? CLIENT_STAGES.findIndex(stage => stage.label === stageOverride)
        : -1;

    let currentIndex = tasksByStage.findIndex(stageTasks =>
        stageTasks.length > 0
        && stageTasks.some(task => !isComplete(task))
        && stageTasks.some(isStarted),
    );
    if (currentIndex < 0) {
        currentIndex = tasksByStage.findIndex(stageTasks =>
            stageTasks.length > 0 && stageTasks.some(task => !isComplete(task)),
        );
    }
    if (currentIndex < 0 && tasks.length === 0) currentIndex = 0;

    const stages = CLIENT_STAGES.map((stage, index): ProjectTrackerStage => {
        const stageTasks = tasksByStage[index];
        const taskPct = stageTasks.length > 0
            ? Math.round(stageTasks.reduce((sum, task) => sum + normalizedProgress(task), 0) / stageTasks.length)
            : 0;

        if (overrideIndex >= 0) {
            // A staff override pins the route position regardless of task math:
            // earlier stages read done, the pinned stage is current (capped at
            // 99 — 100 would read as complete), later stages keep honest pcts.
            if (index < overrideIndex) return { label: stage.label, state: "complete", pct: 100 };
            if (index === overrideIndex) {
                return { label: stage.label, state: "current", pct: Math.min(taskPct, 99) };
            }
            return { label: stage.label, state: "upcoming", pct: taskPct };
        }

        const stageComplete = stageTasks.length > 0 && stageTasks.every(isComplete);
        const emptyButPassed = currentIndex > index && stageTasks.length === 0;
        const complete = allProjectTasksComplete || stageComplete || emptyButPassed;

        return {
            label: stage.label,
            state: complete ? "complete" : index === currentIndex ? "current" : "upcoming",
            pct: complete ? 100 : taskPct,
        };
    });

    // Overall = mean of the per-stage percentages so the roundel can never
    // contradict the stage rail (empty-but-passed stages count as done).
    // While a stage is still current the total is held under 100, or pinning
    // the last stage would round up to a "100% complete" badge above a rail
    // that still shows work in progress.
    const rawOverallPct = tasks.length === 0 && overrideIndex < 0
        ? 0
        : Math.round(stages.reduce((sum, stage) => sum + stage.pct, 0) / stages.length);
    const hasCurrentStage = stages.some(stage => stage.state === "current");
    const overallPct = hasCurrentStage ? Math.min(rawOverallPct, 99) : rawOverallPct;

    return { stages, overallPct };
}

function startOfUtcDay(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
    const result = new Date(value.getTime());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

function addDeduped(map: Map<string, string>, value: string): void {
    const clean = value.trim();
    if (!clean) return;
    const key = clean.toLocaleLowerCase();
    if (!map.has(key)) map.set(key, clean);
}

export function buildPortalWhoIsComing(
    tasks: readonly PortalTrackerTask[],
    now = new Date(),
): PortalDayVisitors[] {
    const start = startOfUtcDay(now);

    return Array.from({ length: 7 }, (_, offset): PortalDayVisitors => {
        const day = addUtcDays(start, offset);
        const dayTime = day.getTime();
        const dayIso = day.toISOString().slice(0, 10);
        const crew = new Map<string, string>();
        const subcontractors = new Map<string, string>();
        const appointments: PortalAppointment[] = [];

        for (const task of tasks) {
            if (task.type === "appointment") {
                if (dateKey(task.startDate) === dayIso) {
                    appointments.push({
                        name: task.name,
                        date: dayIso,
                        scheduledTime: task.scheduledTime,
                        confirmationStatus: task.confirmationStatus === "confirmed"
                            ? "confirmed"
                            : "pending confirmation",
                    });
                }
                continue;
            }

            const taskStart = startOfUtcDay(toDate(task.startDate)).getTime();
            const taskEnd = startOfUtcDay(toDate(task.endDate)).getTime();
            if (dayTime < taskStart || dayTime > taskEnd || isComplete(task)) continue;

            task.assignments.forEach(assignment => addDeduped(crew, assignment.firstName));
            task.subAssignments.forEach(assignment =>
                addDeduped(subcontractors, assignment.companyName),
            );
        }

        return {
            date: dayIso,
            crew: [...crew.values()].sort((a, b) => a.localeCompare(b)),
            subcontractors: [...subcontractors.values()].sort((a, b) => a.localeCompare(b)),
            appointments: appointments.sort((a, b) =>
                (a.scheduledTime ?? "99:99").localeCompare(b.scheduledTime ?? "99:99")
                || a.name.localeCompare(b.name),
            ),
        };
    });
}

export function computeDailyLogSharedContentHash(
    workPerformed: string,
    photoIds: readonly string[],
): string {
    const canonical = JSON.stringify({
        workPerformed,
        photoIds: [...new Set(photoIds)].sort(),
    });
    return createHash("sha256").update(canonical).digest("hex");
}

function sanitizeProjectColor(color: string | null): string {
    const candidate = color?.trim() ?? "";
    return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : "#4c9a2a";
}

function clientTaskName(name: string): string {
    const clean = name
        .replace(/^\s*\d{1,3}[\s_.:/-]+/, "")
        .replace(/^\s*[A-Z]{1,4}-\d{1,4}[\s:./-]+/i, "")
        .trim();
    return clean || name.trim();
}

export async function getPortalScheduleTasksCore(projectId: string): Promise<PortalTrackerTask[]> {
    const tasks = await prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: [{ order: "asc" }, { startDate: "asc" }],
        select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            color: true,
            progress: true,
            status: true,
            type: true,
            order: true,
            scheduledTime: true,
            confirmationStatus: true,
            dependencies: {
                select: {
                    id: true,
                    predecessorId: true,
                    dependentId: true,
                },
            },
            estimateItem: {
                select: {
                    costCode: { select: { name: true } },
                },
            },
            assignments: {
                select: {
                    id: true,
                    userId: true,
                    user: { select: { name: true } },
                },
            },
            subAssignments: {
                select: {
                    id: true,
                    subcontractor: { select: { companyName: true } },
                },
            },
        },
    });

    return tasks.map(task => ({
        id: task.id,
        name: task.name,
        startDate: task.startDate,
        endDate: task.endDate,
        color: task.color,
        progress: task.progress,
        status: task.status,
        type: task.type,
        order: task.order,
        costCodeName: task.estimateItem?.costCode?.name ?? null,
        scheduledTime: task.scheduledTime,
        confirmationStatus: task.confirmationStatus,
        dependencies: task.dependencies,
        assignments: task.assignments.map(assignment => ({
            id: assignment.id,
            userId: assignment.userId,
            firstName: assignment.user.name?.trim().split(/\s+/)[0] || "Crew",
        })),
        subAssignments: task.subAssignments.map(assignment => ({
            id: assignment.id,
            companyName: assignment.subcontractor.companyName,
        })),
    }));
}

export async function getPortalProjectTrackerCore(
    projectId: string,
    now = new Date(),
): Promise<PortalProjectTrackerPayload> {
    const [project, tasks] = await Promise.all([
        prisma.project.findUnique({
            where: { id: projectId },
            select: { color: true, portalStageOverride: true },
        }),
        getPortalScheduleTasksCore(projectId),
    ]);
    if (!project) throw new Error("Project not found");

    const tracker = buildProjectTracker(tasks, project.portalStageOverride);
    const whatsNext = chronologicalTasks(tasks)
        .filter(task =>
            task.type !== "appointment"
            && !isComplete(task)
            && !isStarted(task),
        )
        .slice(0, 2)
        .map(task => ({
            name: clientTaskName(task.name),
            startDate: dateKey(task.startDate),
        }));

    return {
        projectColor: sanitizeProjectColor(project.color),
        ...tracker,
        whatsNext,
        whoIsComing: buildPortalWhoIsComing(tasks, now),
    };
}

export async function getPortalProjectTracker(
    projectId: string,
): Promise<PortalProjectTrackerPayload> {
    await assertPortalProjectAccess(projectId, "showSchedule");
    return getPortalProjectTrackerCore(projectId);
}

export async function getPortalUpdatesFeedCore(projectId: string): Promise<PortalUpdate[]> {
    const logs = await prisma.dailyLog.findMany({
        where: { projectId, sharedToPortal: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        select: {
            id: true,
            date: true,
            workPerformed: true,
            sharedContentHash: true,
            photos: {
                where: { sharedToPortal: true },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    url: true,
                    caption: true,
                },
            },
        },
    });

    return logs.flatMap(log => {
        const currentHash = computeDailyLogSharedContentHash(
            log.workPerformed,
            log.photos.map(photo => photo.id),
        );
        if (!log.sharedContentHash || log.sharedContentHash !== currentHash) return [];

        return [{
            id: log.id,
            date: log.date.toISOString(),
            workPerformed: log.workPerformed,
            photos: log.photos.map(photo => ({
                url: photo.url,
                caption: photo.caption,
            })),
        }];
    });
}

export async function getPortalUpdatesFeed(projectId: string): Promise<PortalUpdate[]> {
    await assertPortalProjectAccess(projectId, "showDailyLogs");
    return getPortalUpdatesFeedCore(projectId);
}

export async function setDailyLogPortalShareCore(
    logId: string,
    input: PortalShareInput,
    actor: PortalShareActor,
): Promise<{ shared: boolean; portalShareValid: boolean; sharedPhotoIds: string[] }> {
    if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Forbidden");

    const log = await prisma.dailyLog.findUnique({
        where: { id: logId },
        select: {
            id: true,
            projectId: true,
            workPerformed: true,
            photos: { select: { id: true } },
        },
    });
    if (!log) throw new Error("Daily log not found");

    const validPhotoIds = new Set(log.photos.map(photo => photo.id));
    const selectedPhotoIds = input.shared
        ? [...new Set(input.photoIds)].filter(photoId => validPhotoIds.has(photoId)).sort()
        : [];
    if (input.shared && selectedPhotoIds.length !== new Set(input.photoIds).size) {
        throw new Error("One or more photos do not belong to this daily log");
    }

    const sharedContentHash = input.shared
        ? computeDailyLogSharedContentHash(log.workPerformed, selectedPhotoIds)
        : null;

    await prisma.$transaction(async tx => {
        await tx.dailyLogPhoto.updateMany({
            where: { dailyLogId: log.id },
            data: { sharedToPortal: false },
        });
        if (selectedPhotoIds.length > 0) {
            await tx.dailyLogPhoto.updateMany({
                where: { dailyLogId: log.id, id: { in: selectedPhotoIds } },
                data: { sharedToPortal: true },
            });
        }
        await tx.dailyLog.update({
            where: { id: log.id },
            data: {
                sharedToPortal: input.shared,
                sharedContentHash,
            },
        });
        await tx.activityLog.create({
            data: {
                projectId: log.projectId,
                actorType: "TEAM",
                actorName: actor.name,
                action: input.shared
                    ? "share_daily_log_to_portal"
                    : "unshare_daily_log_from_portal",
                entityType: "daily_log",
                entityId: log.id,
                entityName: `Daily log ${log.id}`,
                metadata: JSON.stringify({
                    shared: input.shared,
                    photoCount: selectedPhotoIds.length,
                }),
            },
        });
    });

    return {
        shared: input.shared,
        portalShareValid: input.shared,
        sharedPhotoIds: selectedPhotoIds,
    };
}
