import { prisma } from "@/lib/prisma";
import {
    formatLocalDateString,
    defaultMonthRange,
    parseDateParam,
    parseDateParamEod,
    type SearchParamMap,
    getParam,
    getAllParams,
} from "./report-utils";

export type PaymentsFilters = {
    from: Date;
    to: Date;
    clientId: string | null;
    projectId: string | null;
    methods: string[];
};

export function parsePaymentsFilters(params: SearchParamMap): PaymentsFilters {
    const { from: defaultFrom, to: defaultTo } = defaultMonthRange();
    return {
        from: parseDateParam(getParam(params, "from"), defaultFrom),
        to: parseDateParamEod(getParam(params, "to"), defaultTo),
        clientId: getParam(params, "clientId") || null,
        projectId: getParam(params, "projectId") || null,
        methods: getAllParams(params, "method"),
    };
}

export function stringifyPaymentsFilters(f: Partial<PaymentsFilters>): string {
    const sp = new URLSearchParams();
    if (f.from) sp.set("from", formatLocalDateString(f.from));
    if (f.to) sp.set("to", formatLocalDateString(f.to));
    if (f.clientId) sp.set("clientId", f.clientId);
    if (f.projectId) sp.set("projectId", f.projectId);
    if (f.methods) for (const m of f.methods) sp.append("method", m);
    return sp.toString();
}

export type PaymentRow = {
    id: string;
    date: Date;
    name: string;
    documentCode: string;
    documentId: string;
    documentType: "invoice" | "estimate";
    projectName: string | null;
    projectId: string | null;
    clientName: string;
    paymentMethod: string | null;
    amount: number;
    href: string;
};

export async function queryPaymentsData(filters: PaymentsFilters): Promise<{
    rows: PaymentRow[];
    summary: { total: number; count: number; avg: number };
}> {
    const dateFilter = {
        OR: [
            { paidAt: { gte: filters.from, lt: filters.to } },
            { AND: [{ paidAt: null }, { paymentDate: { gte: filters.from, lt: filters.to } }] },
        ],
    };
    const methodFilter = filters.methods.length ? { paymentMethod: { in: filters.methods } } : {};

    const [invoicePayments, estimatePayments] = await Promise.all([
        prisma.paymentSchedule.findMany({
            where: {
                status: "Paid",
                ...dateFilter,
                ...methodFilter,
                invoice: {
                    ...(filters.clientId ? { clientId: filters.clientId } : {}),
                    ...(filters.projectId ? { projectId: filters.projectId } : {}),
                },
            },
            include: {
                invoice: {
                    select: {
                        id: true,
                        code: true,
                        project: { select: { id: true, name: true } },
                        client: { select: { id: true, name: true } },
                    },
                },
            },
        }),
        prisma.estimatePaymentSchedule.findMany({
            where: {
                status: "Paid",
                ...dateFilter,
                ...methodFilter,
                estimate: {
                    ...(filters.projectId ? { projectId: filters.projectId } : {}),
                    ...(filters.clientId ? {
                        OR: [
                            { project: { clientId: filters.clientId } },
                            { lead: { clientId: filters.clientId } },
                        ],
                    } : {}),
                },
            },
            include: {
                estimate: {
                    select: {
                        id: true,
                        code: true,
                        project: { select: { id: true, name: true, client: { select: { id: true, name: true } } } },
                        lead: { select: { id: true, name: true, client: { select: { id: true, name: true } } } },
                    },
                },
            },
        }),
    ]);

    const rows: PaymentRow[] = [];

    for (const p of invoicePayments) {
        rows.push({
            id: p.id,
            date: p.paidAt ?? p.paymentDate ?? p.createdAt,
            name: p.name,
            documentCode: p.invoice.code,
            documentId: p.invoice.id,
            documentType: "invoice",
            projectName: p.invoice.project.name,
            projectId: p.invoice.project.id,
            clientName: p.invoice.client.name,
            paymentMethod: p.paymentMethod,
            amount: Number(p.amount),
            href: `/projects/${p.invoice.project.id}/invoices/${p.invoice.id}`,
        });
    }

    for (const p of estimatePayments) {
        const est = p.estimate;
        rows.push({
            id: p.id,
            date: p.paidAt ?? p.paymentDate ?? p.createdAt,
            name: p.name,
            documentCode: est.code,
            documentId: est.id,
            documentType: "estimate",
            projectName: est.project?.name ?? null,
            projectId: est.project?.id ?? null,
            clientName: est.project?.client?.name ?? est.lead?.client?.name ?? est.lead?.name ?? "",
            paymentMethod: p.paymentMethod,
            amount: Number(p.amount),
            href: est.project?.id
                ? `/projects/${est.project.id}/estimates/${est.id}`
                : est.lead?.id ? `/leads/${est.lead.id}/estimates/${est.id}` : `/estimates`,
        });
    }

    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const total = rows.reduce((s, r) => s + r.amount, 0);
    return {
        rows,
        summary: { total, count: rows.length, avg: rows.length > 0 ? total / rows.length : 0 },
    };
}
