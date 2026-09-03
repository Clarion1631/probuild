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
import { addDaysToKey, dayKeyInTimeZone, startOfDateInTimeZone } from "@/lib/tz-date";
import {
    isDayKey,
    lastFullPayPeriod,
    MAX_PAYROLL_RANGE_DAYS,
    payrollPeriodLength,
    validatePayrollRange,
} from "@/lib/payroll-config";
import {
    isLabelRowMissingError,
    isLockedSnapshotMissingError,
    isNonStaffOnPayrollError,
    loadGustoExport,
    type LoadedGustoExport,
} from "@/lib/gusto-export-db";
import { jobCostingOnlyEmployees, summaryCsvEmployees, sumEmployeeTotals } from "@/lib/gusto-export-core";
import PayrollLockControls from "./PayrollLockControls";

interface Props {
    searchParams: Promise<{ start?: string; end?: string }>;
}

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

    // Both RAW keys are validated as real calendar days BEFORE any arithmetic.
    // addDaysToKey happily accepts "2026-02-31" and rolls it forward, so adding
    // a day first turned an impossible date into a plausible-looking period
    // that nobody asked for.
    const startKey = isDayKey(params.start) ? params.start : fallback.startKey;
    // fallback.endKey is exclusive; the picker shows the inclusive last day.
    const lastDayKey =
        isDayKey(params.end) && params.end >= startKey ? params.end : addDaysToKey(fallback.endKey, -1);
    const endKeyExclusive = addDaysToKey(lastDayKey, 1);

    // The SAME validator the endpoint and the lock action use (shape, real
    // calendar day, positive length, 62-day cap) — the page must never render
    // totals for a range they would refuse.
    const range = validatePayrollRange(startKey, endKeyExclusive);
    if (!range.ok) {
        return (
            <div className="max-w-3xl mx-auto py-16 px-6 text-center space-y-3">
                <h1 className="text-xl font-bold text-hui-textMain">That period does not work</h1>
                <p className="text-sm text-hui-textMuted">{range.error}</p>
                <p className="text-xs text-hui-textMuted">A pay period can be at most {MAX_PAYROLL_RANGE_DAYS} days.</p>
                <Link href="/manager/payroll-export" className="hui-btn hui-btn-primary text-sm">
                    Back to the current period
                </Link>
            </div>
        );
    }

    const periodStart = startOfDateInTimeZone(startKey, timeZone);
    const periodEnd = startOfDateInTimeZone(endKeyExclusive, timeZone);

    // THE SAME `timeZone` periodStart/periodEnd were derived from, 30 lines up.
    // Passing it is what keeps the boundaries and the day/overtime
    // classification in ONE zone: the loader used to resolve the zone again for
    // itself, on a second connection at a second instant, so a zone change
    // landing in between rendered a period whose query window was built in one
    // zone and whose hours were classified in another.
    let result: LoadedGustoExport;
    try {
        result = await loadGustoExport(periodStart, periodEnd, {
            startKey,
            endKey: endKeyExclusive,
            timeZone,
        });
    } catch (error) {
        // A locked period whose frozen CSVs are not all there. There is nothing
        // safe to render: the numbers on this page are what a human approves,
        // and showing live ones next to a lock badge invites approving a file
        // that no longer exists. Refuse, and say how to fix it.
        if (isLabelRowMissingError(error)) {
            // A label row moved underneath this render. Nothing here is stable
            // enough to approve, and the fix is to look again.
            return (
                <div className="max-w-3xl mx-auto py-16 px-6 text-center space-y-3">
                    <h1 className="text-xl font-bold text-hui-textMain">This period changed while it was loading</h1>
                    <p className="text-sm text-hui-textMuted">{error.message}</p>
                    <Link href="/manager/payroll-export" className="hui-btn hui-btn-primary text-sm">
                        Try again
                    </Link>
                </div>
            );
        }
        if (isNonStaffOnPayrollError(error)) {
            // Same treatment as a broken lock: nothing on this page is safe to
            // render, because the numbers a human would approve are the numbers
            // that cannot be produced.
            return (
                <div className="max-w-3xl mx-auto py-16 px-6 text-center space-y-3">
                    <h1 className="text-xl font-bold text-hui-textMain">Somebody on this period is not an employee</h1>
                    <p className="text-sm text-hui-textMuted">{error.message}</p>
                    <Link href="/company/team-members" className="hui-btn hui-btn-primary text-sm">
                        Team Members
                    </Link>
                </div>
            );
        }
        if (isLockedSnapshotMissingError(error)) {
            return (
                <div className="max-w-3xl mx-auto py-16 px-6 text-center space-y-3">
                    <h1 className="text-xl font-bold text-hui-textMain">This locked period is missing its export</h1>
                    <p className="text-sm text-hui-textMuted">{error.message}</p>
                    <Link href="/manager/payroll-export" className="hui-btn hui-btn-primary text-sm">
                        Back to the current period
                    </Link>
                </div>
            );
        }
        throw error;
    }
    // Overlap, not exact match: an ad-hoc range that merely overlaps a locked
    // period has no row of its own, and the exact lookup used to call it
    // unlocked while half of it was frozen.
    const locked = result.locked;
    const exactLock = result.period?.lockedAt ? result.period : null;
    // Either reason disables the downloads; they are different problems.
    const overlapsLock = result.overlapsLockWithoutBeingIt;
    // A LOCKED period serves its snapshot, so live blockers are irrelevant to
    // the download: the file was frozen when it was locked and no longer
    // depends on what the entries look like now. Leaving it disabled meant a
    // locked period whose entries were later reopened could not be re-downloaded
    // at all — the one case where the snapshot exists precisely so it can be.
    const servesSnapshot = !!result.snapshot;
    const blocked = !servesSnapshot && (result.blocking.length > 0 || overlapsLock);
    const deferredCount = result.blocking.filter((row) => row.reason === "deferred").length;
    const unknownPayTypeCount = result.blocking.filter((row) => row.reason === "unknownPayType").length;

    const downloadHref = (format: "summary" | "detail") =>
        `/api/time-entries/export/gusto?periodStart=${startKey}&periodEnd=${endKeyExclusive}&format=${format}`;

    // THE NUMBERS BEING APPROVED. Totalled over the rows the summary CSV
    // actually contains — through the same selector toSummaryCsv uses — because
    // that CSV is the file being locked. Summing every row instead (salaried
    // staff included, whose hours are carried for job costing and deliberately
    // left out of the file) put bigger hours and a bigger head count on screen
    // than the file underneath them.
    const payrollEmployees = summaryCsvEmployees(result.employees);
    const totals = sumEmployeeTotals(payrollEmployees);
    // The complement, shown SEPARATELY and labelled — the hours are real and a
    // reviewer wants to see them, they just are not on Gusto's file.
    const jobCostingOnly = jobCostingOnlyEmployees(result.employees);
    const jobCostingTotals = sumEmployeeTotals(jobCostingOnly);

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
                {locked && (
                    <span className="ml-auto text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
                        {exactLock ? (
                            <>
                                🔒 Locked {new Date(exactLock.lockedAt as Date).toLocaleDateString()} by{" "}
                                {exactLock.lockedBy?.name || exactLock.lockedBy?.email || "someone"}
                            </>
                        ) : (
                            <>
                                🔒 Overlaps a locked period (
                                {result.overlappingLocks
                                    .map((row) => dayKeyInTimeZone(row.periodStart, timeZone))
                                    .join(", ")}
                                ) — pick that exact period to work with it
                            </>
                        )}
                    </span>
                )}
            </form>

            {overlapsLock && (
                <div className="hui-card p-5 border-amber-300 bg-amber-50/40">
                    <h2 className="text-base font-semibold text-hui-textMain mb-2">
                        This range overlaps a locked pay period
                    </h2>
                    <p className="text-sm text-hui-textMuted">
                        {result.overlappingLocks
                            .map((row) => `${row.periodStartKey} to ${row.periodEndKey}`)
                            .join(", ")}{" "}
                        {result.overlappingLocks.length === 1 ? "is" : "are"} already locked. A range that only partly
                        covers a locked period has no frozen export of its own, so any CSV built for it would disagree
                        with what payroll was already paid. Pick the locked period itself to see or download it.
                    </p>
                </div>
            )}

            {result.blocking.length > 0 && (
                <div className="hui-card p-5 border-red-300 bg-red-50/40">
                    <h2 className="text-base font-semibold text-hui-textMain mb-2">
                        {result.blocking.length} entr{result.blocking.length === 1 ? "y is" : "ies are"} not ready to export
                    </h2>
                    <p className="text-sm text-hui-textMuted mb-3">
                        Payroll will not export a period that still has an open punch, a flagged entry, a closed
                        entry with no hours, a meal break that never settled, or somebody whose pay type nobody has
                        set. Clear these on{" "}
                        <Link href="/manager/time-entries?flagged=1" className="underline">Time &amp; Expenses</Link>, and
                        set pay types on{" "}
                        <Link href="/company/team-members" className="underline">Team Members</Link>.
                    </p>
                    {/* The one action that can clear a whole class of these. It
                        used to run implicitly on every page render and every GET;
                        now a human asks for it. */}
                    {deferredCount > 0 && !locked && (
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                            <PayrollLockControls
                                startKey={startKey}
                                endKeyExclusive={endKeyExclusive}
                                reviewedExportHash={result.exportHash}
                                locked={false}
                                canUnlock={false}
                                lockedAtIso={null}
                                blocked
                                deferredCount={deferredCount}
                            />
                            <span className="text-xs text-hui-textMuted">
                                Applies the WA meal deduction to days that closed mid-shift. Skips today, anyone still
                                clocked in, and locked periods.
                            </span>
                        </div>
                    )}
                    {unknownPayTypeCount > 0 && (
                        <p className="text-sm text-red-800 mb-3">
                            {unknownPayTypeCount} {unknownPayTypeCount === 1 ? "person has" : "people have"} no pay type
                            set. Gusto pays salaried staff a salary and hourly staff by the hour — guessing either way
                            is a wrong paycheque, so set it on{" "}
                            <Link
                                href={`/company/team-members?periodStart=${startKey}&periodEnd=${endKeyExclusive}`}
                                className="underline font-medium"
                            >
                                Team Members
                            </Link>{" "}
                            before exporting.
                        </p>
                    )}
                    <ul className="text-sm divide-y divide-hui-border">
                        {result.blocking.slice(0, 25).map((row) => (
                            <li key={row.id} className="py-1.5 flex justify-between gap-4">
                                {row.reason === "unknownPayType" ? (
                                    // Straight to THIS person's pay-type field, with the
                                    // period carried across — the page has to load the
                                    // former employees who have hours in it, and a
                                    // disabled account is not in the default list.
                                    <Link
                                        href={`/company/team-members?periodStart=${startKey}&periodEnd=${endKeyExclusive}#pay-type-${row.userId}`}
                                        className="font-medium text-hui-textMain underline"
                                    >
                                        {row.userLabel}
                                    </Link>
                                ) : (
                                    <span className="font-medium text-hui-textMain">{row.userLabel}</span>
                                )}
                                <span className="text-hui-textMuted">
                                    {new Date(row.startTime).toLocaleString()} ·{" "}
                                    {row.reason === "open"
                                        ? "still clocked in"
                                        : row.reason === "needsReview"
                                          ? "needs review"
                                          : row.reason === "zeroDuration"
                                            ? "closed with no hours"
                                            : row.reason === "unknownPayType"
                                              ? "no pay type set"
                                              : "meal break not settled"}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="space-y-2">
            <p className="text-xs font-medium text-hui-textMuted">
                On the summary CSV — the file Gusto imports. Salaried staff are not on it.
            </p>
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
                    <div className="text-3xl font-bold text-hui-textMain tabular-nums">{totals.people}</div>
                </div>
            </div>
            {jobCostingOnly.length > 0 && (
                <p className="text-xs text-hui-textMuted">
                    Plus {jobCostingTotals.people} salaried{" "}
                    {jobCostingTotals.people === 1 ? "person" : "people"} with{" "}
                    <span className="tabular-nums font-medium">{jobCostingTotals.total.toFixed(2)}</span> hours in the
                    table below. Those hours are in the DETAIL CSV for job costing and are deliberately absent from the
                    summary CSV — Gusto pays them a salary, so exporting their hours would pay them twice.
                </p>
            )}
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
                        {/* A client component so the action's REFUSALS are shown.
                            Inline server-action forms discard the return value, so
                            "already locked" and "the numbers moved" were computed
                            and then thrown away. It also carries the hash this page
                            rendered, which is what binds the lock to the numbers a
                            human actually reviewed. */}
                        {locked && !exactLock ? (
                            <span className="text-xs text-hui-textMuted">
                                Select the locked period itself to unlock it
                            </span>
                        ) : (
                            <PayrollLockControls
                                startKey={startKey}
                                endKeyExclusive={endKeyExclusive}
                                reviewedExportHash={result.exportHash}
                                locked={locked}
                                canUnlock={viewer?.role === "ADMIN" && !!exactLock}
                                // The lock AS RENDERED. Sent back with the unlock so a
                                // stale page cannot drop a different lock's snapshot.
                                lockedAtIso={exactLock?.lockedAt ? new Date(exactLock.lockedAt).toISOString() : null}
                                blocked={blocked}
                                deferredCount={0}
                            />
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
                    entry shows up even when the rounded per-employee totals happen to match. Live now:{" "}
                    <code className="font-mono">{result.exportHash.slice(0, 16)}…</code>
                    {result.snapshot && (
                        <>
                            {" "}· frozen at lock:{" "}
                            <code className="font-mono">{result.snapshot.exportHash.slice(0, 16)}…</code>
                            {result.snapshot.exportHash === result.exportHash ? (
                                <span className="text-green-700"> · the live data still matches</span>
                            ) : (
                                <span className="text-amber-800">
                                    {" "}· the live data has moved since the lock. Downloads still serve the frozen
                                    file that went to payroll.
                                </span>
                            )}
                        </>
                    )}
                </p>
                {result.snapshot && (
                    <p>
                        This period is locked, so both downloads serve the CSVs exactly as they were when it was
                        locked. They are not recomputed — a name, pay type, Gusto ID or cost-code change afterwards
                        cannot rewrite the file that was already sent.
                    </p>
                )}
                <p>
                    Locking freezes {dayKeyInTimeZone(result.envelopeStart, timeZone)} to{" "}
                    {addDaysToKey(dayKeyInTimeZone(result.envelopeEnd, timeZone), -1)} — the whole workweeks this period
                    touches, because overtime is worked out per week and a punch just outside the period still changes
                    what was paid inside it.
                </p>
                <p>
                    Paid hours already exclude the WA meal deduction. Gusto stays authoritative for pay — see section 4 of
                    docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md for the parallel-period runbook.
                </p>
            </div>
        </div>
    );
}
