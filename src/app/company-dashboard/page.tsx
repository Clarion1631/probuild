export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, hasPermission } from "@/lib/permissions";
import { getCompanyDashboardData } from "@/lib/schedule-core";
import CompanyDashboardClient from "./CompanyDashboardClient";

// Company-wide pipeline dashboard (PB-pipeline-001 + PB-pipeline-002):
// funnel, start calendar with crew + money/hours overlays, waiting-to-start
// editor, crew conflicts, and the ADMIN-only cashflow/per-project strips.
//
// Authorization: the page admits anyone holding `financialReports` or
// `schedules` (hasPermission honors explicit per-user overrides, so nav and
// page can never disagree). Overlays and per-project
// financial data are only QUERIED and serialized when role === "ADMIN"
// (enforced inside getCompanyDashboardData); editing is ADMIN/MANAGER only.
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
    if (!effectiveUser || (!hasPermission(effectiveUser, "financialReports") && !hasPermission(effectiveUser, "schedules"))) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

    // Month navigation is URL-driven (?month=YYYY-MM) so every navigation is a
    // server re-fetch; anything unparseable falls back to the current month.
    const params = await searchParams;
    const rawMonth = typeof params.month === "string" ? params.month : "";
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : currentMonth;

    const data = await getCompanyDashboardData(
        { role: effectiveUser.role, canSeeFinancials: hasPermission(effectiveUser, "financialReports") },
        month,
    );
    return <CompanyDashboardClient data={data} />;
}
