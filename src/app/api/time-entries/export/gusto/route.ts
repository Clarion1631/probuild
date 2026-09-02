export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { addDaysToKey, startOfDateInTimeZone } from "@/lib/tz-date";
import { validatePayrollRange } from "@/lib/payroll-config";
import { loadGustoExport, type LoadedGustoExport } from "@/lib/gusto-export-db";

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
    load(periodStart: Date, periodEnd: Date, keys: { startKey: string; endKey: string }): Promise<LoadedGustoExport>;
}

export function createGustoExportHandler(dependencies: GustoExportDependencies) {
    return {
        async GET(req: Request) {
            const viewer = await dependencies.authenticate();
            if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            if (viewer.role !== "ADMIN" && !viewer.canReadFinancialReports) {
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

            const timeZone = await dependencies.resolveTimeZone();
            const periodStart = startOfDateInTimeZone(range.startKey, timeZone);
            const periodEnd = startOfDateInTimeZone(range.endKey, timeZone);

            const result = await dependencies.load(periodStart, periodEnd, { startKey: range.startKey, endKey: range.endKey });

            // A LOCKED period is served from its snapshot, verbatim. No
            // readiness check and no recompute: this is the file that was sent
            // to payroll, and re-deriving it from today's data could differ.
            if (result.snapshot) {
                const lastDay = addDaysToKey(range.endKey, -1);
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
            const lastDayKey = addDaysToKey(range.endKey, -1);
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
    load: (periodStart, periodEnd, keys) => loadGustoExport(periodStart, periodEnd, keys),
});

export async function GET(req: Request) {
    return handler.GET(req);
}
