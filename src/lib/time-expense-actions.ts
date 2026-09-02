"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission, canAccessProject } from "@/lib/permissions";
import {
    createExpenseCore,
    createTimeEntryFromStoredRatesCore,
    tagExpensesToChangeOrderCore,
    tagTimeEntriesToChangeOrderCore,
} from "@/lib/time-expense-core";
import { dateInputInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { toCompanyDayKey } from "@/lib/company-day";
import { assertExpenseMutableOutsideQbo } from "@/lib/qbo-expense-guard";
import {
    assertManualEntryDelete,
    assertManualEntryWrite,
    assertNotLegacyUnitEntry,
    assertUsableDuration,
    canWriteHoursFor,
} from "@/lib/manual-time-entry-auth";
import { withPayrollWriteTx } from "@/lib/payroll-period";
import { toNum } from "@/lib/prisma-helpers";
import {
    appendZeroRateReview,
    canAcknowledgeZeroRate,
    readOwnerRatesForUpdate,
    zeroRateBlocks,
    zeroRateManagerMessage,
} from "@/lib/pay-rate-guard";

async function assertTimeExpenseProjectAccess(projectId: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user && await canUseDevAuthFallback()) return;
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (user.role !== "FINANCE" && !canAccessProject(user, projectId)) throw new Error("Forbidden");
}

/**
 * Price an entry from the member's STORED rates, applying the same $0-rate
 * policy as every other write path.
 *
 * Read inside the caller's transaction and row-locked: a rate import committing
 * between a pre-read and this write would otherwise price the shift from a
 * value that is no longer true.
 *
 * This is always an office action, so it follows the MANAGER branch — refused
 * by default, allowed only on an explicit acknowledgement, and then flagged so
 * the payroll export refuses to run past it.
 */
async function priceEntryFromStoredRates(
    tx: { $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown> },
    userId: string,
    durationHours: number,
    acknowledgeZeroRate: boolean
): Promise<{ laborCost: number; burdenCost: number; needsReview?: boolean; reviewReason?: string }> {
    const member = await readOwnerRatesForUpdate(tx, userId, toNum);
    if (!member) throw new Error("Crew member not found");

    const zeroRate = zeroRateBlocks({
        role: member.role,
        email: member.email,
        payType: member.payType,
        hourlyRate: member.hourlyRate,
    });
    if (zeroRate && !acknowledgeZeroRate) throw new Error(zeroRateManagerMessage(member.name));

    return {
        laborCost: durationHours * member.hourlyRate,
        burdenCost: durationHours * member.burdenRate,
        ...(zeroRate ? appendZeroRateReview(null) : {}),
    };
}

// ─── Time Entry Actions ────────────────────────────────────────

