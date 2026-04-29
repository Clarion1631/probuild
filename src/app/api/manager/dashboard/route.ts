export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

// One-shot dashboard payload for the mobile manager tab. Replaces ~4 prior client-side
// Supabase queries + 2 realtime subscriptions; mobile polls this every 30s while focused.
//
// Query params (preferred — ISO timestamps with offsets so the caller controls
// local-day boundaries):
//   dayStart   — ISO timestamp at the user's local midnight for the activity slice
//   dayEnd     — ISO timestamp at the next local midnight (exclusive upper bound)
//   weekStart  — ISO timestamp of the user's local Sunday midnight
//   userId     — optional employee filter for the activity feed
//
// Backwards-compat fallbacks (server timezone — fine for the web caller):
//   day=YYYY-MM-DD          → server-local midnight (NOT UTC)
//   weekStart unset          → start of this server-local week
//
// Returns shape mirrors `ManagerDashboardResponse` in the mobile `lib/api-types.ts`.
export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const dayStartParam = searchParams.get("dayStart");
    const dayEndParam = searchParams.get("dayEnd");
    const dayParam = searchParams.get("day"); // legacy
    const weekStartParam = searchParams.get("weekStart");
    const userIdFilter = searchParams.get("userId") || null;

    let dayStart: Date;
    let dayEnd: Date;
    if (dayStartParam && dayEndParam) {
        dayStart = new Date(dayStartParam);
        dayEnd = new Date(dayEndParam);
    } else if (dayParam) {
        // Fall back to server-local midnight rather than UTC midnight; for a US-
        // timezone user, UTC midnight buckets evening events into the wrong day.
        dayStart = new Date(dayParam);
        dayStart.setHours(0, 0, 0, 0);
        dayEnd = new Date(dayStart.getTime() + 86_400_000);
    } else {
        dayStart = startOfToday();
        dayEnd = new Date(dayStart.getTime() + 86_400_000);
    }

    const weekStart = weekStartParam ? new Date(weekStartParam) : startOfThisWeek();
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

    if (
        Number.isNaN(dayStart.getTime()) ||
        Number.isNaN(dayEnd.getTime()) ||
        Number.isNaN(weekStart.getTime()) ||
        dayEnd.getTime() <= dayStart.getTime()
    ) {
        return NextResponse.json({ error: "Invalid date bounds" }, { status: 400 });
    }

    // -------- Pull data in parallel. --------
    const [activeEntries, weeklyEntries, projects, employees, dayEntries] = await Promise.all([
        prisma.timeEntry.findMany({
            where: { endTime: null },
            include: {
                user: { select: { id: true, name: true, email: true } },
                project: { select: { id: true, name: true, locationLat: true, locationLng: true } },
                estimateItem: { select: { id: true, name: true, costCode: { select: { code: true } } } },
            },
            orderBy: { startTime: "desc" },
        }),
        prisma.timeEntry.findMany({
            where: { startTime: { gte: weekStart, lt: weekEnd } },
            select: {
                id: true,
                userId: true,
                projectId: true,
                startTime: true,
                endTime: true,
                durationHours: true,
                laborCost: true,
                burdenCost: true,
                user: { select: { name: true } },
            },
        }),
        prisma.project.findMany({
            where: { status: { not: "Closed" } },
            select: {
                id: true,
                name: true,
                locationLat: true,
                locationLng: true,
            },
        }),
        prisma.user.findMany({
            where: { role: { in: ["FIELD_CREW", "MANAGER", "ADMIN"] }, status: { not: "DISABLED" } },
            select: { id: true, name: true, email: true },
            orderBy: { name: "asc" },
        }),
        // Activity feed source: TimeEntry rows touching the selected day. We synthesize
        // clock_in / clock_out / edit events from the row state — no separate notifications
        // table to keep in sync. Edits show up because `isEdited=true` rows get an extra
        // event entry below.
        prisma.timeEntry.findMany({
            where: {
                AND: [
                    userIdFilter ? { userId: userIdFilter } : {},
                    {
                        OR: [
                            { startTime: { gte: dayStart, lt: dayEnd } },
                            { endTime: { gte: dayStart, lt: dayEnd } },
                            { editedAt: { gte: dayStart, lt: dayEnd } },
                        ],
                    },
                ],
            },
            include: {
                user: { select: { id: true, name: true } },
                project: { select: { name: true } },
            },
            orderBy: { startTime: "desc" },
        }),
    ]);

    // -------- Active workers --------
    const activeWorkers = activeEntries.map((e) => ({
        id: e.id,
        userId: e.userId,
        userName: e.user?.name ?? e.user?.email ?? "Unknown",
        projectId: e.projectId,
        projectName: e.project?.name ?? "Project",
        estimateItemName: e.estimateItem?.name ?? null,
        costCode: e.estimateItem?.costCode?.code ?? null,
        startTime: e.startTime.toISOString(),
        isOffsite: e.isOffsite,
        offsiteMs: e.offsiteMs,
        lastLocationCheck: e.lastLocationCheck?.toISOString() ?? null,
    }));

    const offsiteWorkers = activeWorkers.filter((w) => w.isOffsite);

    // -------- Weekly totals --------
    let weeklyTotalHours = 0;
    let weeklyLaborCost = 0;
    let weeklyBurdenedCost = 0;
    const employeeAgg = new Map<string, { name: string; hours: number; cost: number }>();

    for (const e of weeklyEntries) {
        const labor = toNum(e.laborCost);
        const burdened = toNum(e.burdenCost);
        // Prefer the persisted durationHours; fall back to wall-clock if it's missing
        // (e.g. an entry that was clocked in but never out — treat as 0).
        const hrs =
            typeof e.durationHours === "number"
                ? e.durationHours
                : e.endTime
                    ? (e.endTime.getTime() - e.startTime.getTime()) / 3_600_000
                    : 0;
        weeklyTotalHours += hrs;
        weeklyLaborCost += labor;
        weeklyBurdenedCost += burdened;
        const existing = employeeAgg.get(e.userId);
        if (existing) {
            existing.hours += hrs;
            existing.cost += burdened;
        } else {
            employeeAgg.set(e.userId, {
                name: e.user?.name ?? "Unknown",
                hours: hrs,
                cost: burdened,
            });
        }
    }

    const employeeStats = Array.from(employeeAgg.entries())
        .map(([userId, v]) => ({ userId, name: v.name, hours: v.hours, cost: v.cost }))
        .sort((a, b) => b.hours - a.hours);

    // -------- Per-project rollup --------
    const activeJobs = projects
        .map((p) => {
            const workers = activeWorkers.filter((w) => w.projectId === p.id);
            const weeklyHours = weeklyEntries
                .filter((e) => e.projectId === p.id && e.endTime)
                .reduce((sum, e) => {
                    const hrs =
                        typeof e.durationHours === "number"
                            ? e.durationHours
                            : (e.endTime!.getTime() - e.startTime.getTime()) / 3_600_000;
                    return sum + hrs;
                }, 0);
            return {
                id: p.id,
                name: p.name,
                activeWorkerCount: workers.length,
                totalHoursThisWeek: weeklyHours,
                hasLocation: p.locationLat != null && p.locationLng != null,
                workers,
            };
        })
        .filter((j) => j.activeWorkerCount > 0 || j.totalHoursThisWeek > 0)
        .sort(
            (a, b) =>
                b.activeWorkerCount - a.activeWorkerCount ||
                b.totalHoursThisWeek - a.totalHoursThisWeek
        );

    // -------- Activity feed (synthesized from time-entry events on the selected day) --------
    const activity: Array<{
        id: string;
        type: "clock_in" | "clock_out" | "edit" | "alert" | "info";
        message: string;
        createdAt: string;
        userId: string;
        data?: Record<string, unknown>;
    }> = [];

    for (const e of dayEntries) {
        const userName = e.user?.name ?? "Someone";
        const projName = e.project?.name ?? "a project";

        if (e.startTime >= dayStart && e.startTime < dayEnd) {
            activity.push({
                id: `${e.id}:in`,
                type: "clock_in",
                message: `${userName} clocked in to ${projName}`,
                createdAt: e.startTime.toISOString(),
                userId: e.userId,
            });
        }
        if (e.endTime && e.endTime >= dayStart && e.endTime < dayEnd) {
            activity.push({
                id: `${e.id}:out`,
                type: "clock_out",
                message: `${userName} clocked out of ${projName}`,
                createdAt: e.endTime.toISOString(),
                userId: e.userId,
            });
        }
        if (e.isEdited && e.editedAt && e.editedAt >= dayStart && e.editedAt < dayEnd) {
            activity.push({
                id: `${e.id}:edit`,
                type: "edit",
                message: `${userName}'s entry on ${projName} was edited${e.editNotes ? `: "${e.editNotes}"` : ""}`,
                createdAt: e.editedAt.toISOString(),
                userId: e.userId,
                data: {
                    entryId: e.id,
                    originalStartTime: e.originalStartTime?.toISOString() ?? null,
                    originalEndTime: e.originalEndTime?.toISOString() ?? null,
                    newStartTime: e.startTime.toISOString(),
                    newEndTime: e.endTime?.toISOString() ?? null,
                },
            });
        }
        if (e.isOffsite && !e.endTime) {
            // Live alert only — a closed entry that ended off-site is in the historical
            // record but not an actionable signal for the manager right now.
            activity.push({
                id: `${e.id}:alert`,
                type: "alert",
                message: `${userName} appears off-site on ${projName} (${Math.round(e.offsiteMs / 60_000)}m off-site total)`,
                createdAt: (e.lastLocationCheck ?? e.startTime).toISOString(),
                userId: e.userId,
            });
        }
    }

    activity.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json({
        totalActiveWorkers: activeWorkers.length,
        weeklyTotalHours,
        weeklyLaborCost,
        weeklyBurdenedCost,
        activeJobs,
        offsiteWorkers,
        employeeStats,
        activity,
        employees: employees.map((u) => ({ id: u.id, name: u.name ?? u.email })),
    });
}

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function startOfThisWeek(): Date {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
}
