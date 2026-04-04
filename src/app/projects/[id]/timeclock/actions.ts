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
