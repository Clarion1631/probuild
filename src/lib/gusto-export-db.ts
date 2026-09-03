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
import { acquireIntegrationSettingsLock, getGustoSettings } from "./integration-store";
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
 * THE ROW LOCK IS NOT THE FENCE ON THE Integration ROW — the advisory lock is.
 * FOR SHARE can only lock a row that EXISTS, and on a database that has never
 * saved an integration there is no row: the statement locks nothing, returns
 * nothing, and reports no problem. saveGustoSettings serialises on its OWN
 * advisory key rather than on this transaction, so it was free to INSERT the
 * first employee mapping after this read and before this transaction's COMMIT —
 * and lockPayrollPeriod would freeze a hash over a mappings blob that was
 * already stale at the instant it committed. Taking the SAME key the saver
 * takes (acquireIntegrationSettingsLock) covers the row's absence as well as
 * its presence, which is the whole reason that key exists. The FOR SHARE stays:
 * it is a second fence against anything that ever writes "Integration" without
 * going through integration-store.
 *
 * Taken FIRST, before either row lock, so a saver blocks before it has read
 * anything rather than after it has built a document from a stale blob.
 *
 * Only meaningful inside a transaction. On the base client every statement is
 * its own transaction, so the lock would be released before the next line —
 * hence the guard rather than a lock that silently promises nothing. The page
 * render and the download endpoint are ordinary reads and take nothing.
 *
 * LOCK ORDER: taken AFTER the payroll advisory lock (tier 1) and BEFORE any
 * TimeEntry row lock, and nothing that holds the integration key or these two
 * rows ever goes on to wait for a payroll lock — so this adds no cycle to the
 * order documented in payroll-period.ts.
 */
async function lockExportInputRows(client: Prisma.TransactionClient): Promise<void> {
    // The saver's own key — covers the Integration row's ABSENCE, which no row
    // lock can. See the note above.
    await acquireIntegrationSettingsLock(client);
    await client.$queryRawUnsafe(`SELECT "id" FROM "CompanySettings" WHERE "id" = $1 FOR SHARE`, "singleton");
    await client.$queryRawUnsafe(`SELECT "id" FROM "Integration" WHERE "id" = $1 FOR SHARE`, "system_settings");
}

/**
 * Re-read the roster's User rows FOR SHARE, and use THOSE values.
 *
 * The third mutable, non-entry input. name, email and payType all reach the
 * CSVs — payType decides whether somebody is summarised as hourly at all — and
 * an ordinary findMany holds nothing, so a pay-type change could commit between
 * the export's read and lockPayrollPeriod's COMMIT and leave a period frozen
 * around a roster that had already moved.
 *
 * The advisory lock in every rate/pay-type writer (pay-rate-write.ts,
 * setUserPayType, applyGustoRateImport) is the primary defence: they wait for
 * the exclusive lock the period holds. This is the second one, at the row
 * level, so a writer that somehow does NOT take that lock still blocks here
 * until this transaction commits.
 *
 * FOR SHARE re-reads rather than reusing the findMany's values on purpose: under
 * READ COMMITTED the earlier read can already be stale, and the point of the
 * lock is to hash what is committed at the moment it is held.
 *
 * LOCK ORDER: after the payroll advisory lock, after the settings rows, after
 * the TimeEntry read — the same "TimeEntry before User" ordering settlement
 * uses (see settleDayInTx), so the two cannot form a cycle. Sorted by id, like
 * every other multi-row lock here.
 */
