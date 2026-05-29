import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyReview } from "@/lib/notify";

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

    return NextResponse.json({
        ok: true,
        staleOpen: staleOpen.length,
        offsiteOpen: offsiteOpen.length,
        newAlerts: alerts,
    });
}
