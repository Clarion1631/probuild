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

/**
 * Is this an interactive transaction client rather than the base client?
 *
 * Prisma builds a transaction client as the base client MINUS the members in
 * `ITXClientDenyList` — `$transaction` among them — so the absence of that one
 * method IS the distinction, at runtime, with no flag for a caller to forget to
 * pass. Checked by NAME rather than by `instanceof`: there is no exported class
 * to compare against, and a structural check keeps the test fakes working.
 */
function isTransactionClient(client: ExportDbClient): boolean {
    return typeof (client as { $transaction?: unknown }).$transaction !== "function";
}

/**
 * Pin the two MUTABLE, NON-entry inputs to the export — the company time zone
 * and the Gusto employee mappings — for the rest of the caller's transaction.
 *
 * Both are read by name from single rows that live outside the payroll tables,
 * so no row lock the payroll paths already take covers them, and both change the
 * bytes of the CSV: the zone decides which company-local day (and therefore
 * which workweek, and therefore how much of the period is overtime) every punch
 * lands in, and the mappings fill the gustoEmployeeId column. A zone or mapping
 * edit committed between the first read and the entry read would produce a
 * hash over inputs that never existed together at any instant — and
 * lockPayrollPeriod would freeze a pay period around it.
 *
 * FOR SHARE, not FOR UPDATE: concurrent exports do not conflict with each
 * other, only with somebody CHANGING these rows (integration-store's
 * updateIntegrationSettings takes FOR UPDATE on the same Integration row).
 *
 * Only meaningful inside a transaction. On the base client every statement is
 * its own transaction, so the lock would be released before the next line —
 * hence the guard rather than a lock that silently promises nothing. The page
 * render and the download endpoint are ordinary reads and take nothing.
 *
 * LOCK ORDER: taken AFTER the payroll advisory lock (tier 1) and BEFORE any
 * TimeEntry row lock, and nothing that holds these two rows ever goes on to
 * wait for a payroll lock — so this adds no cycle to the order documented in
 * payroll-period.ts.
 */
async function lockExportInputRows(client: Prisma.TransactionClient): Promise<void> {
    await client.$queryRawUnsafe(`SELECT "id" FROM "CompanySettings" WHERE "id" = $1 FOR SHARE`, "singleton");
    await client.$queryRawUnsafe(`SELECT "id" FROM "Integration" WHERE "id" = $1 FOR SHARE`, "system_settings");
}

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
    /**
     * The frozen export for this exact period, when it is locked. Downloads
     * serve THIS, verbatim — a locked period is never recomputed, because the
     * CSVs are built from mutable inputs (a member's name, email, payType, the
     * Gusto id mapping, a punch's project and cost code after logistics
     * recoding) and would not reproduce the file that was actually sent.
     *
     * `exportHash`, `summaryCsv` and `detailCsv` above stay LIVE, so the review
     * page can show what the period looks like now and flag drift from the
     * snapshot.
     */
    snapshot: { summaryCsv: string; detailCsv: string; exportHash: string } | null;
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
    /**
     * The requested range OVERLAPS a locked period but is not that period.
     *
     * Such a range has no snapshot of its own, so serving it would recompute
     * numbers that are already frozen somewhere else and hand back a file that
     * disagrees with what payroll was paid. There is no correct CSV to return —
     * the caller has to ask for the locked period itself.
     */
    overlapsLockWithoutBeingIt: boolean;
};

export type PayrollPeriodRow = {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    lockedAt: Date | null;
    lockedById: string | null;
    exportHash: string | null;
    /** The zone the period was locked in — enforcement uses it, not today's company zone. */
    timeZone: string | null;
    /** STABLE identity: the company-local days this period covers, half-open. */
    periodStartKey: string | null;
    periodEndKey: string | null;
    /** THE EXPORT, FROZEN at lock time. Served verbatim; never recomputed. */
    summaryCsvSnapshot: string | null;
    detailCsvSnapshot: string | null;
    lockedBy: { name: string | null; email: string } | null;
};

