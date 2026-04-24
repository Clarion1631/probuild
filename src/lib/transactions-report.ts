import { prisma } from "@/lib/prisma";
import {
    formatLocalDateString,
    defaultMonthRange,
    parseDateParam,
    parseDateParamEod,
    type SearchParamMap,
    getParam,
} from "./report-utils";

export type TransactionType = "income" | "expense" | "both";

export type TransactionsFilters = {
    from: Date;
    to: Date;
    projectId: string | null;
    type: TransactionType;
    tab: "all" | "project";
};

export function parseTransactionsFilters(params: SearchParamMap): TransactionsFilters {
    const { from: defaultFrom, to: defaultTo } = defaultMonthRange();
    const rawType = getParam(params, "type") ?? "both";
    const type: TransactionType = rawType === "income" ? "income" : rawType === "expense" ? "expense" : "both";
    const rawTab = getParam(params, "tab") ?? "all";
    const tab: "all" | "project" = rawTab === "project" ? "project" : "all";
    return {
        from: parseDateParam(getParam(params, "from"), defaultFrom),
        to: parseDateParamEod(getParam(params, "to"), defaultTo),
        projectId: getParam(params, "projectId") || null,
        type,
        tab,
    };
}

export function stringifyTransactionsFilters(f: Partial<TransactionsFilters>): string {
    const sp = new URLSearchParams();
    if (f.from) sp.set("from", formatLocalDateString(f.from));
    if (f.to) sp.set("to", formatLocalDateString(f.to));
    if (f.projectId) sp.set("projectId", f.projectId);
    if (f.type && f.type !== "both") sp.set("type", f.type);
    if (f.tab && f.tab !== "all") sp.set("tab", f.tab);
    return sp.toString();
}

export type TransactionRow = {
    id: string;
    date: Date;
    description: string;
    type: "Income" | "Expense";
    amount: number;
    projectName: string;
    projectId: string | null;
    category: string;
};

export async function queryTransactionsData(filters: TransactionsFilters): Promise<{
    rows: TransactionRow[];
    summary: { incoming: number; outgoing: number; net: number; count: number };
}> {
    const [paidPayments, expenses, purchaseOrders] = await Promise.all([
        filters.type !== "expense"
            ? prisma.paymentSchedule.findMany({
                where: {
                    status: "Paid",
                    OR: [
                        { paidAt: { gte: filters.from, lte: filters.to } },
                        { AND: [{ paidAt: null }, { paymentDate: { gte: filters.from, lte: filters.to } }] },
                    ],
                    ...(filters.projectId ? { invoice: { projectId: filters.projectId } } : {}),
                },
                include: {
                    invoice: {
                        select: {
                            id: true, code: true,
                            project: { select: { id: true, name: true } },
                        },
                    },
                },
                orderBy: { paidAt: "desc" },
            })
            : Promise.resolve([]),

        filters.type !== "income"
            ? prisma.expense.findMany({
                where: {
                    OR: [
                        { date: { gte: filters.from, lte: filters.to } },
                        { AND: [{ date: null }, { createdAt: { gte: filters.from, lte: filters.to } }] },
                    ],
                    ...(filters.projectId ? { estimate: { projectId: filters.projectId } } : {}),
                },
                include: {
                    estimate: { select: { project: { select: { id: true, name: true } } } },
                },
                orderBy: { date: "desc" },
            })
            : Promise.resolve([]),

        filters.type !== "income"
            ? prisma.purchaseOrder.findMany({
                where: {
                    status: { in: ["Sent", "Received"] },
                    OR: [
                        { sentAt: { gte: filters.from, lte: filters.to } },
                        { AND: [{ sentAt: null }, { createdAt: { gte: filters.from, lte: filters.to } }] },
                    ],
                    ...(filters.projectId ? { projectId: filters.projectId } : {}),
                },
                include: {
                    project: { select: { id: true, name: true } },
                    vendor: { select: { name: true } },
                },
                orderBy: { createdAt: "desc" },
            })
            : Promise.resolve([]),
    ]);

    const rows: TransactionRow[] = [];

    for (const p of paidPayments) {
        rows.push({
            id: `pay-${p.id}`,
            date: p.paidAt ?? p.paymentDate ?? p.createdAt,
            description: `Payment: ${p.name} (${p.invoice.code})`,
            type: "Income",
            amount: Number(p.amount),
            projectName: p.invoice.project.name,
            projectId: p.invoice.project.id,
            category: "Invoice Payment",
        });
    }

    for (const exp of expenses) {
        rows.push({
            id: `exp-${exp.id}`,
            date: exp.date ?? exp.createdAt,
            description: exp.description ?? exp.vendor ?? "Expense",
            type: "Expense",
            amount: Number(exp.amount),
            projectName: exp.estimate.project?.name ?? "No Project",
            projectId: exp.estimate.project?.id ?? null,
            category: "Expense",
        });
    }

    for (const po of purchaseOrders) {
        rows.push({
            id: `po-${po.id}`,
            date: po.sentAt ?? po.createdAt,
            description: `PO ${po.code} — ${po.vendor.name}`,
            type: "Expense",
            amount: Number(po.totalAmount),
            projectName: po.project.name,
            projectId: po.project.id,
            category: "Purchase Order",
        });
    }

    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const incoming = rows.filter(r => r.type === "Income").reduce((s, r) => s + r.amount, 0);
    const outgoing = rows.filter(r => r.type === "Expense").reduce((s, r) => s + r.amount, 0);

    return { rows, summary: { incoming, outgoing, net: incoming - outgoing, count: rows.length } };
}
