// Pure row-model derivations for the Dispatch Day lens's plain-list layout
// (see DispatchDayView.tsx). Kept dependency-free of React so it's trivially
// unit-testable — see tests/dispatch-day-rows.test.ts.
//
// "Day mode" reduces dispatch to: what task, what cost code it's costed
// against, who's on it, and a note — one row per active task, grouped by job.

import { isTaskActiveOnDay } from "./dispatch-exceptions";
import { isDispatchable } from "@/lib/dispatch-roster";
import { isConflictedDay } from "./availability";
import { addDays, formatDate, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";

export interface DispatchDayCrewInput {
    id: string;
    name: string;
    status: string;
    role: string;
    showOnDispatch: boolean;
}

export interface DispatchDayAssignmentInput {
    userId: string;
    name: string;
    status: string;
    userRole: string;
    assignmentRole: string; // "lead" | "assigned"
    showOnDispatch: boolean;
}

export interface DispatchDayTaskInput {
    id: string;
    name: string;
    type: string;
    /** Set on a sub-task; null on a top-level task. Used to tell a phase parent (has children) from a leaf — mirrors the `parentIds` check in time-suggestion.ts's loadSuggestableTasks. */
    parentId: string | null;
    /** Mirrors time-suggestion.ts's loadSuggestableTasks `task.status === "Complete"` rejection — see isDispatchableRow. */
    status: string;
    startDate: string;
    endDate: string;
    doneWhen: string | null;
    estimateItemId: string | null;
    /** Cost code from the task's linked estimate item, e.g. "07-DRYWALL". Null when not costed. */
    costCode: string | null;
    assignments: DispatchDayAssignmentInput[];
}

export interface DispatchDayProjectInput {
    id: string;
    name: string;
    crew: DispatchDayCrewInput[];
    tasks: DispatchDayTaskInput[];
}

export interface DispatchDayCrewDraft {
    addUserIds: string[];
    removeUserIds: string[];
}

export interface DispatchDayConflictPairInput {
    projectA: { id: string; name: string };
    projectB: { id: string; name: string };
    overlapStart: string;
    overlapEnd: string;
    taskA?: { id: string; name: string; startDate: string; endDate: string };
    taskB?: { id: string; name: string; startDate: string; endDate: string };
}

export interface DispatchDayCrewConflictInput {
    userId: string;
    name: string;
    pairs: DispatchDayConflictPairInput[];
}

export interface DispatchDayRosterMember {
    id: string;
    name: string;
    // Optional: present when the caller has it (e.g. the full team roster),
    // absent in older call sites/tests that only pass id+name. Used purely
    // for disambiguateMemberNames and as a hover-title fallback — never
    // required for the row math above.
    email?: string;
}

export interface DispatchDayNameCollisionInput {
    id: string;
    name: string;
    email: string;
}

/**
 * Two accounts sharing a display name (e.g. two "Justin Adkins") are
 * otherwise indistinguishable in the assign popover and the "Not on a job
 * today" strip. Any name that collides case-insensitively with another
 * member's in the same list gets its email appended — "Justin Adkins
 * (jadkins@goldentouchremodeling.com)" — so the two entries are never
 * identical text. Non-colliding names are returned bare. Pure/testable by
 * design: the caller decides which pool of members counts as "the list"
 * (see DispatchView.tsx, which runs it over the full team roster).
 */
export function disambiguateMemberNames(
    members: readonly DispatchDayNameCollisionInput[],
): Map<string, string> {
    const counts = new Map<string, number>();
    for (const member of members) {
        const key = member.name.trim().toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const labels = new Map<string, string>();
    for (const member of members) {
        const key = member.name.trim().toLowerCase();
        labels.set(member.id, (counts.get(key) ?? 0) > 1 ? `${member.name} (${member.email})` : member.name);
    }
    return labels;
}

export type DispatchDayPersonState = "assigned" | "drafted";

export interface DispatchDayPerson {
    id: string;
    name: string;
    lead: boolean;
    state: DispatchDayPersonState;
    conflicted: boolean;
    /** "Also on <job> today" when conflicted, else null. */
    conflictTitle: string | null;
}

function firstNameOf(name: string): string {
    return name.split(/\s+/)[0] || name;
}

/**
 * Compact chip label per person in one row/strip — normally just the first
 * name, but `person.name` can already carry a FULL-roster email
 * disambiguation ("Justin Adkins (jadkins@…)") that a bare first-name split
 * throws away, so two different Justins in the same row/strip would render
 * as two identical "Justin" chips. When first names collide within this
 * specific list, append a short "(<email-local-part>)" suffix so the two
 * chips read distinctly; a non-colliding name renders as a bare first name.
 * `memberEmailsById` supplies the local part — a person missing from it
 * (no known email) falls back to the bare first name even mid-collision
 * rather than showing a broken "(undefined)" suffix.
 */
export function chipLabelsForRow(
    people: readonly { id: string; name: string }[],
    memberEmailsById: ReadonlyMap<string, string>,
): Map<string, string> {
    const firstNames = people.map(person => firstNameOf(person.name));
    const counts = new Map<string, number>();
    for (const name of firstNames) counts.set(name, (counts.get(name) ?? 0) + 1);
    const labels = new Map<string, string>();
    people.forEach((person, index) => {
        const first = firstNames[index];
        const email = (counts.get(first) ?? 0) > 1 ? memberEmailsById.get(person.id) : undefined;
        const localPart = email ? email.split("@")[0] : null;
        labels.set(person.id, localPart ? `${first} (${localPart})` : first);
    });
    return labels;
}

export interface DispatchDayRow {
    taskId: string;
    taskType: string;
    taskName: string;
    costCode: string | null;
    isCosted: boolean;
    people: DispatchDayPerson[];
    doneWhen: string | null;
    /** False when the task can never be named on a time card — see isDispatchableRow. */
    dispatchable: boolean;
    /** Human reason for a non-dispatchable row ("Milestone" / "Appointment" / "Has sub-tasks"), else null. */
    notDispatchableReason: string | null;
}

/**
 * True when a task can actually be picked on a time card — mirrors the
 * candidate rule in src/lib/time-suggestion.ts's loadSuggestableTasks:
 * `type === "task"` (excludes milestone/appointment), `status !== "Complete"`
 * (a finished task has nothing left to clock in against), and a leaf
 * (excludes a phase parent — `hasChildren` is true when some other task in
 * the project has this one as its parentId). Deliberately does NOT also
 * require a resolved cost code — DispatchDayRow already surfaces that
 * separately via `isCosted`/"not costed", and an uncosted-but-assignable
 * task still reaches a time card (it just doesn't charge anywhere yet).
 */
export function isDispatchableRow(task: Pick<DispatchDayTaskInput, "type" | "status">, hasChildren: boolean): boolean {
    return task.type === "task" && task.status !== "Complete" && !hasChildren;
}

/** Why `isDispatchableRow` said no, for the row's muted tag title. Null when dispatchable. */
export function notDispatchableReason(task: Pick<DispatchDayTaskInput, "type" | "status">, hasChildren: boolean): string | null {
    if (task.type === "milestone") return "Milestone — has no time card to assign to.";
    if (task.type === "appointment") return "Appointment — has no time card to assign to.";
    if (task.status === "Complete") return "Completed — has no time card to assign to.";
    if (hasChildren) return "Has sub-tasks — assign to the sub-tasks instead.";
    return null;
}

/** Task shape `assertDispatchableTarget` needs — `hasChildren` precomputed by the caller (scoped to the task's own project's task list, same as `isDispatchableRow`/`notDispatchableReason`). */
export interface DispatchTargetTask extends Pick<DispatchDayTaskInput, "type" | "status"> {
    hasChildren: boolean;
}

/**
 * Pure guard for a crew-draft add: the reason `task` can't be dispatched
 * (same wording as `notDispatchableReason`), or null when it's a valid
 * target. Used by the draft writer (ScheduleBoard's `onDraftCrewAdd`) to
 * refuse adding crew onto a milestone, appointment, completed task, or phase
 * parent instead of silently drafting an assignment that can never reach a
 * time card.
 */
export function assertDispatchableTarget(task: DispatchTargetTask): string | null {
    return notDispatchableReason(task, task.hasChildren);
}

/** parentId → "has at least one child" set, scoped to one project's task list. */
function parentIdsOf(tasks: readonly Pick<DispatchDayTaskInput, "id" | "parentId">[]): Set<string> {
    return new Set(tasks.map(task => task.parentId).filter((id): id is string => Boolean(id)));
}

export interface DispatchDayTaskChoice {
    projectId: string;
    projectName: string;
    taskId: string;
    taskName: string;
    dayLabel: string;
}

/**
 * The keyboard/drag crew-chooser's task list for one day: every task active
 * on `dayKey` across `projects` that's actually dispatchable (item 1's
 * rule) — a milestone, appointment, or phase parent never appears as a
 * choice, matching the row-level "+ Assign" gating in DispatchDayView.
 */
export function dispatchableTaskChoicesForDay(
    projects: readonly DispatchDayProjectInput[],
    dayKey: string,
): DispatchDayTaskChoice[] {
    return projects.flatMap(project => {
        const parentIds = parentIdsOf(project.tasks);
        return project.tasks
            .filter(task => isTaskActiveOnDay(task, dayKey))
            .filter(task => isDispatchableRow(task, parentIds.has(task.id)))
            .map(task => ({
                projectId: project.id,
                projectName: project.name,
                taskId: task.id,
                taskName: task.name,
                dayLabel: dayKey,
            }));
    });
}

export interface DispatchDayJobGroup {
    projectId: string;
    projectName: string;
    // Empty when the project has no task active on `dayKey` — the group
    // still renders (a PM plans Monday from an empty board) with a muted
    // "Nothing planned this day" line in place of the row table.
    rows: DispatchDayRow[];
}

/**
 * True when `person` (already known to be on `currentProjectId` today) also
 * has a solid conflicting assignment on a different job the same day —
 * derived from the same crewConflicts data the Week grid's red ring uses.
 * Returns the other job's name for the "Also on <job> today" title, or null.
 */
export function findConflictOtherProject(
    conflicts: readonly DispatchDayCrewConflictInput[] | null,
    userId: string,
    dayKey: string,
    currentProjectId: string,
): string | null {
    if (!conflicts) return null;
    const entry = conflicts.find(conflict => conflict.userId === userId);
    if (!entry) return null;
    if (!isConflictedDay(entry ? [entry] : null, userId, dayKey, true)) return null;
    for (const pair of entry.pairs) {
        if (!pair.taskA || !pair.taskB) continue;
        const startKey = pair.overlapStart.slice(0, 10);
        const endKey = pair.overlapEnd.slice(0, 10);
        if (!(startKey <= dayKey && dayKey < endKey)) continue;
        if (pair.projectA.id === currentProjectId) return pair.projectB.name;
        if (pair.projectB.id === currentProjectId) return pair.projectA.name;
    }
    return null;
}

/**
 * Builds one row per task active on `dayKey`, grouped by job — the Day
 * mode's entire data model. Every project passed in gets a group, even one
 * with no task active today (`rows: []`), so a PM can plan an empty day from
 * a job that's simply idle that day rather than it silently not appearing.
 * Callers decide which projects belong in "the list" (see DispatchView,
 * which passes only `data.pipeline.inProgress`).
 */
export function buildDispatchDayJobGroups(
    projects: readonly DispatchDayProjectInput[],
    dayKey: string,
    crewDrafts: Readonly<Record<string, DispatchDayCrewDraft>>,
    crewConflicts: readonly DispatchDayCrewConflictInput[] | null,
    memberNamesById: ReadonlyMap<string, string>,
): DispatchDayJobGroup[] {
    const groups: DispatchDayJobGroup[] = [];
    for (const project of projects) {
        const activeTasks = project.tasks.filter(task => isTaskActiveOnDay(task, dayKey));
        const parentIds = parentIdsOf(project.tasks);

        const rows: DispatchDayRow[] = activeTasks.map(task => {
            const hasChildren = parentIds.has(task.id);
            const draft = crewDrafts[task.id];
            const removeSet = new Set(draft?.removeUserIds ?? []);
            const addIds = draft?.addUserIds ?? [];
            // Callers (ScheduleBoard's boardData) already overlay crewDrafts
            // into task.assignments for other consumers' previews, so an add
            // draft's id can already be sitting in task.assignments by the
            // time it gets here. Exclude every addUserIds id from "solid"
            // regardless of whether it's in task.assignments, so a drafted
            // add is classified "drafted" here too rather than rendering
            // solid a render cycle early.
            const addSet = new Set(addIds);
            const solid = task.assignments.filter(assignment =>
                assignment.status === "ACTIVATED"
                && isDispatchable({ role: assignment.userRole, status: assignment.status, showOnDispatch: assignment.showOnDispatch })
                && !removeSet.has(assignment.userId)
                && !addSet.has(assignment.userId));

            const rawPeople: { id: string; name: string; lead: boolean; state: DispatchDayPersonState }[] = [
                // Prefer the (possibly disambiguated) roster label over the raw
                // assignment name so a "Justin Adkins" duplicate reads the same
                // way whether they're already assigned or just drafted on.
                ...solid.map(assignment => ({ id: assignment.userId, name: memberNamesById.get(assignment.userId) ?? assignment.name, lead: assignment.assignmentRole === "lead", state: "assigned" as const })),
                ...addIds.map(id => {
                    const existing = task.assignments.find(assignment => assignment.userId === id);
                    return {
                        id,
                        name: memberNamesById.get(id) ?? existing?.name ?? "?",
                        lead: existing?.assignmentRole === "lead",
                        state: "drafted" as const,
                    };
                }),
            ];

            const people: DispatchDayPerson[] = rawPeople.map(person => {
                const otherProject = findConflictOtherProject(crewConflicts, person.id, dayKey, project.id);
                return {
                    ...person,
                    conflicted: Boolean(otherProject),
                    conflictTitle: otherProject ? `Also on ${otherProject} today` : null,
                };
            });

            return {
                taskId: task.id,
                taskType: task.type,
                taskName: task.name,
                costCode: task.costCode,
                // costCode already comes through resolveChargeableItems (the
                // single "what does this charge to" authority — see
                // DashboardTaskRow.costCode in schedule-core.ts), so its mere
                // presence IS "costed": a leaf under a coded parent already
                // resolved to the parent's code, and an item on an ineligible
                // estimate already resolved to null. No estimateItemId check
                // needed on top of that.
                isCosted: task.costCode != null,
                people,
                doneWhen: task.doneWhen,
                dispatchable: isDispatchableRow(task, hasChildren),
                notDispatchableReason: notDispatchableReason(task, hasChildren),
            };
        });

        groups.push({ projectId: project.id, projectName: project.name, rows });
    }
    return groups;
}

/**
 * Roster members with no assignment (solid or drafted) on any active task
 * today — the "Not on a job today" strip. Mirrors the solid/removed/added
 * accounting buildDispatchDayJobGroups uses so the two never disagree.
 */
export function getRosterNotOnJobToday(
    roster: readonly DispatchDayRosterMember[],
    projects: readonly DispatchDayProjectInput[],
    dayKey: string,
    crewDrafts: Readonly<Record<string, DispatchDayCrewDraft>>,
): DispatchDayRosterMember[] {
    const busyIds = new Set<string>();
    for (const project of projects) {
        for (const task of project.tasks) {
            if (!isTaskActiveOnDay(task, dayKey)) continue;
            const draft = crewDrafts[task.id];
            const removeSet = new Set(draft?.removeUserIds ?? []);
            for (const assignment of task.assignments) {
                if (assignment.status === "ACTIVATED"
                    && isDispatchable({ role: assignment.userRole, status: assignment.status, showOnDispatch: assignment.showOnDispatch })
                    && !removeSet.has(assignment.userId)) {
                    busyIds.add(assignment.userId);
                }
            }
            for (const id of draft?.addUserIds ?? []) busyIds.add(id);
        }
    }
    return roster.filter(member => !busyIds.has(member.id));
}

/**
 * The task's final dispatchable crew (solid assignments minus drafted
 * removals, plus drafted adds) as plain userIds — the same solid/removed/added
 * accounting buildDispatchDayJobGroups and getRosterNotOnJobToday use, reduced
 * to just ids for feeding findReviewCollisions.
 */
export function finalTaskUserIds(
    task: Pick<DispatchDayTaskInput, "assignments">,
    draft: DispatchDayCrewDraft | undefined,
): string[] {
    const removeSet = new Set(draft?.removeUserIds ?? []);
    const solidIds = task.assignments
        .filter(assignment => assignment.status === "ACTIVATED"
            && isDispatchable({ role: assignment.userRole, status: assignment.status, showOnDispatch: assignment.showOnDispatch })
            && !removeSet.has(assignment.userId))
        .map(assignment => assignment.userId);
    const solidSet = new Set(solidIds);
    const addIds = (draft?.addUserIds ?? []).filter(id => !solidSet.has(id));
    return [...solidIds, ...addIds];
}

export interface DispatchReviewTaskInput {
    id: string;
    projectId: string;
    projectName: string;
    name: string;
    startDate: string;
    endDate: string;
    /** Currently-SAVED dispatchable assignments for this task — the "saved" half of "saved + drafted adds − drafted removes". Ignored for a task named in `crewChanges`, whose `afterUserIds` is authoritative instead. */
    savedUserIds: readonly string[];
}

export interface DispatchReviewCrewChangeInput {
    taskId: string;
    /** The task's final crew after the drafted change — already saved + drafted adds − drafted removes, e.g. a reviewed TASK_CREW change's `after.assignments`. */
    afterUserIds: readonly string[];
}

/**
 * Cross-project double-booking check over a FINAL assignment snapshot — task
 * windows only, same rule as the server's getCrewConflicts (schedule-core.ts)
 * task-based tier — so a caller can feed it draft-applied state and catch
 * things the server's already-committed crewConflicts can't yet see: two
 * conflicting drafted adds in the same review, or a drafted add colliding
 * with a saved assignment on a DIFFERENT day than the one being edited
 * (multi-day task windows, not just same-day).
 *
 * Two calling shapes share this one function (per the owner's "the row-level
 * red name uses the same function" rule):
 *  - DispatchReviewDialog: `tasks` carries each task's currently-saved crew,
 *    `crewChanges` carries the review's own TASK_CREW changes (whose
 *    `afterUserIds` overrides the saved crew for just those tasks).
 *  - DispatchDayView's row-level red name: `tasks` carries each task's
 *    ALREADY draft-applied crew (via `finalTaskUserIds`) as `savedUserIds`,
 *    with no `crewChanges` — the draft is baked into "saved" up front.
 *
 * Returns the same shape the server's CrewConflict/DispatchDayCrewConflictInput
 * uses, so downstream consumers (findConflictOtherProject) don't need to know
 * which source produced their conflict data.
 */
export function findReviewCollisions(
    tasks: readonly DispatchReviewTaskInput[],
    crewChanges: readonly DispatchReviewCrewChangeInput[] = [],
): DispatchDayCrewConflictInput[] {
    const afterByTask = new Map(crewChanges.map(change => [change.taskId, change.afterUserIds]));
    interface UserWindow {
        taskId: string;
        projectId: string;
        projectName: string;
        name: string;
        start: string;
        end: string;
    }
    const windowsByUser = new Map<string, UserWindow[]>();
    for (const task of tasks) {
        if (task.endDate <= task.startDate) continue; // zero/negative-length window can't overlap anything
        const userIds = afterByTask.get(task.id) ?? task.savedUserIds;
        for (const userId of userIds) {
            const windows = windowsByUser.get(userId) ?? [];
            windows.push({ taskId: task.id, projectId: task.projectId, projectName: task.projectName, name: task.name, start: task.startDate, end: task.endDate });
            windowsByUser.set(userId, windows);
        }
    }

    const result: DispatchDayCrewConflictInput[] = [];
    for (const [userId, windows] of windowsByUser) {
        const pairs: DispatchDayConflictPairInput[] = [];
        for (let i = 0; i < windows.length; i++) {
            for (let j = i + 1; j < windows.length; j++) {
                const a = windows[i];
                const b = windows[j];
                if (a.projectId === b.projectId) continue; // same job — not a double-booking
                const overlapStart = a.start > b.start ? a.start : b.start;
                const overlapEnd = a.end < b.end ? a.end : b.end;
                if (overlapStart >= overlapEnd) continue; // no actual window overlap
                pairs.push({
                    projectA: { id: a.projectId, name: a.projectName },
                    projectB: { id: b.projectId, name: b.projectName },
                    overlapStart,
                    overlapEnd,
                    taskA: { id: a.taskId, name: a.name, startDate: a.start, endDate: a.end },
                    taskB: { id: b.taskId, name: b.name, startDate: b.start, endDate: b.end },
                });
            }
        }
        if (pairs.length > 0) result.push({ userId, name: "", pairs });
    }
    return result;
}

/**
 * Identity key for one collision pair, scoped to the user it double-books:
 * {userId, the two project ids (order-independent), overlap window}. Two
 * pairs with the same key are "the same collision" — a task's crew or dates
 * changing so the overlap window shifts/widens produces a DIFFERENT key
 * (correctly read as "worsened", not "still the same"), and a project pair
 * flipping order (A/B swapped) still matches (ids are sorted first).
 */
function collisionPairKey(userId: string, pair: DispatchDayConflictPairInput): string {
    const [projectIdA, projectIdB] = [pair.projectA.id, pair.projectB.id].sort();
    return `${userId}|${projectIdA}|${projectIdB}|${pair.overlapStart}|${pair.overlapEnd}`;
}

/**
 * Collisions present in `after` (the review's final state) that were NOT
 * already present in `before` (the canonical, pre-review state) — i.e.
 * collisions this review introduces or worsens. A pre-existing collision the
 * review leaves untouched is excluded (its pair key is unchanged, so it's in
 * both sets); a drafted removal that resolves a collision simply doesn't
 * appear in `after` at all, so it's excluded too. Used by DispatchReviewDialog
 * so the warning banner reflects only what THIS review is responsible for.
 */
export function collisionDelta(
    before: readonly DispatchDayCrewConflictInput[],
    after: readonly DispatchDayCrewConflictInput[],
): DispatchDayCrewConflictInput[] {
    const beforeKeys = new Set<string>();
    for (const entry of before) {
        for (const pair of entry.pairs) beforeKeys.add(collisionPairKey(entry.userId, pair));
    }
    const result: DispatchDayCrewConflictInput[] = [];
    for (const entry of after) {
        const newPairs = entry.pairs.filter(pair => !beforeKeys.has(collisionPairKey(entry.userId, pair)));
        if (newPairs.length > 0) result.push({ ...entry, pairs: newPairs });
    }
    return result;
}

/**
 * Draft-aware collision scan across EVERY task of every project passed in
 * (not just today's active ones — a collision can span days beyond the
 * viewed day). Feeds findReviewCollisions with each task's draft-applied
 * crew via finalTaskUserIds — this is what DispatchDayView's row-level red
 * name uses (through findConflictOtherProject) instead of relying solely on
 * the server's committed crewConflicts, so two drafted adds collide live,
 * before either is saved.
 */
/**
 * Hypothetical collision check for the assign popover: "if `candidateUserId`
 * were added to `task` right now, would that create or worsen a collision on
 * `dayKey` specifically?" — unlike findConflictOtherProject (which only
 * flags someone ALREADY double-booked from an existing collision pair), this
 * evaluates the candidate against every other project's draft-applied crew
 * even when they currently have exactly one job today and adding this one
 * would be their first collision. Reuses the same
 * finalTaskUserIds/findReviewCollisions machinery buildDispatchDayCollisions
 * does, with the candidate injected onto `task`'s final crew — but every
 * task's window is clipped down to just `dayKey` (only tasks active that day
 * are considered at all, per isTaskActiveOnDay) so a multi-day task's
 * overlap on a DIFFERENT day (e.g. a Friday-only clash on a task that also
 * runs Monday) never surfaces a warning on a day it doesn't actually
 * conflict. (The review dialog's own window-based check, over the task's
 * full multi-day span, is unaffected — see findReviewCollisions.) Returns
 * the other job's name for the "Also on <job> today" hint, or null when no
 * collision would result.
 */
export function wouldCollide(
    candidateUserId: string,
    task: Pick<DispatchDayTaskInput, "id"> & { projectId: string },
    allProjects: readonly DispatchDayProjectInput[],
    crewDrafts: Readonly<Record<string, DispatchDayCrewDraft>>,
    dayKey: string,
): string | null {
    const nextDayKey = formatDate(addDays(parseUTCDate(dayKey), 1));
    const tasks: DispatchReviewTaskInput[] = [];
    for (const project of allProjects) {
        for (const projectTask of project.tasks) {
            if (!isTaskActiveOnDay(projectTask, dayKey)) continue;
            const finalIds = finalTaskUserIds(projectTask, crewDrafts[projectTask.id]);
            const userIds = projectTask.id === task.id && !finalIds.includes(candidateUserId)
                ? [...finalIds, candidateUserId]
                : finalIds;
            tasks.push({
                id: projectTask.id,
                projectId: project.id,
                projectName: project.name,
                name: projectTask.name,
                // Clipped to just this one day — see doc comment above.
                startDate: dayKey,
                endDate: nextDayKey,
                savedUserIds: userIds,
            });
        }
    }
    const collisions = findReviewCollisions(tasks);
    const entry = collisions.find(collision => collision.userId === candidateUserId);
    if (!entry) return null;
    for (const pair of entry.pairs) {
        if (pair.projectA.id === task.projectId) return pair.projectB.name;
        if (pair.projectB.id === task.projectId) return pair.projectA.name;
    }
    return null;
}

export function buildDispatchDayCollisions(
    projects: readonly DispatchDayProjectInput[],
    crewDrafts: Readonly<Record<string, DispatchDayCrewDraft>>,
): DispatchDayCrewConflictInput[] {
    const tasks: DispatchReviewTaskInput[] = [];
    for (const project of projects) {
        for (const task of project.tasks) {
            tasks.push({
                id: task.id,
                projectId: project.id,
                projectName: project.name,
                name: task.name,
                startDate: task.startDate,
                endDate: task.endDate,
                savedUserIds: finalTaskUserIds(task, crewDrafts[task.id]),
            });
        }
    }
    return findReviewCollisions(tasks);
}
