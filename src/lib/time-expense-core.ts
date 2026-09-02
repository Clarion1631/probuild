import { prisma } from "./prisma";
import { dateOnlyInTimeZone, resolveCompanyTimeZone } from "./company-timezone";
import { resolveScheduleTaskIdForPunch } from "./punch-task-binding";
import { toCompanyDayKey } from "./company-day";
import { assertExpenseMutableOutsideQbo } from "./qbo-expense-guard";
import {
    appendZeroRateReview,
    readOwnerRatesForUpdate,
    zeroRateBlocks,
    zeroRateManagerMessage,
} from "./pay-rate-guard";
import { withPayrollWrite, withPayrollWriteTx } from "./payroll-period";

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
    /** Set by callers that detected something payroll must look at (e.g. a $0 rate). */
    needsReview?: boolean;
    reviewReason?: string | null;
    /**
     * Price this entry from the member's STORED rates, read FOR UPDATE inside
     * the write transaction, applying the $0-rate policy. When set, laborCost
     * and burdenCost on this input are ignored.
     */
    priceFromStoredRates?: boolean;
    /** Deliberate "book it at $0 and flag it for payroll" — never the default. */
    acknowledgeZeroRate?: boolean;
    projectId?: string;
    userId: string;
    costCodeId?: string | null;
    date: string;
    durationHours: number;
    /** Ignored when priceFromStoredRates is set — the core prices it instead. */
    laborCost?: number;
    burdenCost?: number;
    changeOrderId?: string | null;
    isBillable?: boolean;
    notes?: string | null;
};

export async function createTimeEntryCore(data: CreateTimeEntryCoreInput, actor: string) {
    void actor;
    requiredPositive(data.durationHours, "Hours");
    if (!data.priceFromStoredRates && (!Number.isFinite(data.laborCost) || (data.laborCost ?? 0) < 0)) {
        throw new Error("Labor cost cannot be negative");
    }
    if (data.burdenCost != null && (!Number.isFinite(data.burdenCost) || data.burdenCost < 0)) {
        throw new Error("Burden cost cannot be negative");
    }
    const startTime = /^\d{4}-\d{2}-\d{2}$/.test(data.date)
        ? dateOnlyInTimeZone(data.date, await resolveCompanyTimeZone())
        : new Date(data.date);
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

    // Bind the punch to the schedule task it belongs to. This is the canonical
    // create for manual time entry, so binding here covers every caller rather
    // than each server action separately. startTime is already a company-local
    // instant (date-only values are stored at local noon), so the day key is safe.
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: data.userId,
        projectId,
        dayKey: toCompanyDayKey(startTime),
        estimateItemId: null,
    });

    // The canonical manual-create. Creating hours AT a date puts them in that
    // period, so gating HERE covers every caller instead of each server action
    // separately. Check + write in one transaction under the shared advisory
    // lock (src/lib/payroll-period.ts).
    return withPayrollWriteTx({ instants: [startTime] }, async (tx) => {
        // Rates, the $0-rate decision and both costs, all from a row-locked read
        // in THIS transaction (src/lib/pay-rate-guard.ts). It is always an
        // office action — there is no worker-side manual create — so it follows
        // the manager branch: refused unless explicitly acknowledged, and then
        // flagged so the payroll export will not run past it.
        let priced: { laborCost: number; burdenCost: number; needsReview?: boolean; reviewReason?: string } | null = null;
        if (data.priceFromStoredRates) {
            const member = await readOwnerRatesForUpdate(tx, data.userId, (value) => Number(value));
            if (!member) throw new Error("Crew member not found");
            const zeroRate = zeroRateBlocks({
                role: member.role,
                email: member.email,
                payType: member.payType,
                hourlyRate: member.hourlyRate,
            });
            if (zeroRate && data.acknowledgeZeroRate !== true) {
                throw new Error(zeroRateManagerMessage(member.name));
            }
            const costs = calculateCrewTimeCosts(data.durationHours, member.hourlyRate, member.burdenRate);
            priced = { ...costs, ...(zeroRate ? appendZeroRateReview(null) : {}) };
        }

        return (tx as unknown as typeof prisma).timeEntry.create({
            data: {
                projectId,
                scheduleTaskId,
                userId: data.userId,
                costCodeId: data.costCodeId || null,
                startTime,
                // endTime stays NULL on a manual entry. durationHours IS the
                // paid time a human entered; synthesising a span would make WA
                // meal settlement read it as raw worked time, deduct a meal it
                // never owed, and reprice it at the current rate. Readers treat
                // "open" as endTime null AND durationHours null.
                durationHours: data.durationHours,
                laborCost: dollars(priced ? priced.laborCost : data.laborCost ?? 0),
                burdenCost: dollars(priced ? priced.burdenCost : data.burdenCost ?? 0),
                changeOrderId: changeOrder?.id ?? null,
                isBillable: data.isBillable ?? false,
                notes: data.notes?.trim() || null,
                ...(priced?.needsReview || data.needsReview
                    ? {
                          needsReview: true,
                          reviewReason: priced?.reviewReason ?? data.reviewReason ?? null,
                      }
                    : {}),
            },
        });
    });
}

