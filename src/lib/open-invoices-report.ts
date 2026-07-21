import { prisma } from "@/lib/prisma";
import { type SearchParamMap, getParam, getAllParams } from "./report-utils";
import { displayInvoiceStatus } from "./invoice-lifecycle";

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
    const requestedStatuses = filters.statuses.length ? filters.statuses : ALL_STATUSES;
    const persistedStatuses = requestedStatuses.filter(status => status !== "Overdue");
    if (requestedStatuses.includes("Overdue")) persistedStatuses.push("Issued", "Partially Paid");
    const invoices = await prisma.invoice.findMany({
        where: {
            status: { in: [...new Set(persistedStatuses)] },
            ...(filters.clientId ? { clientId: filters.clientId } : {}),
            ...(filters.projectId ? { projectId: filters.projectId } : {}),
        },
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
            payments: { select: { dueDate: true, status: true } },
        },
        orderBy: { issueDate: "asc" },
    });
    return invoices
        .map(invoice => ({
            ...invoice,
            status: displayInvoiceStatus({ status: invoice.status, payments: invoice.payments }),
        }))
        .filter(invoice => requestedStatuses.includes(invoice.status));
}
