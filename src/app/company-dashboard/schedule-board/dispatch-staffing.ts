import { isTaskActiveOnDay } from "./dispatch-exceptions";

export interface StaffingCrewInput {
    id: string;
    name: string;
    status: string;
    role: string;
}

export interface StaffingAssignmentInput {
    userId: string;
    status: string;
    userRole: string;
    /** Optional — used to name a drafted addition who isn't on project.crew. */
    name?: string;
}

export interface StaffingTaskInput {
    id: string;
    startDate: string;
    endDate: string;
    type: string;
    assignments: StaffingAssignmentInput[];
}

export interface StaffingProjectInput {
    crew: StaffingCrewInput[];
}

export interface StaffingCrewDraft {
    addUserIds: string[];
    removeUserIds: string[];
}

export type StaffingMemberState = "assigned" | "drafted" | "idle";

export interface StaffingMember {
    id: string;
    name: string;
    state: StaffingMemberState;
}

export interface CardStaffing {
    members: StaffingMember[];
    staffedTaskCount: number;
    taskCount: number;
}

/**
 * Per-card staffing derivation for the dispatch job card meter. Pure — every
 * input already lives in props (project.crew, today's tasks, crewDrafts).
 * A member reads "assigned" when they hold a solid (ACTIVATED, FIELD_CREW)
 * assignment on any of today's tasks, "drafted" when they don't but a
 * crewDraft adds them to one of today's tasks, otherwise "idle".
 */
export function getCardStaffing(
    project: StaffingProjectInput,
    tasks: readonly StaffingTaskInput[],
    crewDrafts: Readonly<Record<string, StaffingCrewDraft>>,
    dayKey: string,
): CardStaffing {
    const todayTasks = tasks.filter(task => isTaskActiveOnDay(task, dayKey));

    // removeUserIds is applied BEFORE addUserIds when deriving who is
    // effectively assigned: a member whose only assignment is drafted-removed
    // reads as "idle" (not still "assigned"), and their task no longer counts
    // as solidly staffed on their account.
    const assignedIds = new Set<string>();
    const draftedIds = new Set<string>();
    const nameByUserId = new Map<string, string>();
    for (const task of todayTasks) {
        const draft = crewDrafts[task.id];
        const removeSet = new Set(draft?.removeUserIds ?? []);
        for (const assignment of task.assignments) {
            if (assignment.name) nameByUserId.set(assignment.userId, assignment.name);
            if (assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW" && !removeSet.has(assignment.userId)) {
                assignedIds.add(assignment.userId);
            }
        }
        if (draft) {
            for (const userId of draft.addUserIds) draftedIds.add(userId);
        }
    }

    const activatedFieldCrew = project.crew.filter(member => member.status === "ACTIVATED" && member.role === "FIELD_CREW");
    for (const member of activatedFieldCrew) nameByUserId.set(member.id, member.name);

    // Union project.crew with everyone who effectively holds a task today
    // (solid or drafted) — a member dragged from Available onto a job they
    // aren't crewed on must still surface in the meter as "drafted", not be
    // silently dropped because they're absent from project.crew.
    const memberIds = new Set<string>([
        ...activatedFieldCrew.map(member => member.id),
        ...assignedIds,
        ...draftedIds,
    ]);
    const members: StaffingMember[] = Array.from(memberIds).map(id => ({
        id,
        name: nameByUserId.get(id) ?? "?",
        state: assignedIds.has(id) ? "assigned" : draftedIds.has(id) ? "drafted" : "idle",
    }));

    const staffedTaskCount = todayTasks.filter(task => {
        const draft = crewDrafts[task.id];
        const removeSet = new Set(draft?.removeUserIds ?? []);
        const hasSolid = task.assignments.some(assignment => assignment.status === "ACTIVATED" && assignment.userRole === "FIELD_CREW" && !removeSet.has(assignment.userId));
        const hasDraft = Boolean(draft?.addUserIds.length);
        return hasSolid || hasDraft;
    }).length;

    return { members, staffedTaskCount, taskCount: todayTasks.length };
}
