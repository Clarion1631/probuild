import { getSessionOrDev } from "@/lib/auth";
import { getUserWithPermissionsByEmail, hasPermission } from "@/lib/permissions";
import { getCompanyDashboardData, type CompanyDashboardData } from "@/lib/schedule-core";
import { getVancouverWeather, type VancouverForecastDay } from "@/lib/weather";

// Shared by / and /dispatch (page.tsx + dispatch/page.tsx) so both routes
// enforce the exact same auth/permission gating and data fetch — no
// duplicated authorization logic between them.
//
// Authorization: admits anyone holding `financialReports` or `schedules`
// (hasPermission honors explicit per-user overrides, so nav and page can
// never disagree). Overlays and per-project financial data are only QUERIED
// and serialized when role === "ADMIN" (enforced inside getCompanyDashboardData).
export async function loadCompanyDashboardData(
    rawMonth: string,
): Promise<
    | { ok: true; data: CompanyDashboardData; weather: VancouverForecastDay[] }
    | { ok: false; reason: "unauthenticated" }
    | { ok: false; reason: "forbidden" }
> {
    const session = await getSessionOrDev();
    if (!session?.user?.email) return { ok: false, reason: "unauthenticated" };

    const user = await getUserWithPermissionsByEmail(session.user.email);
    // Dev sessions can exist without a matching User row (same passthrough the
    // reports pages use); production always has the row.
    const effectiveUser = user ?? (process.env.NODE_ENV === "development" ? { role: "ADMIN", permissions: null } : null);
    if (!effectiveUser || (!hasPermission(effectiveUser, "financialReports") && !hasPermission(effectiveUser, "schedules"))) {
        return { ok: false, reason: "forbidden" };
    }

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : currentMonth;

    const [data, weather] = await Promise.all([
        getCompanyDashboardData(
            { role: effectiveUser.role, canSeeFinancials: hasPermission(effectiveUser, "financialReports") },
            month,
        ),
        getVancouverWeather(),
    ]);
    return { ok: true, data, weather: weather ?? [] };
}
