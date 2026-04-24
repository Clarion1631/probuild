import { prisma } from "@/lib/prisma";
import { type SearchParamMap, getParam, getAllParams } from "./report-utils";

export type OpenInvoicesFilters = {
    clientId: string | null;
    projectId: string | null;
    statuses: string[];
};

const ALL_STATUSES = ["Issued", "Overdue", "Partially Paid"];

export function parseOpenInvoicesFilters(params: SearchParamMap): OpenInvoicesFilters {
    return {
        clientId: getParam(params, "clientId") || null,
        projectId: getParam(params, "projectId") || null,
        statuses: getAllParams(params, "status"),
    };
}

export function stringifyOpenInvoicesFilters(f: Partial<OpenInvoicesFilters>): string {
    const sp = new URLSearchParams();
    if (f.clientId) sp.set("clientId", f.clientId);
    if (f.projectId) sp.set("projectId", f.projectId);
    if (f.statuses) for (const s of f.statuses) sp.append("status", s);
    return sp.toString();
}

export async function queryOpenInvoicesData(filters: OpenInvoicesFilters) {
    const activeStatuses = filters.statuses.length ? filters.statuses : ALL_STATUSES;
    return prisma.invoice.findMany({
        where: {
            status: { in: activeStatuses },
            ...(filters.clientId ? { clientId: filters.clientId } : {}),
            ...(filters.projectId ? { projectId: filters.projectId } : {}),
        },
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
        },
        orderBy: { issueDate: "asc" },
    });
}
