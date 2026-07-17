export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import TimeBillingClient from "./TimeBillingClient";
import { parseTimeBillingFilters, queryTimeBillingData } from "@/lib/time-billing-report";
import { formatLocalDateString } from "@/lib/report-utils";

export default async function TimeBillingPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const params = await searchParams;
    const filters = parseTimeBillingFilters(params);

    const [rawEntries, users, projects] = await Promise.all([
        queryTimeBillingData(filters),
        prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    return (
        <TimeBillingClient
            entries={rawEntries.map(entry => ({
                ...entry,
                durationHours: entry.durationHours === null ? null : Number(entry.durationHours),
                laborCost: entry.laborCost === null ? null : toNum(entry.laborCost),
                burdenCost: entry.burdenCost === null ? null : Number(entry.burdenCost),
            }))}
            groupBy={filters.groupBy}
            filterFrom={formatLocalDateString(filters.from)}
            filterTo={formatLocalDateString(filters.to)}
            filterUserId={filters.userId ?? ""}
            filterProjectId={filters.projectId ?? ""}
            users={users}
            projects={projects}
        />
    );
}
