import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getGustoSettings } from "@/lib/integration-store";
import { toCompanyDayKey } from "@/lib/company-day";
import { settleDay } from "@/lib/wa-breaks-db";

/**
 * Generates a Gusto-compatible CSV for time entries.
 * Gusto payroll import format:
 * Employee Name, Hours, Date, Project
 */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId") || undefined;
    const projectId = searchParams.get("projectId") || undefined;
    const dateFrom = searchParams.get("dateFrom") || undefined;
    const dateTo = searchParams.get("dateTo") || undefined;

    const gustoSettings = await getGustoSettings();
    const employeeMappings = gustoSettings.employeeMappings || {};

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    if (projectId) where.projectId = projectId;
    if (dateFrom || dateTo) {
        where.startTime = {};
        if (dateFrom) (where.startTime as Record<string, unknown>).gte = new Date(dateFrom);
        if (dateTo) (where.startTime as Record<string, unknown>).lte = new Date(dateTo + "T23:59:59");
    }

    // WA meal settlement (src/lib/wa-breaks.ts): a lunch punch or task switch
    // the worker never followed with a clock-in leaves the day unsettled
    // (DEFERRED, paid in full). Payroll must not export that as-is — settle
    // every such worker/day in range first (idempotent; no-op on settled days).
    const unsettled = await prisma.timeEntry.findMany({
        where: { ...where, mealOutcome: "DEFERRED", endTime: { not: null } },
        select: { userId: true, startTime: true },
    });
    // Never settle a day still in progress (today, or a worker with an open
    // punch — they may simply be at lunch): that would export a mid-shift
    // value the evening clock-out then re-plans.
    const todayKey = toCompanyDayKey(new Date());
    const openByUser = new Set(
        (await prisma.timeEntry.findMany({ where: { endTime: null }, select: { userId: true } })).map((r) => r.userId)
    );
    const days = new Map<string, { userId: string; dayKey: string }>();
    for (const row of unsettled) {
        const dayKey = toCompanyDayKey(row.startTime);
        if (dayKey === todayKey || openByUser.has(row.userId)) continue;
        days.set(`${row.userId}|${dayKey}`, { userId: row.userId, dayKey });
    }
    for (const { userId: uid, dayKey } of days.values()) {
        await settleDay(uid, dayKey, null);
    }

    const entries = await prisma.timeEntry.findMany({
        where,
        include: { user: true, project: true, costCode: true },
        orderBy: { startTime: "asc" },
    });

    // Build CSV
    const rows: string[] = [
        "Employee Name,Gusto Employee ID,Hours,Date,Project,Cost Code,Notes",
    ];

    for (const entry of entries) {
        const name = entry.user?.name || "Unknown";
        const gustoId = entry.userId ? (employeeMappings[entry.userId] || "") : "";
        const hours = (entry.durationHours || 0).toFixed(2);
        const date = entry.startTime
            ? new Date(entry.startTime).toLocaleDateString("en-US")
            : "";
        const project = (entry.project?.name || "").replace(/,/g, " ");
        const costCode = (entry.costCode?.code || "").replace(/,/g, " ");
        const notes = "";

        rows.push(`"${name}","${gustoId}","${hours}","${date}","${project}","${costCode}","${notes}"`);
    }

    const csv = rows.join("\n");
    const filename = `gusto-export-${new Date().toISOString().split("T")[0]}.csv`;

    return new NextResponse(csv, {
        headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}
