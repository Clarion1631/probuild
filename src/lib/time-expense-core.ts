import { prisma } from "./prisma";

const cents = (value: number) => Math.round(value * 100);
const dollars = (value: number) => cents(value) / 100;

export function findCrewMatches<T extends { name: string | null; email: string }>(crew: T[], query: string): T[] {
    const needle = query.trim().toLocaleLowerCase();
    return crew.filter((member) => (member.name || member.email).toLocaleLowerCase().includes(needle));
}

export function calculateCrewTimeCosts(
    hours: number,
    hourlyRate: number,
    burdenRate: number,
    burdenCostOverride?: number,
) {
    requiredPositive(hours, "Hours");
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) throw new Error("Hourly rate cannot be negative");
    if (!Number.isFinite(burdenRate) || burdenRate < 0) throw new Error("Burden rate cannot be negative");
    if (burdenCostOverride != null && (!Number.isFinite(burdenCostOverride) || burdenCostOverride < 0)) {
        throw new Error("Burden cost cannot be negative");
    }
    return {
        laborCost: dollars(hours * hourlyRate),
        burdenCost: dollars(burdenCostOverride ?? hours * burdenRate),
    };
}

function requiredPositive(value: number, label: string) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
}

async function resolveChangeOrder(changeOrderId: string, projectId?: string) {
    const changeOrder = await prisma.changeOrder.findUnique({
        where: { id: changeOrderId },
        select: { id: true, projectId: true, estimateId: true, pricingType: true, status: true, code: true },
    });
    if (!changeOrder) throw new Error("Change order not found");
    if (projectId && changeOrder.projectId !== projectId) throw new Error("Change order does not belong to this project");
    if (changeOrder.pricingType !== "COST_PLUS") throw new Error(`${changeOrder.code} is not a cost-plus change order`);
    if (!['Sent', 'Approved'].includes(changeOrder.status)) {
        throw new Error(`${changeOrder.code} must be Sent or Approved before actuals can be tagged`);
    }
    return changeOrder;
}

export type CreateTimeEntryCoreInput = {
    projectId?: string;
    userId: string;
    costCodeId?: string | null;
    date: string;
    durationHours: number;
    laborCost: number;
    burdenCost?: number;
    changeOrderId?: string | null;
    isBillable?: boolean;
    notes?: string | null;
};

export async function createTimeEntryCore(data: CreateTimeEntryCoreInput, actor: string) {
    void actor;
    requiredPositive(data.durationHours, "Hours");
    if (!Number.isFinite(data.laborCost) || data.laborCost < 0) throw new Error("Labor cost cannot be negative");
    if (data.burdenCost != null && (!Number.isFinite(data.burdenCost) || data.burdenCost < 0)) {
        throw new Error("Burden cost cannot be negative");
    }
    const startTime = new Date(data.date);
    if (Number.isNaN(startTime.getTime())) throw new Error("A valid time-entry date is required");

    const changeOrder = data.changeOrderId ? await resolveChangeOrder(data.changeOrderId, data.projectId) : null;
    const projectId = changeOrder?.projectId ?? data.projectId;
    if (!projectId) throw new Error("projectId or changeOrderId is required");
    const [project, user] = await Promise.all([
        prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }),
        prisma.user.findUnique({ where: { id: data.userId }, select: { id: true } }),
    ]);
    if (!project) throw new Error("Project not found");
    if (!user) throw new Error("Crew member not found");

    return prisma.timeEntry.create({
        data: {
            projectId,
            userId: data.userId,
            costCodeId: data.costCodeId || null,
            startTime,
            durationHours: data.durationHours,
            laborCost: dollars(data.laborCost),
            burdenCost: dollars(data.burdenCost ?? 0),
            changeOrderId: changeOrder?.id ?? null,
            isBillable: data.isBillable ?? false,
            notes: data.notes?.trim() || null,
        },
    });
}

export type CreateExpenseCoreInput = {
    projectId?: string;
    estimateId?: string;
    itemId?: string | null;
    costCodeId?: string | null;
    costTypeId?: string | null;
    amount: number;
    vendor?: string | null;
    date?: string | null;
    description?: string | null;
    receiptUrl?: string | null;
    receiptFileId?: string | null;
    changeOrderId?: string | null;
    isBillable?: boolean;
};

