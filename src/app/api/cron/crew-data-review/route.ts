import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyReview } from "@/lib/notify";
import { startOfWeek } from "date-fns";

export const dynamic = "force-dynamic";

// Surfaces crew-data exceptions that the live dashboard can't (it only shows the current
// day while focused). Runs daily; dedupeKey ensures each entry alerts at most once.
//   - Stale open punches (clocked in, never clocked out) past STALE_HOURS.
//   - Currently-open entries flagged off-site by the geofence.
const STALE_HOURS = 16;

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV === "production" && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);

    const staleOpen = await prisma.timeEntry.findMany({
        where: { endTime: null, startTime: { lt: cutoff } },
        select: { id: true, projectId: true, userId: true, startTime: true },
    });

    const offsiteOpen = await prisma.timeEntry.findMany({
        where: { endTime: null, isOffsite: true },
        select: { id: true, projectId: true, userId: true, offsiteMs: true },
    });

    let alerts = 0;

    for (const e of staleOpen) {
        const hrs = Math.round((Date.now() - e.startTime.getTime()) / 3_600_000);
        const r = await notifyReview({
            type: "open_clockout",
            severity: "urgent",
            title: "Time entry still open — missing clock-out",
            body: `Clocked in ${hrs}h ago and never clocked out. Verify the hours and close it.`,
            projectId: e.projectId,
            timeEntryId: e.id,
            actorId: e.userId,
            dedupeKey: `open_clockout:${e.id}`,
        }).catch(() => ({ deduped: true }));
        if (!("deduped" in r) || !r.deduped) alerts++;
    }

    for (const e of offsiteOpen) {
        const mins = Math.round((e.offsiteMs ?? 0) / 60000);
        const r = await notifyReview({
            type: "offsite",
            severity: "warning",
            title: "Worker off-site while clocked in",
            body: `~${mins} min recorded outside the job-site geofence on an open entry.`,
            projectId: e.projectId,
            timeEntryId: e.id,
            actorId: e.userId,
            dedupeKey: `offsite:${e.id}`,
        }).catch(() => ({ deduped: true }));
        if (!("deduped" in r) || !r.deduped) alerts++;
    }

    // Overtime detection (FLSA/WA weekly OT): flag workers over 40 PAYABLE hours in the
    // current workweek so a human applies the correct premium before payroll. We DETECT and
    // notify rather than auto-apply 1.5× — the premium depends on workweek start + exempt
    // classification, which are payroll-policy decisions, not something to guess here.
    const weekStart = startOfWeek(new Date()); // Sunday-based; adjust if the workweek differs
    const weekKey = weekStart.toISOString().slice(0, 10);
    const weekAgg = await prisma.timeEntry.groupBy({
        by: ["userId"],
        where: { startTime: { gte: weekStart }, endTime: { not: null }, durationHours: { not: null } },
        _sum: { durationHours: true },
    });
    let overtimeFlagged = 0;
    for (const w of weekAgg) {
        const hrs = w._sum.durationHours ?? 0;
        if (hrs > 40) {
            const r = await notifyReview({
                type: "overtime",
                severity: "warning",
                title: "Worker over 40 hours this week",
                body: `${hrs.toFixed(1)} payable hrs so far this workweek — review for an overtime premium before payroll.`,
                actorId: w.userId,
                dedupeKey: `ot:${w.userId}:${weekKey}`,
            }).catch(() => ({ deduped: true }));
            if (!("deduped" in r) || !r.deduped) {
                alerts++;
                overtimeFlagged++;
            }
        }
    }

    return NextResponse.json({
        ok: true,
        staleOpen: staleOpen.length,
        offsiteOpen: offsiteOpen.length,
        overtimeFlagged,
        newAlerts: alerts,
    });
}
