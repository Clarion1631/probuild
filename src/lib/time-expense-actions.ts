"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { getCurrentUserWithPermissions, hasPermission, canAccessProject } from "@/lib/permissions";

// ─── Time Entry Actions ────────────────────────────────────────

export async function createTimeEntry(data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    laborCost: number;
    isBillable?: boolean;
    isTaxable?: boolean;
    notes?: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const startTime = new Date(data.date);

    await prisma.timeEntry.create({
        data: {
            projectId: data.projectId,
            userId: data.userId,
            costCodeId: data.costCodeId,
            startTime,
            durationHours: data.durationHours,
            laborCost: data.laborCost,
        },
    });

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
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const startTime = new Date(data.date);

    await prisma.timeEntry.update({
        where: { id },
        data: {
            userId: data.userId,
            costCodeId: data.costCodeId,
            startTime,
            durationHours: data.durationHours,
            laborCost: data.laborCost,
        },
    });

    revalidatePath(`/projects/${data.projectId}/time-expenses`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function deleteTimeEntry(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const entry = await prisma.timeEntry.findUnique({ where: { id } });
    if (!entry) throw new Error("Not found");

    await prisma.timeEntry.delete({ where: { id } });

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
        select: { id: true, projectId: true, invoicedAt: true },
    });

    const allowed = entries.filter(
        e => !e.invoicedAt && canAccessProject(user, e.projectId)
    );
    if (!allowed.length) return { deleted: 0 };

    const allowedIds = allowed.map(e => e.id);
    const projectIds = new Set(allowed.map(e => e.projectId));

    const result = await prisma.timeEntry.deleteMany({
        where: { id: { in: allowedIds } },
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
    receiptUrl?: string;
    projectId: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    await prisma.expense.create({
        data: {
            estimateId: data.estimateId,
            itemId: data.itemId || null,
            costCodeId: data.costCodeId || null,
            costTypeId: data.costTypeId || null,
            amount: data.amount,
            vendor: data.vendor || null,
            date: data.date ? new Date(data.date) : null,
            description: data.description || null,
            receiptUrl: data.receiptUrl || null,
        },
    });

    revalidatePath(`/projects/${data.projectId}/time-expenses`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function deleteExpense(id: string, projectId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    await prisma.expense.delete({ where: { id } });

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
        select: { id: true, estimate: { select: { projectId: true } } },
    });

    const allowed = expenses.filter(
        e => e.estimate?.projectId && canAccessProject(user, e.estimate.projectId)
    );
    if (!allowed.length) return { deleted: 0 };

    const allowedIds = allowed.map(e => e.id);
    const projectIds = new Set(
        allowed.map(e => e.estimate!.projectId).filter(Boolean) as string[]
    );

    const result = await prisma.expense.deleteMany({
        where: { id: { in: allowedIds } },
    });

    for (const projectId of projectIds) {
        revalidatePath(`/projects/${projectId}/time-expenses`);
        revalidatePath(`/projects/${projectId}/budget`);
    }
    return { deleted: result.count };
}

// ─── Individual Data Fetching ─────────────────────────────────

export async function getTimeEntries(projectId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    return prisma.timeEntry.findMany({
        where: { projectId },
        include: {
            user: { select: { id: true, name: true, email: true, hourlyRate: true } },
            costCode: { select: { id: true, name: true, code: true } },
            costType: { select: { id: true, name: true } },
        },
        orderBy: { startTime: "desc" },
    });
}

export async function getExpenses(projectId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    return prisma.expense.findMany({
        where: { estimate: { projectId } },
        include: {
            costCode: { select: { id: true, name: true, code: true } },
            costType: { select: { id: true, name: true } },
            item: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
    });
}

// ─── Combined Data Fetching ───────────────────────────────────

export async function getTimeExpenseData(projectId: string) {
    const timeEntries = await prisma.timeEntry.findMany({
        where: { projectId },
        include: {
            user: { select: { id: true, name: true, email: true, hourlyRate: true } },
            costCode: { select: { id: true, name: true, code: true } },
        },
        orderBy: { startTime: "desc" },
    });

    const expenses = await prisma.expense.findMany({
        where: { estimate: { projectId } },
        include: {
            costCode: { select: { id: true, name: true, code: true } },
            costType: { select: { id: true, name: true } },
            item: { select: { id: true, name: true } },
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
        select: { id: true, name: true, email: true, hourlyRate: true },
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

    return { timeEntries, expenses, costCodes, costTypes, teamMembers, estimates };
}
