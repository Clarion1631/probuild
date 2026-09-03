export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { addDaysToKey, startOfDateInTimeZone } from "@/lib/tz-date";
import { validatePayrollRange } from "@/lib/payroll-config";
import { canActOnFinancialsResolved } from "@/lib/financial-access";
import { prisma } from "@/lib/prisma";
import { acquirePayrollWriteLock } from "@/lib/payroll-period";
import {
    isLabelRowMissingError,
    isLockedSnapshotMissingError,
    isNonStaffOnPayrollError,
    loadGustoExport,
    loadLockedSnapshot,
    type LoadedGustoExport,
} from "@/lib/gusto-export-db";

/**
 * GET /api/time-entries/export/gusto?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD&format=summary|detail
 *
 * Payroll hours out (Phase 5 spec G3). Replaces the old, completely ungated
 * /api/gusto/export (deleted in the same commit) — that route had no role check
 * of any kind and exported one row per ENTRY, which is not what Gusto imports.
 *
 * The range is HALF-OPEN in company-local calendar days: `periodEnd` is the day
 * AFTER the last day of the period, exactly like PayrollPeriod. The review page
 * is what turns a human's inclusive "to" date into this.
 *
 * WEB ONLY — deliberately NOT on the proxy's Bearer allowlist. The crew app has
 * no reason to pull the whole company's payroll, and the allowlist entry for
 * /api/time-entries does not reach this two-segment suffix.
 *
 * Auth: ADMIN, or the `financialReports` permission.
 *
 * Refuses with 409 while any entry inside the period is still open, flagged for
 * review, closed with no hours, or has an unsettled meal — "approved" for
 * export means closed, unflagged, and settled, and a payroll file built from a
 * half-finished period is worse than no file.
 *
 * Extracted as a DI factory so the AUTH matrix is testable without a database
 * (tests/gusto-export-route.test.ts) — a source-string check would not prove a
 * FIELD_CREW actually gets a 403.
 */
export type GustoExportViewer = { role: string; canReadFinancialReports: boolean };

export interface GustoExportDependencies {
    /** Resolved staff viewer, or null when there is no session. */
    authenticate(): Promise<GustoExportViewer | null>;
    resolveTimeZone(): Promise<string>;
    /**
     * `timeZone` is part of the payload, not an afterthought: it is the ONE
     * resolution that both the period boundaries above and the day/overtime
     * classification inside the loader are derived from. The handler used to
     * resolve the zone, build the boundaries from it, and then call the loader
     * without it — so the loader resolved the zone a second time, on a different
     * connection at a different instant, and a zone change landing in between
     * produced a CSV whose boundaries were queried in one zone and whose days
     * were classified in another.
     */
    load(
        periodStart: Date,
        periodEnd: Date,
        keys: { startKey: string; endKey: string; timeZone: string }
    ): Promise<LoadedGustoExport>;
    /**
     * The frozen file for an exactly-locked period, read from ONE row and
     * touching no live input. Null when the period is not locked.
     *
     * Separate from `load` on purpose. A locked period has already been paid;
     * whether it can be downloaded must not depend on the integration settings
     * being readable or on today's roster being sane, both of which `load`
     * reads and either of which can refuse (round 10, finding 4).
     */
    loadSnapshot(keys: { startKey: string; endKey: string }): Promise<{
        summaryCsv: string;
        detailCsv: string;
        exportHash: string;
    } | null>;
    /**
     * Run `body` while HOLDING the payroll advisory lock in SHARE mode.
     *
     * A live export used to race period creation (round 16, finding 2). The
     * handler checked for a frozen row, found none, and then spent the rest of
     * the request reading live data with nothing held — so a lockPayrollPeriod
     * committing in between produced `X-Export-Source: live` for a period that
     * was, by the time the bytes were sent, locked and frozen around DIFFERENT
     * numbers.
     *
     * SHARE, not exclusive: two people downloading at once is fine, and this
     * is the same tier-1 lock every payroll writer takes, so it queues behind
     * an in-flight lock instead of overtaking it. Once acquired, no lock can
     * COMMIT until this transaction ends — which is what makes the re-check
     * inside it final rather than another guess.
     */
    withPayrollReadLock<T>(body: () => Promise<T>): Promise<T>;
}

