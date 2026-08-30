import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isTaskActiveOnDay } from "@/app/company-dashboard/schedule-board/dispatch-exceptions";
import { toCompanyDayKey } from "@/lib/company-day";

// Canonical resolver for TimeEntry -> ScheduleTask binding.
//
// Every TimeEntry create/edit surface calls this; nothing binds inline. Before
// this existed `TimeEntry.scheduleTaskId` was never written by ANY writer, so
// the task drawer's hours roll-up (timeEntry.aggregate by scheduleTaskId in
// actions.ts) reported zero on every task in the system.
//
// The rule is deliberately conservative: bind only when the answer is
// unambiguous, otherwise leave null and report why. A wrong binding silently
// moves labor hours onto the wrong task, which is worse than no binding.

export type PunchBindingBasis =
    /** Punch carries an estimateItemId mapping 1:1 to a LEAF task. Strongest signal. */
    | "estimateItem"
    /** Exactly one active assigned non-complete leaf task on the punch's local day. */
    | "soleAssignedTask"
    /**
     * Several active assigned leaf tasks tied ("ambiguous"), but the caller's
     * accepted dispatch suggestion names one of them — the dispatch ranking
     * already broke that same tie for the picker, so trust its pick instead
     * of dropping the binding.
     */
    | "acceptedSuggestion";

export type PunchBindingSkipReason =
    /** No eligible task at all for this user/project/day. */
    | "noCandidate"
    /** More than one eligible task — the crew member was on several that day. */
    | "ambiguous";

export interface PunchBindingInput {
    userId: string;
    projectId: string;
    /**
     * The company-local calendar day the punch belongs to ("YYYY-MM-DD").
     *
     * Callers pass this explicitly rather than handing over an instant, because
     * the two kinds of caller derive it differently: clock-in/out has a real
     * timestamp (use `toCompanyDayKey`), while manual timesheet entry has a
     * date-only string whose UTC-midnight instant lands on the PREVIOUS company
     * day (use `dayKeyFromDateOnly`). Deriving it here from a Date would silently
     * shift every manually-entered row back one day.
     */
    dayKey: string;
    /** Budget bucket chosen at clock-in, when the surface collects one. */
    estimateItemId?: string | null;
    /**
     * The scheduleTaskId the client claims dispatch suggested and the crew
     * member accepted (request body `suggestedScheduleTaskId`). Only ever
     * used to break a tie among the SAME candidate set the ambiguous case
     * already computed (assigned to this user, active on this day, on this
     * project) — never trusted to widen who or what can bind. See the
     * "acceptedSuggestion" basis above.
     */
    suggestedScheduleTaskId?: string | null;
}

export type PunchBindingResult =
    | { taskId: string; basis: PunchBindingBasis; candidateIds: string[] }
    | { taskId: null; skipped: PunchBindingSkipReason; candidateIds: string[] };

type DbClient = PrismaClient | Prisma.TransactionClient;

export { toCompanyDayKey };

/**
 * Resolve the schedule task a punch belongs to, or null when it isn't certain.
 *
 * Order matters: `estimateItemId` wins because the crew member picked that
 * budget bucket explicitly at clock-in, and `ScheduleTask.estimateItemId` is
 * `@unique`, so the mapping is 1:1 and stable over time. Crew assignments are
 * current-state only (TaskAssignment has no validity interval), so they are a
 * weaker, present-tense signal — good enough for a live punch, never safe to
 * replay over history.
 */
export async function resolveScheduleTaskForPunch(
    input: PunchBindingInput,
    db: DbClient = prisma,
): Promise<PunchBindingResult> {
    const { userId, projectId, dayKey, estimateItemId, suggestedScheduleTaskId } = input;

    const projectTasks = await db.scheduleTask.findMany({
        where: { projectId },
        select: {
            id: true,
            parentId: true,
            estimateItemId: true,
            startDate: true,
            endDate: true,
            status: true,
            type: true,
            assignments: { where: { userId }, select: { id: true } },
        },
    });

    // A phase parent spans all of its children, so it is active on every day any
    // child is, and the evidence classifier excludes parents outright. Binding to
    // one would park hours on a task that can never show as confirmed.
    const parentIds = new Set(projectTasks.map(task => task.parentId).filter((id): id is string => !!id));

    // 1) Explicit budget-bucket mapping — but only to a leaf. Schedule generation
    // links a top-level estimate item to the PHASE PARENT task, and the clock UI
    // offers exactly those top-level items, so this match is often a parent.
    // Fall through to the assignment path rather than binding to it.
    if (estimateItemId) {
        const byEstimateItem = projectTasks.find(task =>
            task.estimateItemId === estimateItemId && task.type === "task" && !parentIds.has(task.id));
        if (byEstimateItem) {
            return { taskId: byEstimateItem.id, basis: "estimateItem", candidateIds: [byEstimateItem.id] };
        }
    }

    // 2) Sole active assigned leaf task on the punch's local day.
    const candidates = projectTasks.filter(task =>
        task.type === "task"
        && task.status !== "Complete"
        && !parentIds.has(task.id)
        && task.assignments.length > 0
        && isTaskActiveOnDay(
            {
                startDate: task.startDate.toISOString(),
                endDate: task.endDate.toISOString(),
                type: task.type,
            },
            dayKey,
        ));

    const candidateIds = candidates.map(task => task.id);
    if (candidateIds.length === 1) {
        return { taskId: candidateIds[0], basis: "soleAssignedTask", candidateIds };
    }
    // Multiple tied candidates: the ambiguity is exactly what dispatch's own
    // ranking already resolved for the picker (pickDispatchWinner in
    // time-suggestion.ts). If the caller's punch names that winner, it is
    // still a member of `candidates` — same assigned/active/on-this-project
    // filter above — so binding to it never trusts anything the query above
    // didn't already verify itself.
    if (candidateIds.length > 1 && suggestedScheduleTaskId && candidateIds.includes(suggestedScheduleTaskId)) {
        return { taskId: suggestedScheduleTaskId, basis: "acceptedSuggestion", candidateIds };
    }
    return {
        taskId: null,
        skipped: candidateIds.length === 0 ? "noCandidate" : "ambiguous",
        candidateIds,
    };
}

/**
 * Convenience wrapper for write paths: returns the value to store, never throws.
 *
 * Binding is best-effort telemetry sitting beside a payroll write — a resolver
 * fault must never fail a crew member's clock-in or a manager's hour edit.
 */
export async function resolveScheduleTaskIdForPunch(
    input: PunchBindingInput,
    db: DbClient = prisma,
): Promise<string | null> {
    try {
        const result = await resolveScheduleTaskForPunch(input, db);
        return result.taskId;
    } catch (error) {
        console.error("[punch-task-binding] resolve failed", { projectId: input.projectId, dayKey: input.dayKey, error });
        return null;
    }
}
