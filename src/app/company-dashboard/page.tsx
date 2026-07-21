export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, hasPermission } from "@/lib/permissions";
import { getCompanyPipeline, getStartCalendar, getCashflowOutlook } from "@/lib/schedule-core";
import { getMonthGrid, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import CompanyDashboardClient from "./CompanyDashboardClient";

// Company-wide pipeline dashboard (.specs/PB-pipeline-001-company-dashboard.md):
// funnel (Estimating → Waiting to Start → Scheduled → In Progress), the
// month-grid start calendar, the waiting-to-start editor (ADMIN/MANAGER), and
// the ADMIN-only cashflow strip.
//
// Authorization: the page admits anyone holding the `financialReports`
// permission (hasPermission — honors explicit per-user overrides, so nav and
// page can never disagree). Milestone amounts and the cashflow strip are only
// QUERIED and serialized when role === "ADMIN" — managers/finance never
// receive financial data in the payload (owner requirement).
export default async function CompanyDashboardPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user?.email) return redirect("/login");

    const user = await getUserWithPermissionsByEmail(session.user.email);
    // Dev sessions can exist without a matching User row (same passthrough the
    // reports pages use); production always has the row.
    const effectiveUser = user ?? (process.env.NODE_ENV === "development" ? { role: "ADMIN", permissions: null } : null);
    if (!effectiveUser || !hasPermission(effectiveUser, "financialReports")) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    const role = effectiveUser.role;
    const isAdmin = role === "ADMIN";
    const canEdit = role === "ADMIN" || role === "MANAGER";

    // Month navigation is URL-driven (?month=YYYY-MM) so every navigation is a
    // server re-fetch; anything unparseable falls back to the current month.
    const params = await searchParams;
    const rawMonth = typeof params.month === "string" ? params.month : "";
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : currentMonth;

    // Fetch the whole 42-day grid (not just the month) so adjacent-month
    // spillover cells are populated. getStartCalendar's `to` is exclusive,
    // so pass the day after the grid's last date.
    const grid = getMonthGrid(parseUTCDate(`${month}-01`));
    const from = grid[0];
    const to = new Date(grid[grid.length - 1].getTime() + 86_400_000);

    const [pipeline, calendar, cashflow] = await Promise.all([
        getCompanyPipeline(),
        getStartCalendar(from, to, { includeFinancials: isAdmin }),
        isAdmin ? getCashflowOutlook() : Promise.resolve(null),
    ]);

    return (
        <CompanyDashboardClient
            pipeline={pipeline}
            calendar={calendar}
            cashflow={cashflow}
            month={month}
            canEdit={canEdit}
        />
    );
}
