// Builds the Prisma `where` clause for GET /api/mobile/schedule/today.
//
// ADMIN/MANAGER see all open projects' tasks in the range.
// Everyone else (FIELD_CREW, FINANCE, etc.) sees ONLY the tasks they're
// individually dispatched to that day via TaskAssignment — not every task on
// every job they happen to have project access to. A field worker should only
// see the job and task they're dispatched to, so it isn't confusing.

const FULL_ACCESS_ROLES = new Set(["ADMIN", "MANAGER"]);

export function buildMobileScheduleWhere(
    user: { id: string; role: string },
    range: { start: Date; end: Date }
): any {
    const where: any = {
        startDate: { lte: range.end },
        endDate: { gte: range.start },
    };

    if (!FULL_ACCESS_ROLES.has(user.role)) {
        where.assignments = { some: { userId: user.id } };
    }

    return where;
}
