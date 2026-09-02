// Gusto hours export — prisma wiring (Phase 5 spec G3).
//
// The arithmetic lives in gusto-export-core.ts; this module only fetches the
// right rows and settles DEFERRED days before reading them. Both the download
// endpoint (GET /api/time-entries/export/gusto) and the review page
// (/manager/payroll-export, including the exportHash written at lock time) go
// through loadGustoExport, so a locked period's stored hash and a later
// download can never be computed from two different code paths.

import { createHash } from "crypto";
import { prisma } from "./prisma";
import { toCompanyDayKey } from "./company-day";
import { resolveCompanyTimeZone } from "./company-timezone";
import { getGustoSettings } from "./integration-store";
import { settleDay } from "./wa-breaks-db";
import { workweekStartKey } from "./overtime";
import { addDaysToKey, startOfDateInTimeZone } from "./tz-date";
import { isSalariedEmail, salariedEmails } from "./payroll-config";
import { HOURLY_PAID_ROLES } from "./pay-rate-guard";
import {
    buildGustoExport,
    planDeferredSettlements,
    toDetailCsv,
    toSummaryCsv,
    type ExportEntry,
    type ExportUser,
    type GustoExport,
} from "./gusto-export-core";

export type LoadedGustoExport = GustoExport & {
    periodStart: Date;
    periodEnd: Date;
    timeZone: string;
    summaryCsv: string;
    detailCsv: string;
    /** sha256 of the summary csv — what a lock stores and a later download is compared against. */
    summaryHash: string;
    period: {
        id: string;
        periodStart: Date;
        periodEnd: Date;
        lockedAt: Date | null;
        lockedById: string | null;
        exportHash: string | null;
        lockedBy: { name: string | null; email: string } | null;
    } | null;
};

export function hashSummaryCsv(csv: string): string {
    return createHash("sha256").update(csv, "utf8").digest("hex");
}

/** The PayrollPeriod row for exactly this range, if a human has already reviewed it. */
export async function findPayrollPeriod(periodStart: Date, periodEnd: Date) {
    return prisma.payrollPeriod.findUnique({
        where: { periodStart_periodEnd: { periodStart, periodEnd } },
        select: {
            id: true,
            periodStart: true,
            periodEnd: true,
            lockedAt: true,
            lockedById: true,
            exportHash: true,
            lockedBy: { select: { name: true, email: true } },
        },
    });
}

export async function loadGustoExport(periodStart: Date, periodEnd: Date): Promise<LoadedGustoExport> {
    const timeZone = await resolveCompanyTimeZone();
    const period = await findPayrollPeriod(periodStart, periodEnd);
    const locked = !!period?.lockedAt;

    // The query spans the FULL Mon-Sun workweeks overlapping the period, so a
    // period that opens mid-week still sees the hours that already pushed that
    // week toward 40 (gusto-export-core invariant 3, same technique as
    // pay-period-summary-core.ts).
    const queryStart = startOfDateInTimeZone(workweekStartKey(periodStart, timeZone), timeZone);
    const lastIncludedInstant = new Date(periodEnd.getTime() - 1);
    const queryEnd = startOfDateInTimeZone(
        addDaysToKey(workweekStartKey(lastIncludedInstant, timeZone), 7),
        timeZone
    );

    // Settle DEFERRED days before reading (never today, never a worker with an
    // open punch, never at all for a locked period) — carried over from the
    // deleted /api/gusto/export route.
    const unsettledRows = await prisma.timeEntry.findMany({
        where: {
            startTime: { gte: periodStart, lt: periodEnd },
            mealOutcome: "DEFERRED",
            endTime: { not: null },
        },
        select: { userId: true, startTime: true },
    });
    const openPunchUserIds = (
        await prisma.timeEntry.findMany({ where: { endTime: null }, select: { userId: true } })
    ).map((row) => row.userId);
    const plan = planDeferredSettlements({
        unsettled: unsettledRows.map((row) => ({ userId: row.userId, dayKey: toCompanyDayKey(row.startTime) })),
        openPunchUserIds,
        todayKey: toCompanyDayKey(new Date()),
        locked,
    });
    for (const { userId, dayKey } of plan) {
        await settleDay(userId, dayKey, null);
    }

    const rows = await prisma.timeEntry.findMany({
        where: { startTime: { gte: queryStart, lt: queryEnd } },
        select: {
            id: true,
            userId: true,
            startTime: true,
            endTime: true,
            durationHours: true,
            shiftHours: true,
            mealDeductionHours: true,
            needsReview: true,
            isEdited: true,
            project: { select: { name: true } },
            costCode: { select: { code: true, name: true } },
        },
        orderBy: { startTime: "asc" },
    });

    const entries: ExportEntry[] = rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        startTime: row.startTime,
        endTime: row.endTime,
        durationHours: row.durationHours ?? 0,
        shiftHours: row.shiftHours ?? null,
        mealDeductionHours: row.mealDeductionHours ?? null,
        needsReview: row.needsReview,
        isEdited: row.isEdited,
        projectName: row.project?.name ?? null,
        costCodeLabel: row.costCode ? row.costCode.code : null,
    }));

    // Everyone paid by the hour appears even with no hours (Gusto still wants a
    // 0.00 row), plus anyone who actually punched in the window regardless of
    // role — an ADMIN/FINANCE punch belongs in the DETAIL csv for job costing.
    const punchedUserIds = [...new Set(entries.map((entry) => entry.userId))];
    const userRows = await prisma.user.findMany({
        where: {
            OR: [
                { status: "ACTIVATED", role: { in: [...HOURLY_PAID_ROLES] } },
                { id: { in: punchedUserIds } },
            ],
        },
        select: { id: true, name: true, email: true },
    });
    const users: ExportUser[] = userRows.map((row) => ({ id: row.id, name: row.name, email: row.email }));

    const gustoSettings = await getGustoSettings();
    const employeeMappings = (gustoSettings.employeeMappings || {}) as Record<string, string>;
    const salaried = salariedEmails();

    const built = buildGustoExport({
        entries,
        users,
        periodStart,
        periodEnd,
        timeZone,
        employeeMappings,
        isSalaried: (user) => isSalariedEmail(user.email, salaried),
    });

    const summaryCsv = toSummaryCsv(built.employees);
    const detailCsv = toDetailCsv(built.detail);

    return {
        ...built,
        periodStart,
        periodEnd,
        timeZone,
        summaryCsv,
        detailCsv,
        summaryHash: hashSummaryCsv(summaryCsv),
        period,
    };
}