async function readExportUsersForShare(
    client: Prisma.TransactionClient,
    ids: string[]
): Promise<Array<{ id: string; name: string | null; email: string; payType: string | null }>> {
    if (ids.length === 0) return [];
    return (await client.$queryRawUnsafe(
        `SELECT "id", "name", "email", "payType" FROM "User" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR SHARE`,
        ids
    )) as Array<{ id: string; name: string | null; email: string; payType: string | null }>;
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

/**
 * A period says it is LOCKED but its frozen CSVs are not all there.
 *
 * This is the one state the export must never paper over. `snapshot` used to be
 * built only when BOTH csv columns were non-null, and a row with `lockedAt` set
 * and a null snapshot simply produced `snapshot: null` — which still counted as
 * "the exact period is locked", so the overlap refusal did not fire either, and
 * the endpoint fell through to serving a FRESHLY RECOMPUTED csv with
 * `X-Export-Source: live`. A locked period is precisely the case where live
 * data is the wrong answer: the file was built from mutable inputs (a name, a
 * pay type, a Gusto id, a punch's project and cost code) and recomputing it
 * today does not reproduce what payroll was actually paid. Failing open there
 * hands a bookkeeper a plausible file that is not the one that was sent.
 *
 * So it THROWS, from the loader, rather than returning a flag a caller can
 * forget to read: an unhandled throw is a 500, which is wrong but safe, whereas
 * an unread flag is a wrong CSV that looks right. The two callers that can
 * reach it (the download endpoint and the review page) catch it and show the
 * recovery instruction below.
 *
 * Since round 6 the database also refuses to hold such a row
 * (PayrollPeriod_locked_snapshot_complete), so this is defence in depth for
 * rows written before that constraint existed, or by anything that bypasses it.
 */
export class LockedSnapshotMissingError extends Error {
    readonly periodStartKey: string | null;
    readonly periodEndKey: string | null;
    constructor(periodStartKey: string | null, periodEndKey: string | null) {
        super(
            `Pay period ${periodStartKey ?? "?"} to ${periodEndKey ?? "?"} is locked, but the frozen CSVs that were ` +
                "sent to payroll are missing from it. Nothing can be exported for this period: a recomputed file " +
                "would not be the one that was paid. An admin has to unlock the period and lock it again to rebuild " +
                "the snapshot."
        );
        this.name = "LockedSnapshotMissingError";
        this.periodStartKey = periodStartKey;
        this.periodEndKey = periodEndKey;
    }
}

/** By NAME, not instanceof — the same module-identity reason every other guard in this repo uses a name check. */
export function isLockedSnapshotMissingError(error: unknown): error is LockedSnapshotMissingError {
    return error instanceof Error && error.name === "LockedSnapshotMissingError";
}

/**
 * Is this locked row complete enough to serve? Exported so the callers and the
 * tests share ONE definition of "complete" with the loader.
 *
 * `exportHash` counts. It is what the review page compares a fresh download
 * against, and a snapshot whose hash is missing cannot answer "is this the file
 * that went to payroll" at all.
 */
export function lockedSnapshotIsComplete(
    period: Pick<PayrollPeriodRow, "lockedAt" | "summaryCsvSnapshot" | "detailCsvSnapshot" | "exportHash"> | null | undefined
): boolean {
    if (!period?.lockedAt) return true;
    return (
        period.summaryCsvSnapshot != null && period.detailCsvSnapshot != null && period.exportHash != null
    );
}

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
         * REQUIRED. The zone the CALLER already resolved, and the one it derived
         * `periodStart` / `periodEnd` from.
         *
         * IT IS THE ANSWER, not a hint. Every caller resolves the company zone
         * to build the half-open boundaries it passes in; this loader then uses
         * the SAME value to decide which company-local day each punch falls in,
         * which workweek that day belongs to, and therefore how much of the
         * period is overtime. One resolution drives both halves.
         *
         * It used to be optional and merely an assertion, with the loader
         * re-resolving the zone for itself. Outside a transaction that second
         * read is on a different connection at a different instant, so a zone
         * change landing between the caller's resolve and the loader's produced
         * an export whose BOUNDARIES were queried in zone A and whose days and
         * overtime were classified in zone B — a file that never described any
         * single configuration. Both live callers (the download endpoint and the
         * review page) were in exactly that shape. Required, rather than
         * defaulted, so no caller can drop it again: the type is the guard.
         *
         * INSIDE a transaction the loader ALSO re-resolves through `client`, under
         * the FOR SHARE taken above, and refuses if the two disagree. That check
         * is only meaningful there — it is what stops lockPayrollPeriod freezing a
         * period whose stored `timeZone` does not describe its own CSVs — and it
         * cannot fire spuriously, because the row is held for the whole
         * transaction. Outside one there is nothing holding still to check
         * against, and refusing a read-only download over a benign race would be
         * gratuitous when using the caller's zone throughout is a correct,
         * self-consistent answer.
         */
        timeZone: string;
    }
): Promise<LoadedGustoExport> {
    const client = options.client ?? prisma;

    // FIRST, before any input is read: pin the zone and the mappings for the
    // rest of the transaction (no-op outside one — see lockExportInputRows).
    if (isTransactionClient(client)) {
        await lockExportInputRows(client as Prisma.TransactionClient);
    }

    // THE zone, from the caller, used for everything below: the envelope, the
    // day keys, the workweek split, the overtime threshold. The caller already
    // derived periodStart/periodEnd from this exact value, so the boundaries and
    // the classification cannot come from two different resolutions.
    const timeZone = options.timeZone;

    // Inside a transaction, CHECK it against the row this transaction is holding
    // FOR SHARE. Resolved through `client` — a global-client read would be a
    // second connection outside the transaction, free to see a zone the lock
    // above is holding still. Outside a transaction there is nothing being held,
    // so there is nothing to check against and the caller's value simply stands
    // (see the `timeZone` option).
    if (isTransactionClient(client)) {
        const locked = await resolveCompanyTimeZone(client);
        if (locked !== timeZone) {
            throw new Error(
                `The company time zone changed (${timeZone} to ${locked}) while this pay period was being read. ` +
                    "Nothing was changed - refresh and try again."
            );
        }
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
    // FAIL CLOSED, here, before a single hour is read. A locked row missing any
    // part of its frozen export has no correct answer to give — see
    // LockedSnapshotMissingError.
    if (!lockedSnapshotIsComplete(period)) {
        throw new LockedSnapshotMissingError(period?.periodStartKey ?? startKey, period?.periodEndKey ?? endKey);
    }
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

    // The roster is settled; now PIN it. Inside a transaction the rows are
    // re-read FOR SHARE and those values are what gets hashed — see
    // readExportUsersForShare. Outside one the lock would be released before the
    // next statement, so the findMany above is the answer (the page render and
    // the download endpoint are ordinary reads, exactly like the settings rows).
    const lockedRows = isTransactionClient(client)
        ? await readExportUsersForShare(client as Prisma.TransactionClient, userRows.map((row) => row.id))
        : userRows;
    if (lockedRows.length !== userRows.length) {
        // A row on this roster was deleted in the window between the two reads.
        // Freezing a pay period around a roster that just changed is the thing
        // the lock exists to prevent, so refuse and let the caller start again.
        throw new Error(
            "A team member on this pay period changed while it was being read. Nothing was changed - refresh and try again."
        );
    }
    const users: ExportUser[] = lockedRows.map((row) => ({
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

    // A locked row that reached this line HAS all three parts — the guard above
    // threw otherwise. The null tests that used to be here read as a tolerance
    // for the incomplete case, and that reading is exactly what fell through to
    // live data; they are now narrowing for the type checker, over a fact
    // already established.
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
