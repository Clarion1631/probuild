export const dynamic = "force-dynamic";

// Payroll review + export (Phase 5 spec G3/G4). List layout per DESIGN_SYSTEM.md.
//
// One screen, one job: look at what ProBuild thinks the period's hours are,
// download the two CSVs, and freeze the period once Gusto agrees. It is
// deliberately the ONLY way to get a payroll CSV — the old ungated
// /api/gusto/export is gone.
//
// URL dates are INCLUSIVE (`?start=2026-08-17&end=2026-08-30`) because that is
// what a human means by a pay period. The half-open [periodStart, periodEnd)
// form that the endpoint, PayrollPeriod, and the lock all use is derived here,
// in ONE place, so the two representations can never drift apart.

import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { addDaysToKey, dayKeyInTimeZone, daysBetweenDayKeys, startOfDateInTimeZone } from "@/lib/tz-date";
import { MAX_PAY_PERIOD_RANGE_DAYS } from "@/lib/pay-period-summary-core";
import { lastFullPayPeriod, payrollPeriodLength } from "@/lib/payroll-config";
import { loadGustoExport } from "@/lib/gusto-export-db";
import { lockPayrollPeriod, unlockPayrollPeriod } from "@/lib/actions";

interface Props {
    searchParams: Promise<{ start?: string; end?: string }>;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export default async function PayrollExportPage({ searchParams }: Props) {
    const session = await getSessionOrDev();
    if (!session?.user?.email) return redirect("/login");

    const viewer = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { permissions: true },
    });
    // Same gate as GET /api/time-entries/export/gusto — the page must never show
    // totals to someone the download would refuse.
    if (viewer && viewer.role !== "ADMIN" && !hasPermission(viewer, "financialReports")) {
        return <div className="p-8 text-red-500">Access Denied. Payroll access required.</div>;
    }
    if (!viewer && process.env.NODE_ENV !== "development") {
        return <div className="p-8 text-red-500">Access Denied. Payroll access required.</div>;
    }

    const params = await searchParams;
    const timeZone = await resolveCompanyTimeZone();
    const todayKey = dayKeyInTimeZone(new Date(), timeZone);
    const fallback = lastFullPayPeriod(todayKey);

    const startKey = params.start && DAY_KEY.test(params.start) ? params.start : fallback.startKey;
    // fallback.endKey is exclusive; the picker shows the inclusive last day.
    const lastDayKey =
        params.end && DAY_KEY.test(params.end) && params.end >= startKey
            ? params.end
            : addDaysToKey(fallback.endKey, -1);
    const endKeyExclusive = addDaysToKey(lastDayKey, 1);

    // Same cap as the download endpoint and the lock action. Refuse up front
    // rather than rendering totals for a range neither of them would accept.
    if (daysBetweenDayKeys(startKey, endKeyExclusive) > MAX_PAY_PERIOD_RANGE_DAYS) {
        return (
            <div className="max-w-3xl mx-auto py-16 px-6 text-center space-y-3">
                <h1 className="text-xl font-bold text-hui-textMain">That period is too long</h1>
                <p className="text-sm text-hui-textMuted">
                    A pay period cannot be longer than {MAX_PAY_PERIOD_RANGE_DAYS} days. Pick a shorter range.
                </p>
                <Link href="/manager/payroll-export" className="hui-btn hui-btn-primary text-sm">
                    Back to the current period
                </Link>
            </div>
        );
    }

    const periodStart = startOfDateInTimeZone(startKey, timeZone);
    const periodEnd = startOfDateInTimeZone(endKeyExclusive, timeZone);

    const result = await loadGustoExport(periodStart, periodEnd);
    const locked = !!result.period?.lockedAt;
    const blocked = result.blocking.length > 0;

    const downloadHref = (format: "summary" | "detail") =>
        `/api/time-entries/export/gusto?periodStart=${startKey}&periodEnd=${endKeyExclusive}&format=${format}`;

    const totals = result.employees.reduce(
        (acc, employee) => ({
            regular: acc.regular + employee.regularHours,
            overtime: acc.overtime + employee.overtimeHours,
            total: acc.total + employee.totalHours,
        }),
        { regular: 0, overtime: 0, total: 0 }
    );

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Payroll export</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        {startKey} to {lastDayKey} · {payrollPeriodLength()} default · overtime over 40h per Mon–Sun
                        week ({timeZone})
                    </p>
                </div>
                <Link href="/manager/time-entries" className="hui-btn hui-btn-secondary text-sm">
                    Time &amp; Expenses
                </Link>
            </div>

            {/* Period picker — inclusive dates, converted once above. */}
            <form method="GET" className="hui-card p-4 flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">First day</label>
                    <input type="date" name="start" defaultValue={startKey} className="hui-input text-sm py-1.5" />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">Last day</label>
                    <input type="date" name="end" defaultValue={lastDayKey} className="hui-input text-sm py-1.5" />
                </div>
                <button type="submit" className="hui-btn hui-btn-primary text-sm py-1.5 px-4">Show period</button>
                {locked && result.period && (
                    <span className="ml-auto text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
                        🔒 Locked {new Date(result.period.lockedAt as Date).toLocaleDateString()} by{" "}
                        {result.period.lockedBy?.name || result.period.lockedBy?.email || "someone"}
                    </span>
                )}
            </form>

            {blocked && (
                <div className="hui-card p-5 border-red-300 bg-red-50/40">
                    <h2 className="text-base font-semibold text-hui-textMain mb-2">
                        {result.blocking.length} entr{result.blocking.length === 1 ? "y is" : "ies are"} not ready to export
                    </h2>
                    <p className="text-sm text-hui-textMuted mb-3">
                        Payroll will not export a period that still has an open punch, a flagged entry, a closed
                        entry with no hours, or a meal break that never settled. Clear these on{" "}
                        <Link href="/manager/time-entries?flagged=1" className="underline">Time &amp; Expenses</Link> first.
                    </p>
                    <ul className="text-sm divide-y divide-hui-border">
                        {result.blocking.slice(0, 25).map((row) => (
                            <li key={row.id} className="py-1.5 flex justify-between gap-4">
                                <span className="font-medium text-hui-textMain">{row.userLabel}</span>
                                <span className="text-hui-textMuted">
                                    {new Date(row.startTime).toLocaleString()} ·{" "}
                                    {row.reason === "open"
                                        ? "still clocked in"
                                        : row.reason === "needsReview"
                                          ? "needs review"
                                          : row.reason === "zeroDuration"
                                            ? "closed with no hours"
                                            : "meal break not settled"}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-6 border-l-[3px] border-l-[#2563eb]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Regular hours</div>
                    <div className="text-3xl font-bold text-hui-textMain tabular-nums">{totals.regular.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#f97316]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Overtime hours</div>
                    <div className="text-3xl font-bold text-hui-textMain tabular-nums">{totals.overtime.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#10b981]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total hours</div>
                    <div className="text-3xl font-bold text-hui-textMain tabular-nums">{totals.total.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#ec4899]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">People</div>
                    <div className="text-3xl font-bold text-hui-textMain tabular-nums">{result.employees.length}</div>
                </div>
            </div>

            <div className="hui-card overflow-hidden">
                <div className="flex flex-wrap justify-between items-center gap-3 px-6 py-3 bg-slate-50 border-b border-hui-border">
                    <span className="font-semibold text-hui-textMain">Hours by team member</span>
                    <div className="flex items-center gap-2">
                        <a
                            href={downloadHref("summary")}
                            className={`hui-btn hui-btn-secondary text-sm ${blocked ? "pointer-events-none opacity-40" : ""}`}
                            title="One row per employee — this is the file Gusto imports"
                        >
                            Download summary CSV
                        </a>
                        <a
                            href={downloadHref("detail")}
                            className={`hui-btn hui-btn-secondary text-sm ${blocked ? "pointer-events-none opacity-40" : ""}`}
                            title="One row per time entry — for reconciling a mismatch"
                        >
                            Download detail CSV
                        </a>
                        {locked ? (
                            viewer?.role === "ADMIN" ? (
                                <form action={async () => { "use server"; await unlockPayrollPeriod(startKey, endKeyExclusive); }}>
                                    <button type="submit" className="hui-btn hui-btn-secondary text-sm">Unlock period</button>
                                </form>
                            ) : (
                                <span className="text-xs text-hui-textMuted">Only an admin can unlock</span>
                            )
                        ) : (
                            // Disabled while blocked; the action re-checks anyway,
                            // because an entry can be reopened between this render
                            // and the click.
                            <form action={async () => { "use server"; await lockPayrollPeriod(startKey, endKeyExclusive); }}>
                                <button type="submit" disabled={blocked} className="hui-btn hui-btn-primary text-sm disabled:opacity-40">
                                    Lock period
                                </button>
                            </form>
                        )}
                    </div>
                </div>
                <table className="w-full text-left text-sm">
                    <thead className="border-b border-hui-border text-hui-textMuted">
                        <tr>
                            <th className="px-5 py-3 font-medium">Team member</th>
                            <th className="px-5 py-3 font-medium">Gusto ID</th>
                            <th className="px-5 py-3 font-medium text-right">Regular</th>
                            <th className="px-5 py-3 font-medium text-right">Overtime</th>
                            <th className="px-5 py-3 font-medium text-right" title="Washington has no double time — always 0.00, kept for CSV shape">
                                Double OT
                            </th>
                            <th className="px-5 py-3 font-medium text-right">Total</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {result.employees.map((employee) => (
                            <tr key={employee.user.id} className={employee.salaried ? "bg-slate-50/60" : ""}>
                                <td className="px-5 py-3 font-medium text-hui-textMain">
                                    {employee.user.name || employee.user.email}
                                    {employee.salaried && (
                                        <span
                                            className="ml-2 text-xs text-hui-textMuted bg-slate-100 px-2 py-0.5 rounded border border-hui-border"
                                            title="Salaried in Gusto — hours are kept for job costing but left out of the summary CSV"
                                        >
                                            salaried
                                        </span>
                                    )}
                                </td>
                                <td className="px-5 py-3 text-hui-textMuted text-xs">{employee.gustoEmployeeId || "—"}</td>
                                <td className="px-5 py-3 text-right tabular-nums">{employee.regularHours.toFixed(2)}</td>
                                <td className="px-5 py-3 text-right tabular-nums">{employee.overtimeHours.toFixed(2)}</td>
                                <td className="px-5 py-3 text-right tabular-nums text-hui-textMuted">0.00</td>
                                <td className="px-5 py-3 text-right tabular-nums font-medium">{employee.totalHours.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {result.employees.length === 0 && (
                    <div className="p-6 text-center text-hui-textMuted">Nobody on payroll for this period.</div>
                )}
            </div>

            <div className="text-xs text-hui-textMuted space-y-1">
                <p>
                    Export hash — sha256 over BOTH CSVs (summary and detail), so a change to any single
                    entry shows up even when the rounded per-employee totals happen to match:{" "}
                    <code className="font-mono">{result.exportHash.slice(0, 16)}…</code>
                    {result.period?.exportHash && (
                        <>
                            {" "}· stored at lock:{" "}
                            <code className="font-mono">{result.period.exportHash.slice(0, 16)}…</code>
                            {result.period.exportHash === result.exportHash ? (
                                <span className="text-green-700"> · matches</span>
                            ) : (
                                <span className="text-red-700"> · CHANGED since the lock</span>
                            )}
                        </>
                    )}
                </p>
                <p>
                    Paid hours already exclude the WA meal deduction. Gusto stays authoritative for pay — see section 4 of
                    docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md for the parallel-period runbook.
                </p>
            </div>
        </div>
    );
}