export async function createTimeEntry(data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    changeOrderId?: string | null;
    isBillable?: boolean;
    isTaxable?: boolean;
    notes?: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    // Crew write their OWN hours; only the office writes somebody else's.
    const actor = await assertManualEntryWrite(data.projectId, data.userId);
    const durationHours = assertUsableDuration(data.durationHours);
    await createTimeEntryFromStoredRatesCore(
        {
            ...data,
            durationHours,
            acknowledgeZeroRate:
                (data as { acknowledgeZeroRate?: boolean }).acknowledgeZeroRate === true &&
                canAcknowledgeZeroRate(actor, data.userId),
        },
        session.user.email
    );

    revalidatePath(`/projects/${data.projectId}/time-expenses`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function updateTimeEntry(
    id: string,
    data: {
        projectId: string;
        userId: string;
        costCodeId: string | null;
        date: string;
        durationHours: number;
        /** Deliberate "book it at $0 and flag it for payroll" — never the default. */
        acknowledgeZeroRate?: boolean;
    }
) {
    const durationHours = assertUsableDuration(data.durationHours);
    // Date-only input goes through the company-timezone helper, not new Date():
    // new Date("2026-07-27") is UTC midnight, which is the 26th in company time,
    // so a plain parse silently moves the entry back a day. createTimeEntryCore
    // already does this; the edit path did not.
    const timeZone = await resolveCompanyTimeZone();
    const startTime = dateInputInTimeZone(data.date, timeZone, "Time entry date");
    if (!startTime || Number.isNaN(startTime.getTime())) throw new Error("A valid time-entry date is required");
    const current = await prisma.timeEntry.findUnique({
        where: { id },
        select: {
            projectId: true, userId: true, startTime: true, invoiceId: true, invoicedAt: true,
            estimateItemId: true, durationHours: true, laborCost: true,
        },
    });
    if (!current || current.projectId !== data.projectId) throw new Error("Forbidden");
    // Authorized against the STORED row's project and owner, and against the
    // person this edit would move it to.
    assertNotLegacyUnitEntry(current);
    const actor = await assertManualEntryWrite(current.projectId, current.userId);
    await assertManualEntryWrite(current.projectId, data.userId);
    if (current.invoiceId || current.invoicedAt) throw new Error("Billed time entries cannot be edited");
    const acknowledgeZeroRate =
        (data as { acknowledgeZeroRate?: boolean }).acknowledgeZeroRate === true &&
        canAcknowledgeZeroRate(actor, data.userId);

    // Re-bind against the STORED row: this action never writes projectId, so a
    // client-supplied one could attach another project's task, and dropping the
    // estimate item would lose a good mobile binding on an ordinary hours edit.
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: data.userId,
        projectId: current.projectId,
        dayKey: toCompanyDayKey(startTime),
        estimateItemId: current.estimateItemId,
    });

    // Lock check and write in ONE transaction, under the shared payroll
    // advisory lock (src/lib/payroll-period.ts). This action writes startTime
    // AND durationHours, so it can edit hours already paid or move hours into a
    // period that was already exported. The row's STORED startTime is re-read
    // and row-locked inside the transaction — the value captured above is not
    // trusted, because another writer may have moved the row since.
    const updated = await withPayrollWriteTx({ entryIds: [id], instants: [startTime] }, async (tx) =>
        (tx as unknown as typeof prisma).timeEntry.updateMany({
            where: { id, invoiceId: null, invoicedAt: null },
            data: {
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                scheduleTaskId,
                durationHours,
                // Cost and burden are DERIVED, inside this transaction, from the
                // member's stored rates. They used to be parameters: a server
                // action's arguments are an HTTP body, so a caller could post
                // any cost against any worker, straight into payroll and job
                // costing. Recomputed here (not before the transaction) so a
                // concurrent rate change cannot land in between.
                ...(await priceEntryFromStoredRates(
                    tx as never,
                    data.userId,
                    durationHours,
                    acknowledgeZeroRate
                )),
            },
        })
    );
    if (updated.count !== 1) throw new Error("Time entry was billed while it was being edited; refresh and try again");

    revalidatePath(`/projects/${data.projectId}/time-expenses`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function deleteTimeEntry(id: string) {
    // Authorized against the STORED row: its project AND its owner.
    const { entry } = await assertManualEntryDelete(id);
    if (entry.invoiceId || entry.invoicedAt) throw new Error("Billed time entries cannot be deleted");

    // Deleting a punch out of an exported period changes hours that were paid —
    // check and delete in one transaction under the shared advisory lock.
    const deleted = await withPayrollWriteTx({ entryIds: [id] }, (tx) =>
        (tx as unknown as typeof prisma).timeEntry.deleteMany({ where: { id, invoiceId: null, invoicedAt: null } })
    );
    if (deleted.count !== 1) throw new Error("Time entry was billed while it was being deleted; refresh and try again");

    revalidatePath(`/projects/${entry.projectId}/time-expenses`);
    revalidatePath(`/projects/${entry.projectId}/budget`);
}

export async function deleteTimeEntries(
    ids: string[]
): Promise<{ deleted: number }> {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (!ids.length) return { deleted: 0 };

    const entries = await prisma.timeEntry.findMany({
        where: { id: { in: ids } },
        select: { id: true, projectId: true, userId: true, startTime: true, invoiceId: true, invoicedAt: true },
    });

    const allowed = entries.filter(
        e => !e.invoiceId && !e.invoicedAt && canAccessProject(user, e.projectId) && canWriteHoursFor(user, e.userId)
    );
    if (!allowed.length) return { deleted: 0 };

    const allowedIds = allowed.map(e => e.id);
    const projectIds = new Set(allowed.map(e => e.projectId));

    // EVERY row, not a sample: a bulk delete that silently skipped the locked
    // ones would be worse than refusing outright, because the caller would be
    // told it succeeded.
    const result = await withPayrollWriteTx({ entryIds: allowedIds }, (tx) =>
        (tx as unknown as typeof prisma).timeEntry.deleteMany({
            where: { id: { in: allowedIds }, invoiceId: null, invoicedAt: null },
        })
    );

    for (const projectId of projectIds) {
        revalidatePath(`/projects/${projectId}/time-expenses`);
        revalidatePath(`/projects/${projectId}/budget`);
    }
    return { deleted: result.count };
}

// ─── Expense Actions ───────────────────────────────────────────

export async function createExpense(data: {
    estimateId: string;
    itemId?: string;
    costCodeId?: string;
    costTypeId?: string;
    amount: number;
    vendor?: string;
    date?: string;
    description?: string;
    receiptFileId?: string;
    changeOrderId?: string | null;
    isBillable?: boolean;
    projectId: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    await assertTimeExpenseProjectAccess(data.projectId);
    await createExpenseCore({
        projectId: data.projectId,
        estimateId: data.estimateId,
        itemId: data.itemId,
        costCodeId: data.costCodeId,
        costTypeId: data.costTypeId,
        amount: data.amount,
        vendor: data.vendor,
        date: data.date,
        description: data.description,
        receiptFileId: data.receiptFileId,
        changeOrderId: data.changeOrderId,
        isBillable: data.isBillable,
    }, session.user.email);

    revalidatePath(`/projects/${data.projectId}/time-expenses`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function deleteExpense(id: string, projectId: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    const expense = await prisma.expense.findUnique({
        where: { id },
        select: {
            qbPurchaseId: true,
            invoiceId: true,
            invoicedAt: true,
            estimate: { select: { projectId: true } },
        },
    });
    if (!expense || expense.estimate.projectId !== projectId || !canAccessProject(user, expense.estimate.projectId)) {
        throw new Error("Forbidden");
    }
    assertExpenseMutableOutsideQbo(expense);
    if (expense.invoiceId || expense.invoicedAt) throw new Error("Billed expenses cannot be deleted");

    const deleted = await prisma.expense.deleteMany({
        where: { id, qbPurchaseId: null, invoiceId: null, invoicedAt: null },
    });
    if (deleted.count !== 1) throw new Error("Expense was billed while it was being deleted; refresh and try again");

    revalidatePath(`/projects/${projectId}/time-expenses`);
    revalidatePath(`/projects/${projectId}/budget`);
}

export async function deleteExpenses(
    ids: string[]
): Promise<{ deleted: number }> {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (!ids.length) return { deleted: 0 };

    const expenses = await prisma.expense.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            qbPurchaseId: true,
            invoiceId: true,
            invoicedAt: true,
            estimate: { select: { projectId: true } },
        },
    });
    const accessible = expenses.filter(
        e => e.estimate?.projectId && canAccessProject(user, e.estimate.projectId),
    );
    for (const expense of accessible) assertExpenseMutableOutsideQbo(expense);
    const allowed = accessible.filter(e => !e.invoiceId && !e.invoicedAt);
    if (!allowed.length) return { deleted: 0 };

    const allowedIds = allowed.map(e => e.id);
    const projectIds = new Set(
        allowed.map(e => e.estimate!.projectId).filter(Boolean) as string[]
    );

    const result = await prisma.expense.deleteMany({
        where: {
            id: { in: allowedIds },
            qbPurchaseId: null,
            invoiceId: null,
            invoicedAt: null,
        },
    });

    for (const projectId of projectIds) {
        revalidatePath(`/projects/${projectId}/time-expenses`);
        revalidatePath(`/projects/${projectId}/budget`);
    }
    return { deleted: result.count };
}

export async function tagTimeEntriesToChangeOrder(projectId: string, ids: string[], changeOrderId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    const target = await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { projectId: true } });
    if (!target || target.projectId !== projectId) throw new Error("Change order does not belong to the authorized project");
    await assertTimeExpenseProjectAccess(target.projectId);
    const result = await tagTimeEntriesToChangeOrderCore({ ids, changeOrderId }, session.user.email);
    revalidatePath(`/projects/${projectId}/time-expenses`);
    return result;
}

