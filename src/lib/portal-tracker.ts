import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
    CLIENT_STAGES,
    CLIENT_STAGE_LABELS,
    clientStageIndex,
    type ClientStageDefinition,
} from "@/lib/client-stages";
import {
    assertPortalProjectAccess,
    assertPortalProjectAccessCore,
    portalVisibilityAllows,
    type PortalProjectAccessInput,
} from "@/lib/portal-project-access";

export { assertPortalProjectAccessCore, portalVisibilityAllows };
export type { PortalProjectAccessInput };

export type ClientStageState = "complete" | "current" | "upcoming";

export { CLIENT_STAGES, CLIENT_STAGE_LABELS, clientStageIndex };
export type { ClientStageDefinition };

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
    clientStage: string | null;
    scheduledTime: string | null;
    confirmationStatus: string | null;
    assignments: PortalTrackerAssignment[];
    subAssignments: PortalTrackerSubAssignment[];
    dependencies?: PortalTrackerDependency[];
};

export type ProjectTrackerStageTask = {
    name: string;
    done: boolean;
    active: boolean;
};

export type ProjectTrackerStage = {
    label: string;
    state: ClientStageState;
    pct: number;
    taskCount: number;
    doneCount: number;
    /** Tasks underneath this stage, in schedule order, for the expandable rail. */
    tasks: ProjectTrackerStageTask[];
    /** Name of the task actually underway, when this is the current stage. */
    activeTaskName: string | null;
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

function isTaskDerivedStage(stage: ClientStageDefinition): boolean {
    return stage.taskDerived !== false;
}

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

/**
 * Keyword bucket for a task, or null when nothing matches.
 *
 * Wins on the stage word that appears LAST IN THE TEXT, not the highest-numbered
 * stage. A task named "Site prep and Demo start" spans two stages and is
 * announcing the transition, so it belongs to Demo; "Final electrical fixtures &
 * cleanup" belongs to Punch list, not back in Rough-ins on the word "electric".
 *
 * Ranking by stage number instead read "Review floor plan" as Finishes (on
 * "floor") rather than Planning (on "plan") — and because earlier empty stages
 * then read as passed, a job whose only task was reviewing a floor plan told the
 * client Demo, Framing, Rough-ins and Drywall were all done. Text position gets
 * both those names right; stage number only got one of them.
 */
function bestStageInText(text: string): number | null {
    const haystack = text.toLowerCase();
    const hits: { position: number; length: number; stageIndex: number }[] = [];
    CLIENT_STAGES.forEach((stage, stageIndex) => {
        if (!isTaskDerivedStage(stage)) return;
        stage.matchers.forEach(matcher => {
            const position = haystack.lastIndexOf(matcher);
            if (position >= 0) hits.push({ position, length: matcher.length, stageIndex });
        });
    });
    if (hits.length === 0) return null;
    // Later in the text wins; on a tie the more specific (longer) word does.
    return hits.reduce((best, hit) =>
        hit.position > best.position
        || (hit.position === best.position && hit.length > best.length)
            ? hit
            : best,
    ).stageIndex;
}

function keywordStageIndex(task: PortalTrackerTask): number | null {
    // Rank inside ONE field at a time. Positions from different fields are not
    // comparable, and gluing name+costCode into one haystack handed every cost-code
    // word positional priority over the task's own name: "Final cleanup" under cost
    // code "Electrical rough-in" read as Rough-ins instead of Punch list. The name
    // is what the client actually sees, so it decides whenever it says anything.
    return bestStageInText(task.name) ?? bestStageInText(task.costCodeName ?? "");
}

/**
 * Drops keyword anchors that contradict schedule order.
 *
 * Keyword matching has no idea when work actually happens, so a mid-project
 * "inspection" lands in Punch list and a "Concrete Slab Pour & Finish" lands in
 * Finishes — which makes the client rail run backwards. Keeping only the
 * longest non-decreasing run of anchors throws out those outliers; the tasks
 * they came from fall back to inheriting from their neighbours.
 *
 * Explicit clientStage values are never dropped — a human said so.
 */
type StageAnchor = { taskIndex: number; stageIndex: number };

function monotonicAnchors(
    keyword: readonly StageAnchor[],
    pinned: readonly StageAnchor[],
): StageAnchor[] {
    // A keyword guess may not contradict what a human pinned around it.
    const eligible = keyword.filter(anchor => {
        const floor = pinned
            .filter(p => p.taskIndex < anchor.taskIndex)
            .reduce((max, p) => Math.max(max, p.stageIndex), Number.NEGATIVE_INFINITY);
        const ceiling = pinned
            .filter(p => p.taskIndex > anchor.taskIndex)
            .reduce((min, p) => Math.min(min, p.stageIndex), Number.POSITIVE_INFINITY);
        return anchor.stageIndex >= floor && anchor.stageIndex <= ceiling;
    });
    if (eligible.length === 0) return [];

    // best[i] = length of the longest non-decreasing run ending at i.
    const best = eligible.map(() => 1);
    const previous = eligible.map(() => -1);
    let endOfLongest = 0;

    eligible.forEach((anchor, i) => {
        for (let j = 0; j < i; j++) {
            if (eligible[j].stageIndex <= anchor.stageIndex && best[j] + 1 > best[i]) {
                best[i] = best[j] + 1;
                previous[i] = j;
            }
        }
        if (best[i] > best[endOfLongest]) endOfLongest = i;
    });

    const kept: StageAnchor[] = [];
    for (let i = endOfLongest; i >= 0; i = previous[i]) {
        kept.unshift({ taskIndex: eligible[i].taskIndex, stageIndex: eligible[i].stageIndex });
        if (previous[i] === -1) break;
    }
    return kept;
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
 * Assigns every task to the client stages.
 *
 * Precedence: an explicit clientStage wins outright, then a keyword match that
 * survived the schedule-order check, then interpolation. An unmatched task
 * inherits the stage of the closest surviving anchor (earlier anchor wins a
 * tie). When a project has no anchors at all, chronological tasks are spread
 * proportionally across the stages so the tracker still means something for
 * custom task naming.
 */
function assignStageIndexes(tasks: readonly PortalTrackerTask[]): Map<string, number> {
    const sorted = chronologicalTasks(tasks);
    const taskStageIndexes = CLIENT_STAGES
        .map((stage, index) => isTaskDerivedStage(stage) ? index : null)
        .filter((index): index is number => index !== null);
    const pinnedStage = sorted.map(task => {
        const stageIndex = clientStageIndex(task.clientStage);
        return stageIndex !== null && isTaskDerivedStage(CLIENT_STAGES[stageIndex]) ? stageIndex : null;
    });
    const keywordStage = sorted.map((task, i) =>
        pinnedStage[i] === null ? keywordStageIndex(task) : null,
    );

    const toAnchors = (stages: readonly (number | null)[]): StageAnchor[] => stages
        .map((stageIndex, taskIndex) => stageIndex === null ? null : { taskIndex, stageIndex })
        .filter((anchor): anchor is StageAnchor => anchor !== null);

    const pinnedAnchors = toAnchors(pinnedStage);
    const keptKeyword = monotonicAnchors(toAnchors(keywordStage), pinnedAnchors);
    // A keyword guess the ordering pass threw out stops being trusted for its
    // own task too, not just for its neighbours — otherwise the outlier stays
    // parked in the wrong stage and the rail still runs backwards.
    const keptByTask = new Map(keptKeyword.map(a => [a.taskIndex, a.stageIndex]));
    const anchors = [...pinnedAnchors, ...keptKeyword].sort((a, b) => a.taskIndex - b.taskIndex);

    const direct = sorted.map((_, i) =>
        pinnedStage[i] ?? keptByTask.get(i) ?? null,
    );
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
            ? taskStageIndexes[0]
            : taskStageIndexes[Math.round((taskIndex * (taskStageIndexes.length - 1)) / (sorted.length - 1))];
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

    const allProjectTasksComplete = tasks.length > 0
        && tasks.every(isComplete);
    const requestedOverrideIndex = stageOverride
        ? CLIENT_STAGES.findIndex(stage => stage.label === stageOverride)
        : -1;
    const overrideIndex = requestedOverrideIndex;

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
        const stageTasks = chronologicalTasks(tasksByStage[index]);
        const taskPct = stageTasks.length > 0
            ? Math.round(stageTasks.reduce((sum, task) => sum + normalizedProgress(task), 0) / stageTasks.length)
            : 0;

        // Second level of the rail: the real schedule under each stage.
        // Appointments are crew logistics, not client-facing milestones.
        const visibleTasks = stageTasks.filter(task => task.type !== "appointment");
        const activeTask = visibleTasks.find(task => isStarted(task))
            ?? visibleTasks.find(task => !isComplete(task));
        const detail = {
            taskCount: visibleTasks.length,
            doneCount: visibleTasks.filter(isComplete).length,
            tasks: visibleTasks.map((task): ProjectTrackerStageTask => ({
                name: clientTaskName(task.name),
                done: isComplete(task),
                active: isStarted(task),
            })),
        };
        const activeTaskName = activeTask ? clientTaskName(activeTask.name) : null;

        if (overrideIndex >= 0) {
            // A staff override pins the route position regardless of task math:
            // earlier stages read done, the pinned stage is current (capped at
            // 99 — 100 would read as complete), later stages keep honest pcts.
            if (index < overrideIndex) {
                // Staff said we're past this stage, so it reads Done and stops
                // there. Sending the task list would let the client open a
                // green checkmark and find unticked work under it — the tasks
                // are usually finished in the field and just never ticked here.
                return {
                    label: stage.label,
                    state: "complete",
                    pct: 100,
                    taskCount: 0,
                    doneCount: 0,
                    tasks: [],
                    activeTaskName: null,
                };
            }
            if (index === overrideIndex) {
                return {
                    label: stage.label,
                    state: "current",
                    pct: Math.min(taskPct, 99),
                    ...detail,
                    activeTaskName,
                };
            }
            return { label: stage.label, state: "upcoming", pct: taskPct, ...detail, activeTaskName: null };
        }

        // The rail is ONE position, not eight independent ones, so state comes
        // purely from where currentIndex sits — the same shape as the pinned
        // branch above. Deciding each stage's Done on its own tasks let a green
        // Framing sit above an unfinished Demo, and let an untouched Demo read
        // "upcoming" behind three finished stages: the backwards rail this whole
        // change exists to kill.
        if (allProjectTasksComplete) {
            // Completion is still a rail position. Leaving every stage "complete"
            // gives consumers no current stage to render and makes a fully finished
            // schedule appear to have no terminal state at all.
            if (index === CLIENT_STAGES.length - 1) {
                return {
                    label: stage.label,
                    state: "current",
                    pct: 99,
                    ...detail,
                    activeTaskName: null,
                };
            }
            return { label: stage.label, state: "complete", pct: 100, ...detail, activeTaskName: null };
        }
        if (currentIndex < 0) {
            return { label: stage.label, state: "complete", pct: 100, ...detail, activeTaskName: null };
        }
        if (index < currentIndex) {
            // Behind the current position. Reads Done with no task list, for the
            // same reason the pinned branch hides it: letting the client open a
            // green checkmark and find unticked work under it is worse than
            // saying nothing. In the field this work is done, it just never got
            // ticked here.
            return {
                label: stage.label,
                state: "complete",
                pct: 100,
                taskCount: 0,
                doneCount: 0,
                tasks: [],
                activeTaskName: null,
            };
        }
        if (index === currentIndex) {
            return {
                label: stage.label,
                state: "current",
                pct: Math.min(taskPct, 99),
                ...detail,
                activeTaskName,
            };
        }
        // Ahead of the current position. Work finished early keeps its real pct
        // so the roundel still counts it; it just doesn't get the checkmark yet.
        return { label: stage.label, state: "upcoming", pct: taskPct, ...detail, activeTaskName: null };
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
            clientStage: true,
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
        clientStage: task.clientStage,
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

    const tracker = buildProjectTracker(
        tasks,
        project.portalStageOverride,
    );
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
