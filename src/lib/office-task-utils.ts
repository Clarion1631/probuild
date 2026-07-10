// Shared, plain (non-"use server") helpers for the Office Tasks kanban board.
// Split out of actions.ts so the secret-authed ingest route (a regular route
// handler, not a server action) can reuse the exact same column-lookup/date-
// parsing logic without duplicating it — a "use server" file can only export
// async functions, so these helpers can't live there directly.

import { prisma } from "./prisma";

// Parse a "YYYY-MM-DD" date-only string as UTC midnight, so the stored instant's
// calendar date is timezone-invariant (matches what the user picked, regardless
// of the server's or client's local timezone).
export function parseOfficeTaskDateOnly(s: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new Error("Invalid date");
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// Columns are now user-defined (OfficeBoardColumn) instead of a fixed
// To Do/In Progress/Done string enum, so validation is existence-based instead
// of a fixed-set check.
export async function assertColumnExists(columnId: string) {
    const column = await prisma.officeBoardColumn.findUnique({ where: { id: columnId }, select: { id: true } });
    if (!column) throw new Error(`Invalid column: ${columnId}`);
}
