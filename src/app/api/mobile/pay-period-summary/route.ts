export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { bucketWorkweeks, priceWorkweek, type OvertimeTimeEntry } from "@/lib/overtime";

// Pay-period pay summary: regular vs overtime hours and pay for an arbitrary
// [start, end) range, priced per Washington's weekly (Mon-Sun, company-local)
// overtime rule. Intended for the mobile app's pay/history screen — no
// existing endpoint surfaced OT-aware pay before this.
//
// The pay period does not need to align to a Monday. WA overtime is a
// property of the WORKWEEK, not the pay period, so a workweek that straddles
// the edge of the requested range still needs its FULL Mon-Sun hours to know
// whether the days inside this period were regular or overtime (e.g. a
// biweekly period that opens mid-week can already be past 40 hours for that
// workweek because of hours earned before the period started). To get that
// right, the query is padded up to PAD_DAYS on each side, the normal
// per-user weekly bucketing runs over the padded set, and only the per-entry
// regular/OT split for entries whose startTime actually falls inside
// [start, end) is kept — those splits already reflect each entry's true
// position within its complete workweek.
const PAD_DAYS = 6;

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { searchParams } = new URL(req.url);
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");
    const userIdParam = searchParams.get("userId");

    if (!startParam || !endParam) {
        return NextResponse.json({ error: "start and end are required (ISO timestamps)" }, { status: 400 });
    }

    const start = new Date(startParam);
    const end = new Date(endParam);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        return NextResponse.json({ error: "Invalid start/end range" }, { status: 400 });
    }

    let targetUserId = user.id;
    if (userIdParam && userIdParam !== user.id) {
        if (user.role !== "MANAGER" && user.role !== "ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        targetUserId = userIdParam;
    }

    const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, name: true, email: true, hourlyRate: true, burdenRate: true },
    });
    if (!targetUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const timeZone = await resolveCompanyTimeZone();
    const paddedStart = new Date(start.getTime() - PAD_DAYS * 86_400_000);
    const paddedEnd = new Date(end.getTime() + PAD_DAYS * 86_400_000);

    const entries = await prisma.timeEntry.findMany({
        where: {
            userId: targetUserId,
            startTime: { gte: paddedStart, lt: paddedEnd },
        },
        select: { startTime: true, durationHours: true },
        orderBy: { startTime: "asc" },
    });

    const overtimeEntries: OvertimeTimeEntry[] = entries
        .filter((e): e is { startTime: Date; durationHours: number } => typeof e.durationHours === "number" && e.durationHours > 0);

    const weeks = bucketWorkweeks(overtimeEntries, timeZone);

    const hourlyRate = toNum(targetUser.hourlyRate);
    const burdenRate = toNum(targetUser.burdenRate);

    let regularHours = 0;
    let overtimeHours = 0;
    const weekBreakdown: Array<{
        weekStartKey: string;
        weekStart: string;
        weekEnd: string;
        regularHours: number;
        overtimeHours: number;
        regularPay: number;
        overtimePay: number;
        totalPay: number;
    }> = [];

    for (const week of weeks) {
        // Only entries that actually fall inside the requested period count
        // toward this period's totals — the padding on either side exists
        // only to get the 40h threshold right.
        const inPeriod = week.entries.filter(
            (split) => split.entry.startTime >= start && split.entry.startTime < end,
        );
        if (inPeriod.length === 0) continue;

        const weekRegular = inPeriod.reduce((sum, split) => sum + split.regularHours, 0);
        const weekOvertime = inPeriod.reduce((sum, split) => sum + split.overtimeHours, 0);
        regularHours += weekRegular;
        overtimeHours += weekOvertime;

        const pay = priceWorkweek({ regularHours: weekRegular, overtimeHours: weekOvertime }, hourlyRate);
        weekBreakdown.push({
            weekStartKey: week.weekStartKey,
            weekStart: week.weekStart.toISOString(),
            weekEnd: week.weekEnd.toISOString(),
            regularHours: weekRegular,
            overtimeHours: weekOvertime,
            regularPay: pay.regularPay,
            overtimePay: pay.overtimePay,
            totalPay: pay.totalPay,
        });
    }

    const totals = priceWorkweek({ regularHours, overtimeHours }, hourlyRate, burdenRate);

    return NextResponse.json({
        userId: targetUser.id,
        userName: targetUser.name ?? targetUser.email,
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone,
        hourlyRate,
        burdenRate,
        regularHours,
        overtimeHours,
        totalHours: regularHours + overtimeHours,
        regularPay: totals.regularPay,
        overtimePay: totals.overtimePay,
        totalPay: totals.totalPay,
        burdenCost: totals.burdenCost,
        weeks: weekBreakdown,
    });
}
