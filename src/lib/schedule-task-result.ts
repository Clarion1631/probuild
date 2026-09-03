/**
 * Result contract for the schedule task server actions
 * (createScheduleTask / updateScheduleTask / deleteScheduleTask in actions.ts).
 *
 * Why a result object instead of throwing: Next.js replaces the message of any
 * error thrown from a Server Action with a generic one in production builds,
 * so "Task end date must be after its start date" reached users as
 * "An error occurred". Expected failures (validation, access, not found) are
 * therefore RETURNED, and only truly unexpected errors are thrown/logged.
 *
 * This module is safe to import from client components: types plus one
 * dependency-free error class.
 */

export type ScheduleTaskFailureCode = "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "UNEXPECTED";

export type ScheduleTaskFailure = {
    ok: false;
    code: ScheduleTaskFailureCode;
    /** Safe to show to the user verbatim. */
    error: string;
};

export type ScheduleTaskResult<T> = { ok: true; task: T } | ScheduleTaskFailure;

/**
 * Thrown by schedule-task-core for every rule a user can trip (dates, names,
 * blocked reason, appointment-only fields, closed project ...). The actions
 * layer converts it into `{ ok: false, code: "VALIDATION", error }`.
 */
export class ScheduleTaskValidationError extends Error {
    readonly code = "VALIDATION" as const;
    constructor(message: string) {
        super(message);
        this.name = "ScheduleTaskValidationError";
    }
}

// Outcome-neutral on purpose: a connection drop while the commit is being
// acknowledged can leave the write in place, so this must not promise that
// nothing changed or invite a blind retry.
export const UNEXPECTED_SCHEDULE_TASK_ERROR = "Something went wrong saving the task. Refresh the schedule to see what was saved before trying again.";

/** Narrow helper for callers that want the message regardless of outcome shape. */
export function scheduleTaskErrorMessage(result: ScheduleTaskFailure, fallback = UNEXPECTED_SCHEDULE_TASK_ERROR): string {
    return result.error || fallback;
}

/**
 * Single classification point for the schedule task server actions. Order
 * matters: "Task not found" / Prisma P2025 before ScheduleTaskValidationError
 * before "Forbidden" before the opaque UNEXPECTED fallback.
 */
export function toScheduleTaskFailure(e: unknown): ScheduleTaskFailure {
    if (e instanceof Error && e.message === "Task not found") {
        return { ok: false, code: "NOT_FOUND", error: "That task no longer exists. Refresh the page." };
    }
    if (typeof e === "object" && e && (e as any).code === "P2025") {
        return { ok: false, code: "NOT_FOUND", error: "That task no longer exists. Refresh the page." };
    }
    if (e instanceof ScheduleTaskValidationError) {
        return { ok: false, code: "VALIDATION", error: e.message };
    }
    if (e instanceof Error && e.message === "Forbidden") {
        return { ok: false, code: "FORBIDDEN", error: "You do not have access to this project's schedule." };
    }
    if (e instanceof Error && e.message === "Unauthorized") {
        return { ok: false, code: "FORBIDDEN", error: "Your session has expired. Sign in again to keep editing." };
    }
    return { ok: false, code: "UNEXPECTED", error: UNEXPECTED_SCHEDULE_TASK_ERROR };
}