export function createGustoExportHandler(dependencies: GustoExportDependencies) {
    return {
        async GET(req: Request) {
            const viewer = await dependencies.authenticate();
            if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            // STAFF, then the permission. `authenticate` resolves the permission
            // rather than handing back a row, so this calls the resolved form of
            // the SAME predicate the other gates use. It used to be the
            // permission alone, and `financialReports` is assignable to a portal
            // CLIENT (round 15, finding 1).
            if (!canActOnFinancialsResolved(viewer.role, viewer.canReadFinancialReports)) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }

            const { searchParams } = new URL(req.url);
            const startKey = searchParams.get("periodStart");
            const endKey = searchParams.get("periodEnd");
            const format = searchParams.get("format") === "detail" ? "detail" : "summary";

            // The SAME validator the lock action and the review page use. Its
            // day-key check is a real calendar check, so 2026-02-31 is a 400
            // here rather than being silently rolled forward to 2026-03-03 by
            // Date and exporting a period nobody asked for.
            const range = validatePayrollRange(startKey, endKey);
            if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });

            // THE FROZEN FILE FIRST - before the company time zone is even
            // resolved. The day keys identifying a period are stable text, so
            // finding its frozen row needs no zone at all; resolving one first
            // put a live CompanySettings read in front of a download that is
            // supposed to depend on nothing live (round 11, finding 3).
            const lastDayKey = addDaysToKey(range.endKey, -1);
            const frozenResponse = (snapshot: { summaryCsv: string; detailCsv: string; exportHash: string }) =>
                new NextResponse(format === "detail" ? snapshot.detailCsv : snapshot.summaryCsv, {
                    headers: {
                        "Content-Type": "text/csv; charset=utf-8",
                        "Content-Disposition": `attachment; filename="gusto-${format}-${range.startKey}_to_${lastDayKey}.csv"`,
                        "X-Export-Hash": snapshot.exportHash,
                        "X-Export-Source": "snapshot",
                    },
                });
            try {
                const snapshot = await dependencies.loadSnapshot({
                    startKey: range.startKey,
                    endKey: range.endKey,
                });
                if (snapshot) return frozenResponse(snapshot);
            } catch (error) {
                // A locked row whose frozen CSVs are not all there. Still fails
                // closed (round 6) - but now it is the ONLY thing that can stop
                // a locked download.
                if (isLockedSnapshotMissingError(error)) {
                    return NextResponse.json(
                        { error: error.message, code: "LOCKED_SNAPSHOT_MISSING" },
                        { status: 409 }
                    );
                }
                throw error;
            }

            // No frozen file for this exact range — YET.
            //
            // Everything from here on happens while HOLDING the payroll advisory
            // lock in share mode, and the very first thing it does is ask again.
            // Without that, the check above was a guess about a moving target: a
            // period locked a millisecond later was served live, with numbers
            // that disagreed with the file payroll actually received (round 16,
            // finding 2). Under the lock the answer cannot change until this
            // request is done with it.
            return dependencies.withPayrollReadLock(async () => {
                let frozen: Awaited<ReturnType<typeof dependencies.loadSnapshot>>;
                try {
                    frozen = await dependencies.loadSnapshot({
                        startKey: range.startKey,
                        endKey: range.endKey,
                    });
                } catch (error) {
                    if (isLockedSnapshotMissingError(error)) {
                        return NextResponse.json(
                            { error: error.message, code: "LOCKED_SNAPSHOT_MISSING" },
                            { status: 409 }
                        );
                    }
                    throw error;
                }
                // It WAS locked, in the gap. Serve what payroll was paid.
                if (frozen) return frozenResponse(frozen);

            const timeZone = await dependencies.resolveTimeZone();
            const periodStart = startOfDateInTimeZone(range.startKey, timeZone);
            const periodEnd = startOfDateInTimeZone(range.endKey, timeZone);

            let result: LoadedGustoExport;
            try {
                // The SAME `timeZone` periodStart/periodEnd were just derived
                // from — one resolution for the whole request.
                result = await dependencies.load(periodStart, periodEnd, {
                    startKey: range.startKey,
                    endKey: range.endKey,
                    timeZone,
                });
            } catch (error) {
                // A locked period with an incomplete frozen export. There is no
                // correct file to return: the snapshot is gone and a recomputed
                // one is not what payroll was paid, so this REFUSES rather than
                // falling through to the live CSV below (which is exactly what
                // it used to do). 409, with the recovery instruction.
                if (isLockedSnapshotMissingError(error)) {
                    return NextResponse.json(
                        { error: error.message, code: "LOCKED_SNAPSHOT_MISSING" },
                        { status: 409 }
                    );
                }
                // A non-employee account has hours in this period. There is no
                // correct file: paying a customer is wrong and silently
                // dropping their hours from job costing is wrong too, so a
                // human has to fix the account first.
                if (isNonStaffOnPayrollError(error)) {
                    return NextResponse.json(
                        { error: error.message, code: "NON_STAFF_ON_PAYROLL", userIds: error.userIds },
                        { status: 409 }
                    );
                }
                // A project or cost code this file prints was deleted or
                // re-coded while the period was being read. Refusing beats
                // freezing a CSV that disagrees with the database.
                if (isLabelRowMissingError(error)) {
                    return NextResponse.json(
                        { error: error.message, code: "LABEL_ROW_MISSING", entryIds: error.entryIds },
                        { status: 409 }
                    );
                }
                throw error;
            }

            // Belt and braces. The snapshot-first read above already served
            // every exactly-locked period, so reaching here with a snapshot in
            // hand means the two reads disagreed - which is a bug, not a state.
            // Serving the frozen file is still the right answer to it.
            if (result.snapshot) {
                const lastDay = lastDayKey;
                return new NextResponse(
                    format === "detail" ? result.snapshot.detailCsv : result.snapshot.summaryCsv,
                    {
                        headers: {
                            "Content-Type": "text/csv; charset=utf-8",
                            "Content-Disposition": `attachment; filename="gusto-${format}-${range.startKey}_to_${lastDay}.csv"`,
                            "X-Export-Hash": result.snapshot.exportHash,
                            "X-Export-Source": "snapshot",
                        },
                    }
                );
            }

            // A range that overlaps a locked period without BEING it has no
            // snapshot, so any CSV built for it would disagree with what was
            // already paid for the overlapping days.
            if (result.overlapsLockWithoutBeingIt) {
                return NextResponse.json(
                    {
                        error: "That range overlaps a locked pay period. Ask for the locked period itself — a range that only partly covers it cannot be exported.",
                        code: "OVERLAPS_LOCKED_PERIOD",
                        lockedPeriods: result.overlappingLocks.map((row) => ({
                            periodStart: row.periodStartKey,
                            periodEnd: row.periodEndKey,
                        })),
                    },
                    { status: 409 }
                );
            }

            if (result.blocking.length > 0) {
                return NextResponse.json(
                    {
                        error: "Some time entries in this period are not ready to export (still open, flagged, zero hours, or an unsettled meal). Clear them on /manager/time-entries first.",
                        code: "PERIOD_NOT_READY",
                        blocking: result.blocking.map((row) => ({
                            id: row.id,
                            employee: row.userLabel,
                            startTime: row.startTime.toISOString(),
                            reason: row.reason,
                        })),
                    },
                    { status: 409 }
                );
            }

            const csv = format === "detail" ? result.detailCsv : result.summaryCsv;
            const filename = `gusto-${format}-${range.startKey}_to_${lastDayKey}.csv`;

            return new NextResponse(csv, {
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": `attachment; filename="${filename}"`,
                    // Covers BOTH csvs — lets the review page compare a fresh
                    // download against the hash stored when the period was locked.
                    "X-Export-Hash": result.exportHash,
                    "X-Export-Source": "live",
                },
            });
            });
        },
    };
}

const handler = createGustoExportHandler({
    authenticate: async () => {
        const user = await getCurrentUserWithPermissions();
        if (!user) return null;
        return { role: user.role, canReadFinancialReports: hasPermission(user, "financialReports") };
    },
    resolveTimeZone: resolveCompanyTimeZone,
    // `keys` carries startKey, endKey AND the resolved timeZone, so the loader
    // is computed in the same zone the boundaries were built in.
    load: (periodStart, periodEnd, keys) => loadGustoExport(periodStart, periodEnd, keys),
    loadSnapshot: (keys) => loadLockedSnapshot(keys.startKey, keys.endKey),
    // The lock is held for the WHOLE body: the re-check and the live read both
    // happen inside this transaction, so no period lock can commit between
    // them. The reads themselves go through the singleton, which is fine —
    // what serializes here is the advisory lock, not the connection.
    withPayrollReadLock: (body) =>
        prisma.$transaction(
            async (tx) => {
                await acquirePayrollWriteLock(tx);
                return body();
            },
            // A full period's export is not a 5-second query on a big month.
            { timeout: 120_000, maxWait: 30_000 }
        ),
});

export async function GET(req: Request) {
    return handler.GET(req);
}
