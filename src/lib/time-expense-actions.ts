"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
    expenseForProjectWhere,
    expenseStillOnProjectWhere,
    resolveExpenseProjectId,
    resolveExpenseProjectUnderLock,
} from "@/lib/expense-attribution";
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
import { isReceiptUrlRef, resolveReceiptUrl } from "@/lib/receipt-intake/receipt-url";
import { toCompanyDayKey } from "@/lib/company-day";
import { assertExpenseMutableOutsideQbo } from "@/lib/qbo-expense-guard";

async function assertTimeExpenseProjectAccess(projectId: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user && await canUseDevAuthFallback()) return;
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (user.role !== "FINANCE" && !canAccessProject(user, projectId)) throw new Error("Forbidden");
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
    await assertTimeExpenseProjectAccess(data.projectId);
    await createTimeEntryFromStoredRatesCore(data, session.user.email);

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
        laborCost: number;
    }
) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (!Number.isFinite(data.durationHours) || data.durationHours <= 0) throw new Error("Hours must be greater than zero");
    if (!Number.isFinite(data.laborCost) || data.laborCost < 0) throw new Error("Labor cost cannot be negative");
    // Date-only input goes through the company-timezone helper, not new Date():
    // new Date("2026-07-27") is UTC midnight, which is the 26th in company time,
    // so a plain parse silently moves the entry back a day. createTimeEntryCore
    // already does this; the edit path did not.
    const timeZone = await resolveCompanyTimeZone();
    const startTime = dateInputInTimeZone(data.date, timeZone, "Time entry date");
    if (!startTime || Number.isNaN(startTime.getTime())) throw new Error("A valid time-entry date is required");
    const current = await prisma.timeEntry.findUnique({ where: { id }, select: { projectId: true, invoiceId: true, invoicedAt: true, estimateItemId: true } });
    if (!current || current.projectId !== data.projectId || !canAccessProject(user, current.projectId)) throw new Error("Forbidden");
    if (current.invoiceId || current.invoicedAt) throw new Error("Billed time entries cannot be edited");

    // Re-bind against the STORED row: this action never writes projectId, so a
    // client-supplied one could attach another project's task, and dropping the
    // estimate item would lose a good mobile binding on an ordinary hours edit.
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: data.userId,
        projectId: current.projectId,
        dayKey: toCompanyDayKey(startTime),
        estimateItemId: current.estimateItemId,
    });

    const updated = await prisma.timeEntry.updateMany({
        where: { id, invoiceId: null, invoicedAt: null },
        data: {
            userId: data.userId,
            costCodeId: data.costCodeId,
            startTime,
            scheduleTaskId,
            durationHours: data.durationHours,
            laborCost: data.laborCost,
        },
    });
    if (updated.count !== 1) throw new Error("Time entry was billed while it was being edited; refresh and try again");

    revalidatePath(`/projects/${data.projectId}/time-expenses`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function deleteTimeEntry(id: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    const entry = await prisma.timeEntry.findUnique({ where: { id } });
    if (!entry) throw new Error("Not found");
    if (!canAccessProject(user, entry.projectId)) throw new Error("Forbidden");
    if (entry.invoiceId || entry.invoicedAt) throw new Error("Billed time entries cannot be deleted");

    const deleted = await prisma.timeEntry.deleteMany({ where: { id, invoiceId: null, invoicedAt: null } });
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
        select: { id: true, projectId: true, invoiceId: true, invoicedAt: true },
    });

    const allowed = entries.filter(
        e => !e.invoiceId && !e.invoicedAt && canAccessProject(user, e.projectId)
    );
    if (!allowed.length) return { deleted: 0 };

    const allowedIds = allowed.map(e => e.id);
    const projectIds = new Set(allowed.map(e => e.projectId));

    const result = await prisma.timeEntry.deleteMany({
        where: { id: { in: allowedIds }, invoiceId: null, invoicedAt: null },
    });

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
            projectId: true,
            estimateId: true,
            estimate: { select: { projectId: true } },
        },
    });
    // Resolved, not read off the estimate. For a RE-ATTRIBUTED expense the
    // estimate still names the job it left, so reading it here both admitted
    // someone whose access is to that old job and refused the crew who now
    // own the row — a deletion authorized against a project the expense is
    // not on.
    const resolvedProjectId = expense ? resolveExpenseProjectId(expense) : null;
    if (!expense || resolvedProjectId !== projectId || !canAccessProject(user, resolvedProjectId)) {
        throw new Error("Forbidden");
    }
    assertExpenseMutableOutsideQbo(expense);
    if (expense.invoiceId || expense.invoicedAt) throw new Error("Billed expenses cannot be deleted");

    // AND AGAIN, UNDER LOCK (round 20, item 4). Same rule as the API DELETE:
    // a row with no `projectId` of its own answers through its estimate, and
    // somebody can move that estimate between the check above and this delete,
    // destroying the row under a permission granted for a job it has left.
    const deleted = await prisma.$transaction(async tx => {
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
        const locked = await resolveExpenseProjectUnderLock(raw, {
            projectId: expense.projectId,
            estimateId: expense.estimateId,
        });
        if (!locked || locked !== projectId || !canAccessProject(user, locked)) {
            throw new Error("Forbidden");
        }
        return tx.expense.deleteMany({
            where: {
                id,
                qbPurchaseId: null,
                invoiceId: null,
                invoicedAt: null,
                // The job the actor was authorized against, in the predicate.
                ...expenseStillOnProjectWhere(expense, locked),
            },
        });
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
            projectId: true,
            estimateId: true,
            invoiceId: true,
            invoicedAt: true,
            estimate: { select: { projectId: true } },
        },
    });
    // Resolve each row's job the ONE way — the new column when it has one, the
    // estimate otherwise. Reading `e.estimate.projectId` directly would send a
    // re-attributed expense's access check to the project it used to be on.
    const withProject = expenses.map(e => ({ ...e, resolvedProjectId: resolveExpenseProjectId(e) }));
    const accessible = withProject.filter(
        e => e.resolvedProjectId && canAccessProject(user, e.resolvedProjectId),
    );
    for (const expense of accessible) assertExpenseMutableOutsideQbo(expense);
    const allowed = accessible.filter(e => !e.invoiceId && !e.invoicedAt);
    if (!allowed.length) return { deleted: 0 };

    const allowedIds = allowed.map(e => e.id);
    const projectIds = new Set(
        allowed.map(e => e.resolvedProjectId).filter(Boolean) as string[]
    );

    // ONE ROW PER STATEMENT, each under its own locked re-resolve (round 20,
    // item 4). A single `deleteMany` over the batch cannot carry a per-row
    // attribution predicate, and these rows can be on different jobs, so a
    // batch authorized row by row was then deleted as a set with nothing
    // holding any of those answers still.
    //
    // A row that moved is skipped rather than fatal: the rest of the batch is a
    // legitimate request, and the returned count says what actually happened.
    let deletedCount = 0;
    await prisma.$transaction(async tx => {
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
        for (const expense of allowed) {
            const locked = await resolveExpenseProjectUnderLock(raw, {
                projectId: expense.projectId,
                estimateId: expense.estimateId,
            });
            if (!locked || !canAccessProject(user, locked)) continue;
            const { count } = await tx.expense.deleteMany({
                where: {
                    id: expense.id,
                    qbPurchaseId: null,
                    invoiceId: null,
                    invoicedAt: null,
                    ...expenseStillOnProjectWhere(expense, locked),
                },
            });
            deletedCount += count;
        }
    });
    const result = { count: deletedCount };

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
        where: expenseForProjectWhere(projectId),
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

    const expenseRows = await prisma.expense.findMany({
        where: expenseForProjectWhere(projectId),
        include: {
            costCode: { select: { id: true, name: true, code: true } },
            costType: { select: { id: true, name: true } },
            item: { select: { id: true, name: true } },
            changeOrder: { select: { id: true, code: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    // `receiptUrl` is a stored REFERENCE for anything the receipt pipeline
    // booked (`receipt-intake://…`), not a link — the tab renders it as an
    // href, so it is resolved to a short-lived signed URL here. Legacy absolute
    // URLs and data URLs come back unchanged.
    const expenses = await Promise.all(expenseRows.map(async expense => ({
        ...expense,
        receiptUrl: isReceiptUrlRef(expense.receiptUrl)
            ? await resolveReceiptUrl(expense.receiptUrl)
            : expense.receiptUrl,
    })));

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