export type CreateTimeEntryFromStoredRatesInput = Omit<CreateTimeEntryCoreInput, "laborCost" | "burdenCost">;

export async function createTimeEntryFromStoredRatesCore(data: CreateTimeEntryFromStoredRatesInput, actor: string) {
    // Nothing is read here. The rates, the $0-rate decision and both costs are
    // all resolved INSIDE createTimeEntryCore's payroll write transaction, from
    // a row-locked read — reading them out here left a window in which a rate
    // import could land between the read and the insert, and the entry was then
    // created at a rate that was no longer true.
    return createTimeEntryCore({ ...data, priceFromStoredRates: true }, actor);
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

    if (data.itemId) {
        const item = await prisma.estimateItem.findUnique({
            where: { id: data.itemId },
            select: { estimateId: true },
        });
        if (!item || item.estimateId !== estimateId) {
            throw new Error("Line item must belong to the resolved estimate");
        }
    }

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
    const expenseDate = data.date
        ? /^\d{4}-\d{2}-\d{2}$/.test(data.date)
            ? dateOnlyInTimeZone(data.date, await resolveCompanyTimeZone())
            : new Date(data.date)
        : null;
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
    // Re-tagging changes which change order the hours are billed against, and
    // runs against rows a locked period may own — advisory-lock protocol.
    const result = await withPayrollWrite({ entryIds: input.ids }, async (tx) =>
        (tx as unknown as typeof prisma).timeEntry.updateMany({
            where: { id: { in: input.ids }, invoiceId: null, invoicedAt: null },
            data: { changeOrderId: input.changeOrderId, isBillable: input.isBillable ?? true },
        })
    );
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
        select: {
            id: true,
            qbPurchaseId: true,
            estimate: { select: { projectId: true } },
            invoiceId: true,
            invoicedAt: true,
        },
    });
    if (rows.length !== new Set(input.ids).size) throw new Error("One or more expenses were not found");
    if (rows.some((row) => row.estimate.projectId !== changeOrder.projectId)) throw new Error("All expenses must belong to the change order project");
    for (const row of rows) assertExpenseMutableOutsideQbo(row);
    if (rows.some((row) => row.invoiceId || row.invoicedAt)) throw new Error("Billed expenses cannot be retagged");
    const result = await prisma.expense.updateMany({
        where: {
            id: { in: input.ids },
            qbPurchaseId: null,
            invoiceId: null,
            invoicedAt: null,
        },
        data: { changeOrderId: input.changeOrderId, isBillable: input.isBillable ?? true },
    });
    return { updated: result.count };
}