const PAYROLL_PERIOD_SELECT = {
    id: true,
    periodStart: true,
    periodEnd: true,
    lockedAt: true,
    lockedById: true,
    exportHash: true,
    timeZone: true,
    periodStartKey: true,
    periodEndKey: true,
    summaryCsvSnapshot: true,
    detailCsvSnapshot: true,
    /// Read so findPayrollPeriod can refuse to hand a retired row back.
    discardedAt: true,
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

/**
 * The PayrollPeriod row for exactly this range, by its STABLE day keys.
 *
 * Not by timestamp: the timestamps are derived from company-local days, so they
 * move when CompanySettings.timeZone changes, and an exact timestamp match then
 * fails to find a period's own locked row — the download quietly fell back to
 * live CSV and unlock updated zero rows while reporting success.
 */
export async function findPayrollPeriod(startKey: string, endKey: string, client: ExportDbClient = prisma) {
    const period = await client.payrollPeriod.findUnique({
        where: { periodStartKey_periodEndKey: { periodStartKey: startKey, periodEndKey: endKey } },
        select: PAYROLL_PERIOD_SELECT,
    });
    // A DISCARDED row is not a period. It is kept only for the audit trail, and
    // every reader must be blind to it — otherwise a retired wrong-range row
    // would still serve its snapshot and still answer "this period exists".
    return period && (period as { discardedAt?: Date | null }).discardedAt ? null : period;
}

/**
 * Locked periods whose PAY-PERIOD RANGE overlaps [start, end). Half-open on
 * both sides, so two adjacent periods do not count as overlapping.
 *
 * Deliberately the period range and NOT the workweek envelope. The envelope is
 * OT context — the extra days a lock has to freeze so the overtime split inside
 * the period cannot move — and it necessarily bleeds into the neighbouring
 * period. Judging OWNERSHIP on it made two consecutive Sunday-start periods
 * look like they overlapped each other, so the second could neither be exported
 * nor locked. Ownership is about which period a punch BELONGS to; freezing is
 * about what has to hold still. Two different questions, two different ranges.
 */
export async function findOverlappingLockedPeriods(
    startKey: string,
    endKey: string,
    client: ExportDbClient = prisma
): Promise<PayrollPeriodRow[]> {
    // Compared on the STABLE day keys, not the timestamps. The timestamps are
    // derived from company-local days, so they shift when the company time zone
    // changes — and an overlap test on shifted values reports a different answer
    // for the same two periods than it did yesterday. Keys are YYYY-MM-DD text,
    // so the half-open comparison is a plain lexicographic one and cannot move.
    return client.payrollPeriod.findMany({
        where: {
            lockedAt: { not: null },
            periodStartKey: { lt: endKey },
            periodEndKey: { gt: startKey },
        },
        select: PAYROLL_PERIOD_SELECT,
        orderBy: { periodStartKey: "asc" },
    });
}

export async function loadGustoExport(
    periodStart: Date,
    periodEnd: Date,
    options: {
        /** Stable day keys identifying this period. Required to find its locked row and snapshot. */
        startKey?: string;
        endKey?: string;
        /** Read through a transaction client — used by lockPayrollPeriod to recompute inside its own transaction. */
        client?: ExportDbClient;
        /**
         * The zone the CALLER already resolved and is acting on — the one
         * lockPayrollPeriod derived periodStart/periodEnd from and is about to
         * persist on the period row.
         *
         * Not used as the answer: it is an ASSERTION. The zone is resolved once
         * here, through `client`, under the FOR SHARE taken above, and a caller
         * whose value disagrees is told so instead of quietly getting an export
         * computed in a different zone from the one being recorded.
         */
        timeZone?: string;
    } = {}
): Promise<LoadedGustoExport> {
    const client = options.client ?? prisma;

    // FIRST, before any input is read: pin the zone and the mappings for the
    // rest of the transaction (no-op outside one — see lockExportInputRows).
    if (isTransactionClient(client)) {
        await lockExportInputRows(client as Prisma.TransactionClient);
    }

    // Resolved ONCE, through `client`, and everything below is derived from it.
    // A global-client read here would be a second connection outside the
    // caller's transaction — free to see a zone the FOR SHARE above is holding
    // still, and to hand back an envelope that disagrees with the entries.
    const timeZone = await resolveCompanyTimeZone(client);
    if (options.timeZone !== undefined && options.timeZone !== timeZone) {
        throw new Error(
            `The company time zone changed (${options.timeZone} to ${timeZone}) while this pay period was being read. ` +
                "Nothing was changed - refresh and try again."
        );
    }

    // The Gusto employee mappings, read in the SAME transaction and under the
    // same lock. They fill a CSV column, so they are an input to the hash, and
    // reading them on the global client after the entries meant the file could
    // mix mappings from one instant with hours from another.
    const gustoSettings = await getGustoSettings(client);
    const employeeMappings = (gustoSettings.employeeMappings || {}) as Record<string, string>;

    // Full workweeks overlapping the period. This is BOTH the window the lock
    // freezes and the window the readiness check looks at, because overtime
    // inside the period depends on hours in the same week outside it.
    const envelope = payrollLockEnvelope(periodStart, periodEnd, timeZone);

    // Day keys derived in the CURRENT zone are only a fallback for callers that
    // did not supply them; a stored period is always matched on its own keys.
    const startKey = options.startKey ?? dayKeyInTimeZone(periodStart, timeZone);
    const endKey = options.endKey ?? dayKeyInTimeZone(periodEnd, timeZone);

    // SEQUENTIAL, not Promise.all. `client` may be an interactive transaction
    // client, which is bound to ONE connection: firing both queries at once puts
    // two statements on a single connection that has a statement in flight, and
    // the saved round trip is worth nothing next to the entry query below.
    const period = await findPayrollPeriod(startKey, endKey, client);
    // Ownership: the pay-period range, on its stable day keys (see above).
    const overlappingLocks = await findOverlappingLockedPeriods(startKey, endKey, client);

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
    //
    // "Paid by the hour" is payType HOURLY, whatever their ROLE: an hourly ADMIN
    // or FINANCE user is a real arrangement, and keying the zero-hour roster off
    // role alone dropped them from the file entirely. The role list stays as a
    // fallback for accounts whose payType nobody has set yet — they are blocked
    // by unknownPayTypeBlockers anyway, and appearing is how they get noticed.
    // ONLY people with hours INSIDE the period. The wider query exists solely to
    // get the 40-hour threshold right; a punch in the surrounding context week
    // is not a reason to put somebody on this period's roster. A disabled former
    // employee whose last shift landed in the context week was being added to
    // the file — and then blocking it, because nobody had set a pay type on an
    // account that is gone.
    const punchedUserIds = [
        ...new Set(
            entries
                .filter((entry) => entry.startTime >= periodStart && entry.startTime < periodEnd)
                .map((entry) => entry.userId)
        ),
    ];
    const userRows = await client.user.findMany({
        where: {
            OR: [
                // Known-hourly staff appear as 0.00 summary rows even with no
                // punches — their pay type is answered, so they cannot block.
                { status: "ACTIVATED", payType: "HOURLY" },
                // Anyone who actually worked in the period, whatever their
                // status or pay type.
                { id: { in: punchedUserIds } },
            ],
            // The clause that used to sit here pulled in every ACTIVATED
            // null-payType user in an hourly role, regardless of hours. That is
            // what let a new hire with no punches block the whole pay run: the
            // export refused until somebody answered a question about a person
            // this file says nothing about. Null pay types now reach the roster
            // only via punchedUserIds.
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

    const snapshot =
        period?.lockedAt && period.summaryCsvSnapshot != null && period.detailCsvSnapshot != null
            ? {
                  summaryCsv: period.summaryCsvSnapshot,
                  detailCsv: period.detailCsvSnapshot,
                  exportHash: period.exportHash ?? hashExport(period.summaryCsvSnapshot, period.detailCsvSnapshot),
              }
            : null;

    // "Locked" for THIS range means the exact period is locked. An ad-hoc range
    // that merely overlaps one is a different, unanswerable question.
    const exactLocked = !!period?.lockedAt;

    return {
        ...built,
        snapshot,
        overlapsLockWithoutBeingIt: !exactLocked && overlappingLocks.length > 0,
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
