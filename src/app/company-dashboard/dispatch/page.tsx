export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { loadCompanyDashboardData } from "../load-dashboard-data";
import CompanyDashboardClient from "../CompanyDashboardClient";

// Full-screen dispatch focus mode — reuses the same auth/data loader as
// /company-dashboard (load-dashboard-data.ts) so authorization can never
// drift between the two routes, then renders only the schedule board's
// Dispatch view, filling the viewport.
export default async function CompanyDashboardDispatchPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const rawMonth = typeof params.month === "string" ? params.month : "";

    const result = await loadCompanyDashboardData(rawMonth);
    if (!result.ok) {
        if (result.reason === "unauthenticated") return redirect("/login");
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    return <CompanyDashboardClient data={result.data} weather={result.weather} focus="dispatch" />;
}
