import { isConflictedDay } from "./availability";
import { classifyTaskEvidence, findContradiction, type EvidenceTaskInput } from "@/lib/task-evidence";

export interface DispatchAssignmentInput {
    userId: string;
    name: string;
    status: string;
    userRole: string;
    assignmentRole: string;
}

export interface DispatchTaskInput {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    status: string;
    type: string;
    blockedReason: string | null;
    assignments: DispatchAssignmentInput[];
    // Evidence freshness. Optional so existing fixtures/callers keep compiling;
    // absent is treated the same as "no direct evidence".
    parentId?: string | null;
    lastDirectEvidenceAt?: string | null;
    lastIndirectEvidenceAt?: string | null;
}

export interface DispatchCrewInput {
    id: string;
    name: string;
    status: string;
    role: string;
}

export interface DispatchProjectInput {
    id: string;
    name: string;
    status: string;
    crew: DispatchCrewInput[];
    tasks: DispatchTaskInput[];
}

export interface DispatchConflictPairInput {
    projectA: { id: string; name: string };
    projectB: { id: string; name: string };
    overlapStart: string;
    overlapEnd: string;
    taskA?: { id: string; name: string; startDate: string; endDate: string };
    taskB?: { id: string; name: string; startDate: string; endDate: string };
}

export interface DispatchCrewConflictInput {
    userId: string;
    name: string;
    pairs: DispatchConflictPairInput[];
}

export interface DispatchTaskException {
    projectId: string;
    projectName: string;
    taskId: string;
    taskName: string;
    reason: string | null;
}

export interface DispatchConflictException {
    userId: string;
    userName: string;
    taskIds: string[];
}

export interface DispatchProjectException {
    projectId: string;
    projectName: string;
}

export interface DispatchExceptionGroups {
    unstaffed: DispatchTaskException[];
    noLead: DispatchTaskException[];
    conflicts: DispatchConflictException[];
    blocked: DispatchTaskException[];
    crewless: DispatchProjectException[];
    // Evidence gaps: the board says work is underway but nothing confirms it.
    unknownState: DispatchTaskException[];
    staleEvidence: DispatchTaskException[];
    // Evidence contradicts the board — reason carries the specific mismatch.
    needsReview: DispatchTaskException[];
}

export function isTaskActiveOnDay(task: Pick<DispatchTaskInput, "startDate" | "endDate" | "type">, dayKey: string): boolean {
    const startKey = task.startDate.slice(0, 10);
    if (task.type === "milestone" || task.type === "appointment") return startKey === dayKey;
    return startKey <= dayKey && dayKey < task.endDate.slice(0, 10);
}

function taskException(project: DispatchProjectInput, task: DispatchTaskInput): DispatchTaskException {
    return {
        projectId: project.id,
        projectName: project.name,
        taskId: task.id,
        taskName: task.name,
        reason: task.blockedReason,
    };
}

export function getUnstaffedToday(projects: readonly DispatchProjectInput[], dayKey: string): DispatchTaskException[] {
    return projects.flatMap(project => project.tasks
        .filter(task => isTaskActiveOnDay(task, dayKey))
        .filter(task => !task.assignments.some(assignment => assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW"))
        .map(task => taskException(project, task)));
}

export function getNoLeadToday(projects: readonly DispatchProjectInput[], dayKey: string): DispatchTaskException[] {
    return projects.flatMap(project => project.tasks
        .filter(task => isTaskActiveOnDay(task, dayKey))
        .filter(task => task.assignments.some(assignment => assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW"))
        .filter(task => !task.assignments.some(assignment => assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW" && assignment.assignmentRole === "lead"))
        .map(task => taskException(project, task)));
}

export function getTodayConflicts(conflicts: readonly DispatchCrewConflictInput[], dayKey: string): DispatchConflictException[] {
    return conflicts.flatMap(conflict => {
        if (!isConflictedDay([conflict], conflict.userId, dayKey, true)) return [];
        const taskIds = [...new Set(conflict.pairs.flatMap(pair => {
            const pairMatches = isConflictedDay([{ ...conflict, pairs: [pair] }], conflict.userId, dayKey, true);
            return pairMatches ? [pair.taskA!.id, pair.taskB!.id] : [];
        }))];
        return [{ userId: conflict.userId, userName: conflict.name, taskIds }];
    });
}

export function getBlockedTasks(projects: readonly DispatchProjectInput[]): DispatchTaskException[] {
    return projects.flatMap(project => project.status !== "In Progress"
        ? []
        : project.tasks
            .filter(task => task.status === "Blocked")
            .map(task => taskException(project, task)));
}

export function getCrewlessJobs(projects: readonly DispatchProjectInput[], dayKey: string): DispatchProjectException[] {
    return projects
        .filter(project => project.status === "In Progress")
        .filter(project => project.crew.some(member => member.status === "ACTIVATED" && member.role === "FIELD_CREW"))
        .filter(project => !project.tasks.some(task => isTaskActiveOnDay(task, dayKey)))
        .map(project => ({ projectId: project.id, projectName: project.name }));
}

function evidenceTask(task: DispatchTaskInput): EvidenceTaskInput {
    return {
        id: task.id,
        startDate: task.startDate,
        endDate: task.endDate,
        status: task.status,
        type: task.type,
        parentId: task.parentId ?? null,
        lastDirectEvidenceAt: task.lastDirectEvidenceAt ?? null,
        lastIndirectEvidenceAt: task.lastIndirectEvidenceAt ?? null,
    };
}

function projectParentIds(project: DispatchProjectInput): Set<string> {
    return new Set(project.tasks.map(task => task.parentId).filter((id): id is string => !!id));
}

/**
 * Evidence-based exceptions, in one pass so the three groups stay mutually
 * exclusive — a task with no evidence ever is `unknown`, never also `stale`.
 */
export function getEvidenceExceptions(
    projects: readonly DispatchProjectInput[],
    dayKey: string,
    staleAfterDays = 2,
): Pick<DispatchExceptionGroups, "unknownState" | "staleEvidence" | "needsReview"> {
    const unknownState: DispatchTaskException[] = [];
    const staleEvidence: DispatchTaskException[] = [];
    const needsReview: DispatchTaskException[] = [];

    for (const project of projects) {
        if (project.status !== "In Progress") continue;
        const parentIds = projectParentIds(project);
        for (const task of project.tasks) {
            const input = evidenceTask(task);
            switch (classifyTaskEvidence(input, parentIds, dayKey, staleAfterDays)) {
                case "unknown":
                    unknownState.push(taskException(project, task));
                    break;
                case "stale":
                    staleEvidence.push(taskException(project, task));
                    break;
                case "needsReview":
                    needsReview.push({ ...taskException(project, task), reason: findContradiction(input) });
                    break;
                default:
                    break;
            }
        }
    }
    return { unknownState, staleEvidence, needsReview };
}

export function getDispatchExceptions(
    projects: readonly DispatchProjectInput[],
    conflicts: readonly DispatchCrewConflictInput[],
    dayKey: string,
    staleAfterDays = 2,
): DispatchExceptionGroups {
    return {
        unstaffed: getUnstaffedToday(projects, dayKey),
        noLead: getNoLeadToday(projects, dayKey),
        conflicts: getTodayConflicts(conflicts, dayKey),
        blocked: getBlockedTasks(projects),
        crewless: getCrewlessJobs(projects, dayKey),
        ...getEvidenceExceptions(projects, dayKey, staleAfterDays),
    };
}