export async function tagExpensesToChangeOrder(projectId: string, ids: string[], changeOrderId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    const target = await prisma.changeOrder.findUnique({ where: { id: changeOrderId }, select: { projectId: true } });
    if (!target || target.projectId !== projectId) throw new Error("Change order does not belong to the authorized project");
    await assertTimeExpenseProjectAccess(target.projectId);
    const result = await tagExpensesToChangeOrderCore({ ids, changeOrderId }, session.user.email);
    revalidatePath(`/projects/${projectId}/time-expenses`);
    return result;
}

// ─── Individual Data Fetching ─────────────────────────────────

export async function getTimeEntries(projectId: string) {
    await assertTimeExpenseProjectAccess(projectId);

    return prisma.timeEntry.findMany({
        where: { projectId },
        include: {
            user: { select: { id: true, name: true, email: true, hourlyRate: true, burdenRate: true } },
            costCode: { select: { id: true, name: true, code: true } },
            changeOrder: { select: { id: true, code: true, title: true } },
            costType: { select: { id: true, name: true } },
        },
        orderBy: { startTime: "desc" },
    });
}

export async function getExpenses(projectId: string) {
    await assertTimeExpenseProjectAccess(projectId);

    return prisma.expense.findMany({
        where: { estimate: { projectId } },
        include: {
            costCode: { select: { id: true, name: true, code: true } },
            costType: { select: { id: true, name: true } },
            item: { select: { id: true, name: true } },
            changeOrder: { select: { id: true, code: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
    });
}

// ─── Combined Data Fetching ───────────────────────────────────

export async function getTimeExpenseData(projectId: string) {
    await assertTimeExpenseProjectAccess(projectId);
    const timeEntries = await prisma.timeEntry.findMany({
        where: { projectId },
        include: {
            user: { select: { id: true, name: true, email: true, hourlyRate: true, burdenRate: true } },
            costCode: { select: { id: true, name: true, code: true } },
            changeOrder: { select: { id: true, code: true, title: true } },
        },
        orderBy: { startTime: "desc" },
    });

    const expenses = await prisma.expense.findMany({
        where: { estimate: { projectId } },
        include: {
            costCode: { select: { id: true, name: true, code: true } },
            costType: { select: { id: true, name: true } },
            item: { select: { id: true, name: true } },
            changeOrder: { select: { id: true, code: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    const costCodes = await prisma.costCode.findMany({
        where: { isActive: true },
        orderBy: { code: "asc" },
    });

    const costTypes = await prisma.costType.findMany({
        orderBy: { name: "asc" },
    });

    const teamMembers = await prisma.user.findMany({
        where: { status: { not: "DISABLED" } },
        select: { id: true, name: true, email: true, hourlyRate: true, burdenRate: true },
        orderBy: { name: "asc" },
    });

    const estimates = await prisma.estimate.findMany({
        where: { projectId, archivedAt: null },
        select: {
            id: true,
            title: true,
            items: { select: { id: true, name: true } },
        },
    });

    const changeOrders = await prisma.changeOrder.findMany({
        where: { projectId, pricingType: "COST_PLUS", status: { in: ["Sent", "Approved"] } },
        select: { id: true, code: true, title: true, status: true, estimateId: true },
        orderBy: { createdAt: "desc" },
    });

    return { timeEntries, expenses, costCodes, costTypes, teamMembers, estimates, changeOrders };
}
