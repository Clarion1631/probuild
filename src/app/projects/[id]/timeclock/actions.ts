"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { getCurrentUserWithPermissions, hasPermission, canAccessProject } from "@/lib/permissions";
import { resolveCostCode } from "@/lib/cost-coding";

export async function createTimeEntry(data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    laborCost: number;
}) {
    // On-behalf-of entry: require the timeClock permission and access to this project,
    // not just any logged-in session (this action accepts an arbitrary userId).
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock") || !canAccessProject(user, data.projectId)) {
        throw new Error("Forbidden");
    }

    // Job-costing gate: no uncoded labour from the web time-clock either.
    const coded = await resolveCostCode({ costCodeId: data.costCodeId });
    if (!coded.ok) throw new Error(coded.error);

    // Start time at midnight of the selected date (simplified for this context)
    const startTime = new Date(data.date);

    await prisma.timeEntry.create({
        data: {
            projectId: data.projectId,
            userId: data.userId,
            costCodeId: coded.costCodeId,
            costTypeId: coded.costTypeId,
            startTime,
            durationHours: data.durationHours,
            laborCost: data.laborCost
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
}) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock") || !canAccessProject(user, data.projectId)) {
        throw new Error("Forbidden");
    }

    const coded = await resolveCostCode({ costCodeId: data.costCodeId });
    if (!coded.ok) throw new Error(coded.error);

    const startTime = new Date(data.date);

    await prisma.timeEntry.update({
        where: { id },
        data: {
            userId: data.userId,
            costCodeId: coded.costCodeId,
            costTypeId: coded.costTypeId,
            startTime,
            durationHours: data.durationHours,
            laborCost: data.laborCost
        }
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
}

export async function deleteTimeEntry(id: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");

    const entry = await prisma.timeEntry.findUnique({ where: { id }});
    if (!entry) throw new Error("Not found");
    if (!canAccessProject(user, entry.projectId)) throw new Error("Forbidden");

    await prisma.timeEntry.delete({ where: { id } });

    revalidatePath(`/projects/${entry.projectId}/timeclock`);
    revalidatePath(`/projects/${entry.projectId}/costing`);
}
