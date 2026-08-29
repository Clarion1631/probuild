import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { resolveScheduleRange } from "@/lib/mobile-schedule-range";
import { buildMobileScheduleWhere } from "@/lib/mobile-schedule-scope";
import { toMobileCrew } from "@/lib/mobile-task-crew";

export const dynamic = "force-dynamic";

// GET /api/mobile/schedule/today
// Returns the caller's tasks scheduled to be active in the given date range.
// With no `start`/`end` query params, defaults to today ± 1 day for slop.
// With both `start` and `end` (YYYY-MM-DD, UTC calendar dates, max 14-day span),
// returns tasks active within that explicit range instead, so the crew app can
// show one week at a time. Response includes `range` with the effective
// YYYY-MM-DD start/end actually used.
// ADMIN/MANAGER see all open projects' tasks. Everyone else sees ONLY the tasks
// they're individually dispatched to that day via TaskAssignment — a field
// worker should only see the job and task they're dispatched to, so it isn't
// confusing to also see every other task on jobs they're merely on the crew for.
// Hybrid auth: Bearer token (mobile) OR NextAuth session (web debug).
export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { searchParams } = new URL(req.url);
    const range = resolveScheduleRange(searchParams, new Date());
    if (!range.ok) {
        return NextResponse.json({ error: range.error }, { status: 400 });
    }
    const { start, end, startKey, endKey } = range;

    const baseWhere = buildMobileScheduleWhere(user, { start, end });

    const tasks = await prisma.scheduleTask.findMany({
        where: baseWhere,
        orderBy: [{ projectId: "asc" }, { startDate: "asc" }],
        select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            color: true,
            progress: true,
            status: true,
            estimatedHours: true,
            doneWhen: true,
            blockedReason: true,
            scheduledTime: true,
            projectId: true,
            project: { select: { id: true, name: true, color: true, location: true } },
            assignments: {
                // Only activated accounts are crew the field should see; deactivated
                // users stay in the assignment table for history but never in the app.
                where: { user: { status: "ACTIVATED" } },
                select: { role: true, user: { select: { id: true, name: true } } },
            },
            // Linked estimate line item + its cost code — lets the mobile geofence
            // "clock in here?" nudge preselect the matching phase for one-tap clock-in.
            estimateItemId: true,
            estimateItem: { select: { costCode: { select: { code: true, name: true } } } },
        },
    });

    const out = tasks.map(t => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        estimatedHours: t.estimatedHours ?? null,
        doneWhen: t.doneWhen ?? null,
        blockedReason: t.blockedReason ?? null,
        scheduledTime: t.scheduledTime ?? null,
        projectId: t.projectId,
        projectName: t.project?.name ?? "",
        projectColor: t.project?.color ?? null,
        projectLocation: t.project?.location ?? null,
        isAssignedToMe: t.assignments.some(a => a.user?.id === user.id),
        crew: toMobileCrew(t.assignments),
        estimateItemId: t.estimateItemId ?? null,
        costCode: t.estimateItem?.costCode ? { code: t.estimateItem.costCode.code, name: t.estimateItem.costCode.name } : null,
    }));

    return NextResponse.json({ tasks: out, range: { start: startKey, end: endKey } });
}