export async function createExpenseCore(data: CreateExpenseCoreInput, actor: string) {
    void actor;
    requiredPositive(data.amount, "Expense amount");
    const changeOrder = data.changeOrderId ? await resolveChangeOrder(data.changeOrderId, data.projectId) : null;
    const estimateId = changeOrder?.estimateId ?? data.estimateId;
    if (!estimateId) throw new Error("estimateId or changeOrderId is required");
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        select: { id: true, projectId: true },
    });
    if (!estimate?.projectId) throw new Error("Estimate must belong to a project");
    if (data.projectId && estimate.projectId !== data.projectId) throw new Error("Estimate does not belong to this project");
    if (changeOrder && estimate.projectId !== changeOrder.projectId) throw new Error("Change order and estimate project do not match");

    let receiptUrl = data.receiptUrl?.trim() || null;
    if (data.receiptFileId) {
        const receipt = await prisma.projectFile.findUnique({
            where: { id: data.receiptFileId },
            select: { projectId: true, url: true },
        });
        if (!receipt || receipt.projectId !== estimate.projectId) {
            throw new Error("Receipt file must belong to the same project as the change order");
        }
        receiptUrl = receipt.url;
    }
    const expenseDate = data.date ? new Date(data.date) : null;
    if (expenseDate && Number.isNaN(expenseDate.getTime())) throw new Error("A valid expense date is required");

    return prisma.expense.create({
        data: {
            estimateId,
            itemId: data.itemId || null,
            costCodeId: data.costCodeId || null,
            costTypeId: data.costTypeId || null,
            amount: dollars(data.amount),
            vendor: data.vendor?.trim() || null,
            date: expenseDate,
            description: data.description?.trim() || null,
            receiptUrl,
            changeOrderId: changeOrder?.id ?? null,
            isBillable: data.isBillable ?? Boolean(changeOrder),
        },
    });
}

export async function tagTimeEntriesToChangeOrderCore(
    input: { ids: string[]; changeOrderId: string; isBillable?: boolean },
    actor: string,
) {
    void actor;
    if (!input.ids.length) return { updated: 0 };
    const changeOrder = await resolveChangeOrder(input.changeOrderId);
    const rows = await prisma.timeEntry.findMany({
        where: { id: { in: input.ids } },
        select: { id: true, projectId: true, invoiceId: true, invoicedAt: true },
    });
    if (rows.length !== new Set(input.ids).size) throw new Error("One or more time entries were not found");
    if (rows.some((row) => row.projectId !== changeOrder.projectId)) throw new Error("All time entries must belong to the change order project");
    if (rows.some((row) => row.invoiceId || row.invoicedAt)) throw new Error("Billed time entries cannot be retagged");
    const result = await prisma.timeEntry.updateMany({
        where: { id: { in: input.ids }, invoiceId: null, invoicedAt: null },
        data: { changeOrderId: input.changeOrderId, isBillable: input.isBillable ?? true },
    });
    return { updated: result.count };
}

export async function tagExpensesToChangeOrderCore(
    input: { ids: string[]; changeOrderId: string; isBillable?: boolean },
    actor: string,
) {
    void actor;
    if (!input.ids.length) return { updated: 0 };
    const changeOrder = await resolveChangeOrder(input.changeOrderId);
    const rows = await prisma.expense.findMany({
        where: { id: { in: input.ids } },
        select: { id: true, estimate: { select: { projectId: true } }, invoiceId: true, invoicedAt: true },
    });
    if (rows.length !== new Set(input.ids).size) throw new Error("One or more expenses were not found");
    if (rows.some((row) => row.estimate.projectId !== changeOrder.projectId)) throw new Error("All expenses must belong to the change order project");
    if (rows.some((row) => row.invoiceId || row.invoicedAt)) throw new Error("Billed expenses cannot be retagged");
    const result = await prisma.expense.updateMany({
        where: { id: { in: input.ids }, invoiceId: null, invoicedAt: null },
        data: { changeOrderId: input.changeOrderId, isBillable: input.isBillable ?? true },
    });
    return { updated: result.count };
}
