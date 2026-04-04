"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function createTimeEntry(data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    laborCost: number;
    isBillable?: boolean;
    isTaxable?: boolean;
    costRate?: number | null;
    description?: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    // Start time at midnight of the selected date (simplified for this context)
    const startTime = new Date(data.date);

    await prisma.timeEntry.create({
        data: {
            projectId: data.projectId,
            userId: data.userId,
            costCodeId: data.costCodeId,
            startTime,
            durationHours: data.durationHours,
            laborCost: data.laborCost,
            isBillable: data.isBillable ?? true,
            isTaxable: data.isTaxable ?? true,
            costRate: data.costRate ?? null,
            description: data.description || null,
        }
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
}

export async function updateTimeEntry(id: string, data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    laborCost: number;
    isBillable?: boolean;
    isTaxable?: boolean;
    costRate?: number | null;
    description?: string;
}) {
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
            isBillable: data.isBillable ?? true,
            isTaxable: data.isTaxable ?? true,
            costRate: data.costRate ?? null,
            description: data.description || null,
        }
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
}

export async function deleteTimeEntry(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const entry = await prisma.timeEntry.findUnique({ where: { id }});
    if (!entry) throw new Error("Not found");

    await prisma.timeEntry.delete({ where: { id } });

    revalidatePath(`/projects/${entry.projectId}/timeclock`);
    revalidatePath(`/projects/${entry.projectId}/costing`);
}

// Inline update for time entry fields (used by inline-edit table)
export async function inlineUpdateTimeEntry(id: string, field: string, value: string | number | boolean) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const entry = await prisma.timeEntry.findUnique({ where: { id } });
    if (!entry) throw new Error("Not found");

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) throw new Error("Unauthorized");

    const updateData: Record<string, unknown> = {};

    switch (field) {
        case "durationHours":
            updateData.durationHours = Number(value);
            // Recalculate labor cost
            const rate = entry.costRate ? Number(entry.costRate) : 0;
            updateData.laborCost = Number(value) * rate;
            break;
        case "costRate":
            updateData.costRate = Number(value);
            updateData.laborCost = (entry.durationHours || 0) * Number(value);
            break;
        case "isBillable":
            updateData.isBillable = Boolean(value);
            break;
        case "isTaxable":
            updateData.isTaxable = Boolean(value);
            break;
        case "description":
            updateData.description = String(value) || null;
            break;
        case "costCodeId":
            updateData.costCodeId = value ? String(value) : null;
            break;
        default:
            throw new Error(`Cannot inline-edit field: ${field}`);
    }

    updateData.editedByManagerId = user.id;
    updateData.editedAt = new Date();

    await prisma.timeEntry.update({ where: { id }, data: updateData });

    revalidatePath(`/projects/${entry.projectId}/timeclock`);
    revalidatePath(`/projects/${entry.projectId}/costing`);
}

// Bulk approve time entries
export async function bulkApproveTimeEntries(ids: string[], projectId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) {
        throw new Error("Only admins and managers can approve entries");
    }

    // Mark as billable (approved) with manager audit trail
    await prisma.timeEntry.updateMany({
        where: { id: { in: ids } },
        data: {
            isBillable: true,
            editedByManagerId: user.id,
            editedAt: new Date(),
        }
    });

    revalidatePath(`/projects/${projectId}/timeclock`);
    revalidatePath(`/projects/${projectId}/costing`);
    return { count: ids.length };
}

// Bulk delete time entries
export async function bulkDeleteTimeEntries(ids: string[], projectId: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) {
        throw new Error("Only admins and managers can bulk delete");
    }

    await prisma.timeEntry.deleteMany({ where: { id: { in: ids } } });

    revalidatePath(`/projects/${projectId}/timeclock`);
    revalidatePath(`/projects/${projectId}/costing`);
    return { count: ids.length };
}

// ===== EXPENSE ACTIONS =====

export async function createExpense(data: {
    projectId: string;
    amount: number;
    vendor?: string;
    date?: string;
    description?: string;
    receiptUrl?: string;
    quantity?: number;
    paymentMethod?: string;
    isBillable?: boolean;
    isTaxable?: boolean;
    service?: string;
    syncToQB?: boolean;
    reportedById?: string;
    costCodeId?: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) throw new Error("Unauthorized");

    // Generate reference number EX-NNNNN
    const lastExpense = await prisma.expense.findFirst({
        where: { referenceNumber: { startsWith: "EX-" } },
        orderBy: { createdAt: "desc" },
        select: { referenceNumber: true },
    });
    let nextNum = 1;
    if (lastExpense?.referenceNumber) {
        const num = parseInt(lastExpense.referenceNumber.replace("EX-", ""), 10);
        if (!isNaN(num)) nextNum = num + 1;
    }
    const referenceNumber = `EX-${String(nextNum).padStart(5, "0")}`;

    await prisma.expense.create({
        data: {
            projectId: data.projectId,
            amount: data.amount,
            vendor: data.vendor || null,
            date: data.date ? new Date(data.date) : new Date(),
            description: data.description || null,
            receiptUrl: data.receiptUrl || null,
            quantity: data.quantity ?? 1,
            paymentMethod: data.paymentMethod || null,
            isBillable: data.isBillable ?? true,
            isTaxable: data.isTaxable ?? true,
            service: data.service || null,
            syncToQB: data.syncToQB ?? false,
            referenceNumber,
            reportedById: data.reportedById || user.id,
            costCodeId: data.costCodeId || null,
            status: "Pending",
        }
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function updateExpense(id: string, data: {
    projectId: string;
    amount: number;
    vendor?: string;
    date?: string;
    description?: string;
    receiptUrl?: string;
    quantity?: number;
    paymentMethod?: string;
    isBillable?: boolean;
    isTaxable?: boolean;
    service?: string;
    syncToQB?: boolean;
    reportedById?: string;
    costCodeId?: string;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    await prisma.expense.update({
        where: { id },
        data: {
            amount: data.amount,
            vendor: data.vendor || null,
            date: data.date ? new Date(data.date) : null,
            description: data.description || null,
            receiptUrl: data.receiptUrl || null,
            quantity: data.quantity ?? 1,
            paymentMethod: data.paymentMethod || null,
            isBillable: data.isBillable ?? true,
            isTaxable: data.isTaxable ?? true,
            service: data.service || null,
            syncToQB: data.syncToQB ?? false,
            reportedById: data.reportedById || null,
            costCodeId: data.costCodeId || null,
        }
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
    revalidatePath(`/projects/${data.projectId}/budget`);
}

export async function deleteExpense(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new Error("Not found");

    await prisma.expense.delete({ where: { id } });

    if (expense.projectId) {
        revalidatePath(`/projects/${expense.projectId}/timeclock`);
        revalidatePath(`/projects/${expense.projectId}/costing`);
        revalidatePath(`/projects/${expense.projectId}/budget`);
    }
}

export async function approveExpense(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new Error("Not found");

    await prisma.expense.update({
        where: { id },
        data: { status: "Approved" }
    });

    if (expense.projectId) {
        revalidatePath(`/projects/${expense.projectId}/timeclock`);
    }
}
