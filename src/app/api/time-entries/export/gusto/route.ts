export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { addDaysToKey, daysBetweenDayKeys, startOfDateInTimeZone } from "@/lib/tz-date";
import { MAX_PAY_PERIOD_RANGE_DAYS } from "@/lib/pay-period-summary-core";
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
    load(periodStart: Date, periodEnd: Date): Promise<LoadedGustoExport>;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

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

            if (!startKey || !endKey || !DAY_KEY.test(startKey) || !DAY_KEY.test(endKey)) {
                return NextResponse.json(
                    { error: "periodStart and periodEnd are required as YYYY-MM-DD (periodEnd is exclusive)" },
                    { status: 400 }
                );
            }
            const rangeDays = daysBetweenDayKeys(startKey, endKey);
            if (!Number.isFinite(rangeDays) || rangeDays <= 0) {
                return NextResponse.json({ error: "periodEnd must be after periodStart" }, { status: 400 });
            }
            if (rangeDays > MAX_PAY_PERIOD_RANGE_DAYS) {
                return NextResponse.json(
                    { error: `Period must not exceed ${MAX_PAY_PERIOD_RANGE_DAYS} days` },
                    { status: 400 }
                );
            }

            const timeZone = await dependencies.resolveTimeZone();
            const periodStart = startOfDateInTimeZone(startKey, timeZone);
            const periodEnd = startOfDateInTimeZone(endKey, timeZone);

            const result = await dependencies.load(periodStart, periodEnd);

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
            const lastDayKey = addDaysToKey(endKey, -1);
            const filename = `gusto-${format}-${startKey}_to_${lastDayKey}.csv`;

            return new NextResponse(csv, {
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": `attachment; filename="${filename}"`,
                    // Covers BOTH csvs — lets the review page compare a fresh
                    // download against the hash stored when the period was locked.
                    "X-Export-Hash": result.exportHash,
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
    load: loadGustoExport,
});

export async function GET(req: Request) {
    return handler.GET(req);
}
