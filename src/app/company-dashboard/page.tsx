export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { loadCompanyDashboardData } from "./load-dashboard-data";
import CompanyDashboardClient from "./CompanyDashboardClient";

// Company-wide pipeline dashboard (PB-pipeline-001 + PB-pipeline-002):
// funnel, start calendar with crew + money/hours overlays, waiting-to-start
// editor, crew conflicts, and the ADMIN-only cashflow/per-project strips.
//
// Auth/permission gating and data loading live in load-dashboard-data.ts,
// shared with /company-dashboard/dispatch so the two routes can never
// disagree on who gets in.
export default async function CompanyDashboardPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    // Month navigation is URL-driven (?month=YYYY-MM) so every navigation is a
    // server re-fetch; anything unparseable falls back to the current month.
    const params = await searchParams;
    const rawMonth = typeof params.month === "string" ? params.month : "";

    const result = await loadCompanyDashboardData(rawMonth);
    if (!result.ok) {
        if (result.reason === "unauthenticated") return redirect("/login");
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    return <CompanyDashboardClient data={result.data} weather={result.weather} />;
}
