import { prisma } from "@/lib/prisma";
import {
    formatLocalDateString,
    defaultMonthRange,
    parseDateParam,
    parseDateParamEod,
    type SearchParamMap,
    getParam,
} from "./report-utils";

export type PayoutsType = "expense" | "po" | "both";

export type PayoutsFilters = {
    from: Date;
    to: Date;
    projectId: string | null;
    type: PayoutsType;
};

export function parsePayoutsFilters(params: SearchParamMap): PayoutsFilters {
    const { from: defaultFrom, to: defaultTo } = defaultMonthRange();
    const rawType = getParam(params, "type") ?? "both";
    const type: PayoutsType = rawType === "expense" ? "expense" : rawType === "po" ? "po" : "both";
    return {
        from: parseDateParam(getParam(params, "from"), defaultFrom),
        to: parseDateParamEod(getParam(params, "to"), defaultTo),
        projectId: getParam(params, "projectId") || null,
        type,
    };
}

export function stringifyPayoutsFilters(f: Partial<PayoutsFilters>): string {
    const sp = new URLSearchParams();
    if (f.from) sp.set("from", formatLocalDateString(f.from));
    if (f.to) sp.set("to", formatLocalDateString(f.to));
    if (f.projectId) sp.set("projectId", f.projectId);
    if (f.type && f.type !== "both") sp.set("type", f.type);
    return sp.toString();
}

export type PayoutRow = {
    id: string;
    date: Date;
    vendorName: string;
    type: "Expense" | "Purchase Order";
    amount: number;
    projectName: string;
    projectId: string | null;
    reference: string | null;
};

export async function queryPayoutsData(filters: PayoutsFilters): Promise<{
    rows: PayoutRow[];
    summary: { total: number; expenses: number; pos: number };
}> {
    const [expenses, purchaseOrders] = await Promise.all([
        filters.type !== "po"
            ? prisma.expense.findMany({
                where: {
                    OR: [
                        { date: { gte: filters.from, lte: filters.to } },
                        { AND: [{ date: null }, { createdAt: { gte: filters.from, lte: filters.to } }] },
                    ],
                    // Expense → Project via estimate.projectId
                    ...(filters.projectId ? { estimate: { projectId: filters.projectId } } : {}),
                },
                include: {
                    estimate: { select: { project: { select: { id: true, name: true } } } },
                    purchaseOrder: { select: { code: true } },
                },
                orderBy: { date: "desc" },
            })
            : Promise.resolve([]),

        filters.type !== "expense"
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

    const rows: PayoutRow[] = [];

    for (const exp of expenses) {
        rows.push({
            id: `exp-${exp.id}`,
            date: exp.date ?? exp.createdAt,
            vendorName: exp.vendor ?? "Unknown Vendor",
            type: "Expense",
            amount: Number(exp.amount),
            projectName: exp.estimate.project?.name ?? "No Project",
            projectId: exp.estimate.project?.id ?? null,
            reference: exp.purchaseOrder?.code ?? null,
        });
    }

    for (const po of purchaseOrders) {
        rows.push({
            id: `po-${po.id}`,
            date: po.sentAt ?? po.createdAt,
            vendorName: po.vendor.name,
            type: "Purchase Order",
            amount: Number(po.totalAmount),
            projectName: po.project.name,
            projectId: po.project.id,
            reference: po.code,
        });
    }

    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const total = rows.reduce((s, r) => s + r.amount, 0);
    const expensesTotal = rows.filter(r => r.type === "Expense").reduce((s, r) => s + r.amount, 0);
    const posTotal = rows.filter(r => r.type === "Purchase Order").reduce((s, r) => s + r.amount, 0);

    return { rows, summary: { total, expenses: expensesTotal, pos: posTotal } };
}
