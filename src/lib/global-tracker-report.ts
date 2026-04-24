import { prisma } from "@/lib/prisma";
import { type SearchParamMap, getParam, getAllParams } from "./report-utils";

const ALL_STATUSES = ["In Progress", "Closed", "Paid Ready to Start"];

export type GlobalTrackerFilters = {
    statuses: string[];
    clientId: string | null;
};

export function parseGlobalTrackerFilters(params: SearchParamMap): GlobalTrackerFilters {
    return {
        statuses: getAllParams(params, "status"),
        clientId: getParam(params, "clientId") || null,
    };
}

export function stringifyGlobalTrackerFilters(f: Partial<GlobalTrackerFilters>): string {
    const sp = new URLSearchParams();
    if (f.statuses) for (const s of f.statuses) sp.append("status", s);
    if (f.clientId) sp.set("clientId", f.clientId);
    return sp.toString();
}

export async function queryGlobalTrackerData(filters: GlobalTrackerFilters) {
    const activeStatuses = filters.statuses.length ? filters.statuses : ALL_STATUSES;
    return prisma.project.findMany({
        where: {
            status: { in: activeStatuses },
            ...(filters.clientId ? { clientId: filters.clientId } : {}),
        },
        orderBy: { createdAt: "desc" },
        include: {
            client: { select: { id: true, name: true } },
            estimates: { select: { totalAmount: true, status: true } },
            invoices: { select: { totalAmount: true, balanceDue: true, status: true } },
            scheduleTasks: { select: { id: true, status: true } },
            dailyLogs: { select: { createdAt: true } },
            changeOrders: { select: { createdAt: true } },
        },
    });
}
