// Gusto hours export — prisma wiring (Phase 5 spec G3).
//
// The arithmetic lives in gusto-export-core.ts; this module only fetches the
// right rows and settles DEFERRED days before reading them. Both the download
// endpoint (GET /api/time-entries/export/gusto) and the review page
// (/manager/payroll-export, including the exportHash written at lock time) go
// through loadGustoExport, so a locked period's stored hash and a later
// download can never be computed from two different code paths.
//
// loadGustoExport is a READ that performs WRITES (settleDay), and it is called
// from a GET and from a page render. That is deliberate and predates this
// module: settlement is idempotent, it is skipped for today, for a worker with
// an open punch on that day, and for any day inside a locked period, so
// re-rendering the page cannot change a settled number. Anything still
// unsettled afterwards BLOCKS the export rather than being exported at full pay.

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { resolveCompanyTimeZone } from "./company-timezone";
import { getGustoSettings } from "./integration-store";
import { settleDay } from "./wa-breaks-db";
import { workweekStartKey } from "./overtime";
import { addDaysToKey, dayKeyInTimeZone, startOfDateInTimeZone } from "./tz-date";
import { isSalariedEmail, salariedEmails } from "./payroll-config";
import { HOURLY_PAID_ROLES } from "./pay-rate-guard";
import { lockedPeriodFor, loadLockedPeriods } from "./payroll-period";
import {
    buildGustoExport,
    planDeferredSettlements,
    toDetailCsv,
    toSummaryCsv,
    type ExportEntry,
    type ExportUser,
    type GustoExport,
} from "./gusto-export-core";

/** Either the base client or a transaction client — the lock action recomputes INSIDE its own transaction. */
export type ExportDbClient = typeof prisma | Prisma.TransactionClient;

export type LoadedGustoExport = GustoExport & {
    periodStart: Date;
    periodEnd: Date;
    timeZone: string;
    summaryCsv: string;
    detailCsv: string;
    /**
     * sha256 over BOTH csvs — what a lock stores and a later download is
     * compared against. Summary-only would have been a weaker promise than the
     * UI implies: two different sets of entries can produce identical rounded
     * per-employee totals, so a detail-level change (a punch moved between
     * projects, an edit flag) would not have shown up at all.
     */
    exportHash: string;
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

/** Domain separator between the two documents so csv content can never be shuffled across the boundary undetected. */
export function hashExport(summaryCsv: string, detailCsv: string): string {
    return createHash("sha256")
        .update("summary\n", "utf8")
        .update(summaryCsv, "utf8")
        .update("detail\n", "utf8")
        .update(detailCsv, "utf8")
        .digest("hex");
}

/** The PayrollPeriod row for exactly this range, if a human has already reviewed it. */
export async function findPayrollPeriod(periodStart: Date, periodEnd: Date, client: ExportDbClient = prisma) {
    return client.payrollPeriod.findUnique({
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

export async function loadGustoExport(
    periodStart: Date,
    periodEnd: Date,
    options: {
        /** Read through a transaction client — used by lockPayrollPeriod to recompute inside its own transaction. */
        client?: ExportDbClient;
        /** Skip the settlement pass. The lock's in-transaction recompute sets this: settlement already ran in the pre-check, and a settleDay call takes its own advisory lock. */
        settle?: boolean;
    } = {}
): Promise<LoadedGustoExport> {
    const client = options.client ?? prisma;
    const timeZone = await resolveCompanyTimeZone();
    const period = await findPayrollPeriod(periodStart, periodEnd, client);

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

    // Day keys use the RESOLVED company time zone, not the hardcoded one in
    // company-day.ts — everything else in this export honours CompanySettings,
    // and a settlement keyed to a different day than the export reads is a
    // silent off-by-one-day bug the moment the company zone changes.
    const dayKey = (instant: Date) => dayKeyInTimeZone(instant, timeZone);

    if (options.settle !== false) {
        // Settle DEFERRED days before reading — carried over from the deleted
        // /api/gusto/export route.
        const unsettledRows = await client.timeEntry.findMany({
            where: {
                startTime: { gte: periodStart, lt: periodEnd },
                mealOutcome: "DEFERRED",
                endTime: { not: null },
            },
            select: { userId: true, startTime: true },
        });
        // Open punches are keyed to the DAY they started, and only fetched for
        // the workers who actually have an unsettled day. The previous version
        // asked "does this worker have ANY open punch, anywhere, ever" — so
        // somebody clocked in this morning blocked settlement of their own
        // DEFERRED day in a period weeks earlier, which then exported at full
        // pay with no meal deducted.
        const affectedUserIds = [...new Set(unsettledRows.map((row) => row.userId))];
        const openRows = affectedUserIds.length
            ? await client.timeEntry.findMany({
                  where: { endTime: null, userId: { in: affectedUserIds } },
                  select: { userId: true, startTime: true },
              })
            : [];
        const lockedPeriods = await loadLockedPeriods();
        const plan = planDeferredSettlements({
            unsettled: unsettledRows.map((row) => ({ userId: row.userId, dayKey: dayKey(row.startTime) })),
            openPunchDayKeys: openRows.map((row) => `${row.userId}|${dayKey(row.startTime)}`),
            todayKey: dayKey(new Date()),
            // ANY locked period, not just this one: a wide ad-hoc range can
            // overlap a period that was already paid, and settling a day inside
            // it would move hours behind a closed payroll.
            isDayLocked: (key) =>
                !!lockedPeriodFor(lockedPeriods, startOfDateInTimeZone(key, timeZone)),
        });
        for (const settlement of plan) {
            await settleDay(settlement.userId, settlement.dayKey, null);
        }
    }

    const rows = await client.timeEntry.findMany({
        where: { startTime: { gte: queryStart, lt: queryEnd } },
        select: {
            id: true,
            userId: true,
            startTime: true,
            endTime: true,
            durationHours: true,
            shiftHours: true,
            mealDeductionHours: true,
            mealOutcome: true,
            needsReview: true,
            isEdited: true,
            project: { select: { name: true } },
            costCode: { select: { code: true, name: true } },
        },
        // id breaks the tie: two punches can share a startTime, and an
        // unordered read would reshuffle the detail csv and change the hash.
        orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

    const entries: ExportEntry[] = rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        startTime: row.startTime,
        endTime: row.endTime,
        durationHours: row.durationHours ?? 0,
        shiftHours: row.shiftHours ?? null,
        mealDeductionHours: row.mealDeductionHours ?? null,
        mealOutcome: row.mealOutcome ?? null,
        needsReview: row.needsReview,
        isEdited: row.isEdited,
        projectName: row.project?.name ?? null,
        costCodeLabel: row.costCode ? row.costCode.code : null,
    }));

    // Everyone paid by the hour appears even with no hours (Gusto still wants a
    // 0.00 row), plus anyone who actually punched in the window regardless of
    // role — an ADMIN/FINANCE punch belongs in the DETAIL csv for job costing.
    const punchedUserIds = [...new Set(entries.map((entry) => entry.userId))];
    const userRows = await client.user.findMany({
        where: {
            OR: [
                { status: "ACTIVATED", role: { in: [...HOURLY_PAID_ROLES] } },
                { id: { in: punchedUserIds } },
            ],
        },
        select: { id: true, name: true, email: true },
        orderBy: { id: "asc" },
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
        exportHash: hashExport(summaryCsv, detailCsv),
        period,
    };
}
