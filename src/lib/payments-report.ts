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
    invoiceCode: string;
    invoiceId: string;
    projectName: string;
    projectId: string;
    clientName: string;
    paymentMethod: string | null;
    amount: number;
};

export async function queryPaymentsData(filters: PaymentsFilters): Promise<{
    rows: PaymentRow[];
    summary: { total: number; count: number; avg: number };
}> {
    const payments = await prisma.paymentSchedule.findMany({
        where: {
            status: "Paid",
            OR: [
                { paidAt: { gte: filters.from, lte: filters.to } },
                { AND: [{ paidAt: null }, { paymentDate: { gte: filters.from, lte: filters.to } }] },
            ],
            ...(filters.methods.length ? { paymentMethod: { in: filters.methods } } : {}),
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
        orderBy: { paidAt: "desc" },
    });

    const rows: PaymentRow[] = payments.map(p => ({
        id: p.id,
        date: p.paidAt ?? p.paymentDate ?? p.createdAt,
        name: p.name,
        invoiceCode: p.invoice.code,
        invoiceId: p.invoice.id,
        projectName: p.invoice.project.name,
        projectId: p.invoice.project.id,
        clientName: p.invoice.client.name,
        paymentMethod: p.paymentMethod,
        amount: Number(p.amount),
    }));

    const total = rows.reduce((s, r) => s + r.amount, 0);
    return {
        rows,
        summary: { total, count: rows.length, avg: rows.length > 0 ? total / rows.length : 0 },
    };
}
