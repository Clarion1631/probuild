import { prisma } from "@/lib/prisma";
import {
    formatLocalDateString,
    defaultMonthRange,
    parseDateParam,
    parseDateParamEod,
    type SearchParamMap,
    getParam,
} from "./report-utils";

export type TimeBillingFilters = {
    from: Date;
    to: Date;
    userId: string | null;
    projectId: string | null;
    groupBy: "employee" | "project";
};

export function parseTimeBillingFilters(params: SearchParamMap): TimeBillingFilters {
    const { from: defaultFrom, to: defaultTo } = defaultMonthRange();
    const rawGroupBy = getParam(params, "groupBy") ?? "employee";
    return {
        from: parseDateParam(getParam(params, "from"), defaultFrom),
        to: parseDateParamEod(getParam(params, "to"), defaultTo),
        userId: getParam(params, "userId") || null,
        projectId: getParam(params, "projectId") || null,
        groupBy: rawGroupBy === "project" ? "project" : "employee",
    };
}

export function stringifyTimeBillingFilters(f: Partial<TimeBillingFilters>): string {
    const sp = new URLSearchParams();
    if (f.from) sp.set("from", formatLocalDateString(f.from));
    if (f.to) sp.set("to", formatLocalDateString(f.to));
    if (f.userId) sp.set("userId", f.userId);
    if (f.projectId) sp.set("projectId", f.projectId);
    if (f.groupBy) sp.set("groupBy", f.groupBy);
    return sp.toString();
}

export async function queryTimeBillingData(filters: TimeBillingFilters) {
    return prisma.timeEntry.findMany({
        where: {
            startTime: { gte: filters.from, lt: filters.to },
            ...(filters.userId ? { userId: filters.userId } : {}),
            ...(filters.projectId ? { projectId: filters.projectId } : {}),
        },
        include: {
            user: { select: { id: true, name: true } },
            project: { select: { id: true, name: true } },
            costCode: { select: { code: true, name: true } },
        },
        orderBy: { startTime: "desc" },
    });
}
