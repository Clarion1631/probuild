// Shared, plain (non-"use server") helpers for the Office Tasks kanban board.
// Split out of actions.ts so the secret-authed ingest route (a regular route
// handler, not a server action) can reuse the exact same status/date-parsing
// logic without duplicating it — a "use server" file can only export async
// functions, so these synchronous helpers can't live there directly.

export const OFFICE_TASK_STATUSES = ["To Do", "In Progress", "Done"] as const;

export function assertValidOfficeTaskStatus(status: string) {
    if (!(OFFICE_TASK_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`Invalid status: ${status}`);
    }
}

// Parse a "YYYY-MM-DD" date-only string as UTC midnight, so the stored instant's
// calendar date is timezone-invariant (matches what the user picked, regardless
// of the server's or client's local timezone).
export function parseOfficeTaskDateOnly(s: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new Error("Invalid date");
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
