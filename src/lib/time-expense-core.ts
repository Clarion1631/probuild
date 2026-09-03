import { prisma } from "./prisma";
import { resolveCostCode } from "./cost-coding";
import { prismaCostCodingDataSource } from "./cost-coding-db";
import { isCostCodeAllowedForProject } from "./project-phases";
import { assertPhaseOfProjectTx, lockAttributionParents } from "./phase-invariant";
import {
    expenseStillOnProjectWhere,
    itemBelongsToEstimateTx,
    lockEstimateAttribution,
    resolveExpenseProjectId,
    resolveExpenseProjectUnderLock,
} from "./expense-attribution";
import { prismaPhaseDataSource } from "./project-phases-db";
import { dateOnlyInTimeZone, resolveCompanyTimeZone } from "./company-timezone";
import { resolveScheduleTaskIdForPunch } from "./punch-task-binding";
import { toCompanyDayKey } from "./company-day";
import { assertExpenseMutableOutsideQbo } from "./qbo-expense-guard";

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

    return prisma.timeEntry.create({
        data: {
            projectId,
            scheduleTaskId,
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

export type CreateTimeEntryFromStoredRatesInput = Omit<CreateTimeEntryCoreInput, "laborCost" | "burdenCost">;

export async function createTimeEntryFromStoredRatesCore(data: CreateTimeEntryFromStoredRatesInput, actor: string) {
    const member = await prisma.user.findUnique({
        where: { id: data.userId },
        select: { id: true, hourlyRate: true, burdenRate: true },
    });
    if (!member) throw new Error("Crew member not found");
    const costs = calculateCrewTimeCosts(data.durationHours, Number(member.hourlyRate), Number(member.burdenRate));
    return createTimeEntryCore({ ...data, ...costs }, actor);
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

    // A cost code arriving here used to be stored verbatim and stamped
    // "manual" — permanently outranking every automated pass — without anyone
    // checking it belonged to this job. "The cost code exists" is not a
    // permission (src/lib/cost-coding.ts SCOPE note): both checks, or a form
    // post can pin another project's phase onto this expense forever.
    let costCodeId = data.costCodeId || null;
    let costTypeId = data.costTypeId || null;
    if (costCodeId) {
        const resolved = await resolveCostCode(prismaCostCodingDataSource, { costCodeId });
        if (!resolved.ok) throw new Error(resolved.error);
        const onProject = await isCostCodeAllowedForProject(
            prismaPhaseDataSource,
            estimate.projectId,
            resolved.costCodeId,
        );
        if (!onProject) {
            throw new Error("That cost code isn't one of this project's phases.");
        }
        costCodeId = resolved.costCodeId;
        // Only an estimate item knows whether the money is Labor or Material,
        // so an explicit code carries no cost type of its own — keep the
        // caller's when it gave one, rather than inventing a guess.
        costTypeId = costTypeId ?? resolved.costTypeId;
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

    // THE PHASE ANSWER THAT COUNTS, taken with the write (round 18, item 4).
    // The check above answers on the global client and holds nothing; this one
    // locks the four tables it rests on and reads them on the transaction that
    // inserts the row.
    return prisma.$transaction(async tx => {
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
        // THE WHOLE LOCK SET, IN THE CANONICAL ORDER, FIRST (round 37, item 3):
        // Project -> Estimate -> EstimateItem -> CostCode. Same reason as the
        // POST route — the three helpers below take slices of this set, and on
        // their own they reach the Estimate before the Project, which is a
        // deadlock cycle against a Project-first job editor.
        await lockAttributionParents(raw, {
            projectId: estimate.projectId,
            estimateId,
            itemId: data.itemId || null,
            costCodeId,
        });
        // THE PAIR, RE-READ UNDER LOCK (round 20, item 3): same reason as the
        // POST route. The estimate's project was resolved before the cost-code
        // and receipt-file lookups; writing it now without re-reading can put
        // an expense on a job its own estimate has left.
        const pair = await lockEstimateAttribution(raw, estimateId);
        if (!pair) throw new Error("Estimate must belong to a project");
        if (pair.projectId !== estimate.projectId) {
            throw new Error("This estimate moved to another job while the expense was being created");
        }
        if (data.itemId && !(await itemBelongsToEstimateTx(raw, data.itemId, estimateId))) {
            throw new Error("Line item must belong to the resolved estimate");
        }
        if (costCodeId) {
            const verdict = await assertPhaseOfProjectTx(
                tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                estimate.projectId,
                costCodeId,
            );
            if (!verdict.ok) throw new Error("That cost code isn't one of this project's phases.");
        }
        return tx.expense.create({
            data: {
            // ONE PAIR, from one locked read.
            estimateId: pair.estimateId,
            projectId: pair.projectId,
            itemId: data.itemId || null,
            costCodeId,
            costTypeId,
            // Every caller of this core is a human picking a code in a web form
            // or a CO flow, so a code here is "manual" and is off limits to the
            // sync and the backfill.
            costCodeSource: costCodeId ? "manual" : null,
            amount: dollars(data.amount),
            vendor: data.vendor?.trim() || null,
            date: expenseDate,
            description: data.description?.trim() || null,
            receiptUrl,
            changeOrderId: changeOrder?.id ?? null,
            isBillable: data.isBillable ?? Boolean(changeOrder),
            },
        });
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
        // ASCENDING ID, because this is a BATCH (round 46, item 3). Two tag
        // requests over overlapping selections lock the same Expense rows; an
        // unordered `findMany` lets the server hand them back in different
        // orders, and two transactions locking shared rows in opposite orders
        // deadlock with no parent table involved. The loop below preserves
        // this order.
        orderBy: { id: "asc" },
        select: {
            id: true,
            qbPurchaseId: true,
            projectId: true,
            estimateId: true,
            estimate: { select: { projectId: true } },
            invoiceId: true,
            invoicedAt: true,
        },
    });
    if (rows.length !== new Set(input.ids).size) throw new Error("One or more expenses were not found");
    // Resolved, not read off the estimate. A re-attributed expense belongs to
    // the job its `projectId` names — checking the estimate would let it be
    // tagged to a change order on the job it USED to be on, and would refuse a
    // legitimate tag on the job it is actually on now.
    if (rows.some((row) => resolveExpenseProjectId(row) !== changeOrder.projectId)) {
        throw new Error("All expenses must belong to the change order project");
    }
    for (const row of rows) assertExpenseMutableOutsideQbo(row);
    if (rows.some((row) => row.invoiceId || row.invoicedAt)) throw new Error("Billed expenses cannot be retagged");
    // ONE ROW PER STATEMENT, under a locked re-resolve (round 20, item 4).
    //
    // Tagging an expense to a change order says "this money belongs to that
    // job's CO". The rows were checked against the CO's project and then
    // updated as a set, with nothing holding the answer still — so a
    // fallback-attributed row whose estimate moved got billed to a change order
    // on a job it had already left.
    //
    // A row that moved is skipped, not fatal: the count tells the caller.
    let updated = 0;
    await prisma.$transaction(async tx => {
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
        // EVERY PARENT FIRST, THEN THE ROWS (round 46, item 3). The loop below
        // locked row 1's parents, updated row 1 — taking that Expense
        // exclusively and, through the foreign keys, a KEY SHARE on its
        // Project and Estimate — and only then reached for row 2's parents:
        // Expense -> Estimate, the declared order backwards. One call up front
        // takes the batch's whole parent set in the canonical order before any
        // Expense is touched; the per-row re-resolve below then re-acquires
        // share locks this transaction already holds, which is free.
        await lockAttributionParents(raw, {
            projectId: changeOrder.projectId,
            projectIds: rows.map(row => row.projectId),
            estimateIds: rows.map(row => row.estimateId),
        });
        for (const row of rows) {
            const locked = await resolveExpenseProjectUnderLock(raw, {
                projectId: row.projectId,
                estimateId: row.estimateId,
            });
            if (locked !== changeOrder.projectId) continue;
            const { count } = await tx.expense.updateMany({
                where: {
                    id: row.id,
                    qbPurchaseId: null,
                    invoiceId: null,
                    invoicedAt: null,
                    ...expenseStillOnProjectWhere(row, locked),
                },
                data: { changeOrderId: input.changeOrderId, isBillable: input.isBillable ?? true },
            });
            updated += count;
        }
    });
    return { updated };
}
