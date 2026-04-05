"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

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
        where: { projectId, isArchived: false },
        select: {
            id: true,
            title: true,
            items: { select: { id: true, name: true }, where: { isSection: false } },
        },
    });

    return { timeEntries, expenses, costCodes, costTypes, teamMembers, estimates };
}
