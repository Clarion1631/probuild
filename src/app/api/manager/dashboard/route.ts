export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { startOfWeek, endOfWeek } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userHasRole } from "@/lib/mobile-auth";

const HUNDRED = new Prisma.Decimal(100);

/**
 * Manager dashboard payload. Replaces ~4 separate Supabase queries the
 * mobile app used to make. Returns:
 *  - activeWorkers:                TimeEntry[]   (entries with endTime IS NULL)
 *  - weeklyLaborCents:             number        (sum laborCost * 100, current ISO week Mon–Sun)
 *  - weeklyBurdenCents:            number        (sum burdenCost * 100, same window)
 *  - geofenceViolationsThisWeek:   number        (count where isOffsite = true, same window)
 *  - recentEdits:                  TimeEntry[]   (last 25 entries with isEdited = true)
 */
export async function GET(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;

    if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date();
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

    const [activeWorkers, weeklyEntries, geofenceViolationsThisWeek, recentEdits] =
        await Promise.all([
            prisma.timeEntry.findMany({
                where: { endTime: null },
                include: {
                    user: { select: { id: true, name: true, email: true, role: true } },
                    project: { select: { id: true, name: true, location: true } },
                    costCode: { select: { id: true, code: true, name: true } },
                },
                orderBy: { startTime: "desc" },
            }),
            prisma.timeEntry.findMany({
                where: {
                    startTime: { gte: weekStart, lte: weekEnd },
                    endTime: { not: null },
                },
                select: { laborCost: true, burdenCost: true },
            }),
            prisma.timeEntry.count({
                where: {
                    isOffsite: true,
                    startTime: { gte: weekStart, lte: weekEnd },
                },
            }),
            prisma.timeEntry.findMany({
                where: { isEdited: true },
                include: {
                    user: { select: { id: true, name: true, email: true } },
                    project: { select: { id: true, name: true } },
                },
                orderBy: { editedAt: "desc" },
                take: 25,
            }),
        ]);

    let laborSum = new Prisma.Decimal(0);
    let burdenSum = new Prisma.Decimal(0);
    for (const entry of weeklyEntries) {
        if (entry.laborCost) laborSum = laborSum.plus(entry.laborCost);
        if (entry.burdenCost) burdenSum = burdenSum.plus(entry.burdenCost);
    }
    const weeklyLaborCents = laborSum.mul(HUNDRED).toDecimalPlaces(0).toNumber();
    const weeklyBurdenCents = burdenSum.mul(HUNDRED).toDecimalPlaces(0).toNumber();

    return NextResponse.json(
        JSON.parse(
            JSON.stringify({
                activeWorkers,
                weeklyLaborCents,
                weeklyBurdenCents,
                geofenceViolationsThisWeek,
                recentEdits,
            }),
        ),
    );
}
