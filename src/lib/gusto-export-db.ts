// Gusto hours export — prisma wiring (Phase 5 spec G3).
//
// The arithmetic lives in gusto-export-core.ts; this module only fetches the
// right rows and settles DEFERRED days before reading them. Both the download
// endpoint (GET /api/time-entries/export/gusto) and the review page
// (/manager/payroll-export, including the exportHash written at lock time) go
// through loadGustoExport, so a locked period's stored hash and a later
// download can never be computed from two different code paths.
//
// loadGustoExport IS A PURE READ. It used to run WA meal settlement as a side
// effect, from a GET handler and from a page render — a page refresh mutating
// payroll rows. It no longer does: an unsettled DEFERRED day BLOCKS the export
// (409) and a human settles it with the explicit "Settle deferred days" button
// on /manager/payroll-export (settleDeferredDaysForPeriod in actions.ts).

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { resolveCompanyTimeZone } from "./company-timezone";
import { getGustoSettings } from "./integration-store";
import { workweekStartKey } from "./overtime";
import { addDaysToKey, dayKeyInTimeZone, startOfDateInTimeZone } from "./tz-date";
import { isSalariedEmail, payrollLockEnvelope, salariedEmails } from "./payroll-config";
import { HOURLY_PAID_ROLES } from "./pay-rate-guard";
import {
    buildGustoExport,
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
    /** Full workweeks overlapping the period — the window the lock freezes and the readiness check uses. */
    envelopeStart: Date;
    envelopeEnd: Date;
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
    /** The row for EXACTLY this range, if a human has reviewed it. Used for the stored hash and the lock button. */
    period: PayrollPeriodRow | null;
    /**
     * Every LOCKED period whose workweek envelope overlaps this range — which is
     * NOT the same question as `period?.lockedAt`. An ad-hoc range that merely
     * OVERLAPS a locked period has no exact row of its own, so the exact lookup
     * said "unlocked" while half the range was frozen and the page happily
     * offered to lock it again.
     */
    overlappingLocks: PayrollPeriodRow[];
    locked: boolean;
};

export type PayrollPeriodRow = {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    lockedAt: Date | null;
    lockedById: string | null;
    exportHash: string | null;
    lockedBy: { name: string | null; email: string } | null;
};

const PAYROLL_PERIOD_SELECT = {
    id: true,
    periodStart: true,
    periodEnd: true,
    lockedAt: true,
    lockedById: true,
    exportHash: true,
    lockedBy: { select: { name: true, email: true } },
} as const;

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
        select: PAYROLL_PERIOD_SELECT,
    });
}

/**
 * Locked periods that OVERLAP [start, end). Half-open on both sides, so two
 * adjacent periods do not count as overlapping.
 */
export async function findOverlappingLockedPeriods(
    start: Date,
    end: Date,
    client: ExportDbClient = prisma
): Promise<PayrollPeriodRow[]> {
    return client.payrollPeriod.findMany({
        where: { lockedAt: { not: null }, periodStart: { lt: end }, periodEnd: { gt: start } },
        select: PAYROLL_PERIOD_SELECT,
        orderBy: { periodStart: "asc" },
    });
}

export async function loadGustoExport(
    periodStart: Date,
    periodEnd: Date,
    options: {
        /** Read through a transaction client — used by lockPayrollPeriod to recompute inside its own transaction. */
        client?: ExportDbClient;
    } = {}
): Promise<LoadedGustoExport> {
    const client = options.client ?? prisma;
    const timeZone = await resolveCompanyTimeZone();

    // Full workweeks overlapping the period. This is BOTH the window the lock
    // freezes and the window the readiness check looks at, because overtime
    // inside the period depends on hours in the same week outside it.
    const envelope = payrollLockEnvelope(periodStart, periodEnd, timeZone);

    const [period, overlappingLocks] = await Promise.all([
        findPayrollPeriod(periodStart, periodEnd, client),
        findOverlappingLockedPeriods(envelope.start, envelope.end, client),
    ]);

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
        select: { id: true, name: true, email: true, payType: true },
        orderBy: { id: "asc" },
    });
    const users: ExportUser[] = userRows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        payType: row.payType ?? null,
    }));

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
        envelopeStart: envelope.start,
        envelopeEnd: envelope.end,
        // payType is the answer; the env list is only consulted for rows it has
        // not answered (and unknownPayTypeBlockers refuses to export those).
        isSalaried: (user) => user.payType === "SALARY" || (!user.payType && isSalariedEmail(user.email, salaried)),
    });

    const summaryCsv = toSummaryCsv(built.employees);
    const detailCsv = toDetailCsv(built.detail);

    return {
        ...built,
        periodStart,
        periodEnd,
        envelopeStart: envelope.start,
        envelopeEnd: envelope.end,
        timeZone,
        summaryCsv,
        detailCsv,
        exportHash: hashExport(summaryCsv, detailCsv),
        period,
        overlappingLocks,
        locked: overlappingLocks.length > 0,
    };
}
