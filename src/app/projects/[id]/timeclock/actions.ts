"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { dayKeyFromDateOnly } from "@/lib/company-day";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission, canAccessProject } from "@/lib/permissions";
import { withPayrollWriteTx } from "@/lib/payroll-period";

// A bare session check let any signed-in account write hours against any
// project. These rows are now direct field evidence on the schedule board, so
// they get the same permission + project-access gate the rest of the app uses.
async function assertTimeclockProjectAccess(projectId: string) {
    const user = await getCurrentUserWithPermissions();
    if (!user && await canUseDevAuthFallback()) return;
    if (!user) throw new Error("Unauthorized");
    if (!hasPermission(user, "timeClock")) throw new Error("Forbidden");
    if (user.role !== "FINANCE" && !canAccessProject(user, projectId)) throw new Error("Forbidden");
}

export async function createTimeEntry(data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    laborCost: number;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    await assertTimeclockProjectAccess(data.projectId);

    // Start time at midnight of the selected date (simplified for this context)
    const startTime = new Date(data.date);
    // Day comes from the date STRING: new Date("2026-07-27") is UTC midnight,
    // which is the 26th in company time.
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: data.userId,
        projectId: data.projectId,
        dayKey: dayKeyFromDateOnly(data.date),
        estimateItemId: null,
    });

    // Creating hours AT a date is moving hours INTO that period, so a create is
    // as much a payroll change as an edit. Check + write in one transaction
    // under the shared advisory lock (src/lib/payroll-period.ts).
    await withPayrollWriteTx([startTime], (tx) =>
        (tx as unknown as typeof prisma).timeEntry.create({
            data: {
                projectId: data.projectId,
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                // A manual entry is a COMPLETED shift — see the backfill in
                // scripts/apply-payroll-phase5.mjs. Leaving endTime NULL made
                // every "still clocked in?" reader, including the payroll
                // readiness check, treat a finished shift as open.
                endTime: new Date(startTime.getTime() + data.durationHours * 3_600_000),
                durationHours: data.durationHours,
                laborCost: data.laborCost,
                scheduleTaskId
            }
        })
    );

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
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const startTime = new Date(data.date);

    // Resolve against the STORED row: this action never writes projectId, so a
    // supplied one could attach another project's task, and a null estimate item
    // would drop a good mobile binding on an ordinary hours edit.
    const existing = await prisma.timeEntry.findUnique({
        where: { id },
        select: { projectId: true, startTime: true, estimateItemId: true },
    });
    if (!existing) throw new Error("Not found");
    await assertTimeclockProjectAccess(existing.projectId);
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: data.userId,
        projectId: existing.projectId,
        dayKey: dayKeyFromDateOnly(data.date),
        estimateItemId: existing.estimateItemId,
    });

    // Both dates — editing inside a locked period, and moving a punch into one.
    await withPayrollWriteTx([existing.startTime, startTime], (tx) =>
        (tx as unknown as typeof prisma).timeEntry.update({
            where: { id },
            data: {
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                endTime: new Date(startTime.getTime() + data.durationHours * 3_600_000),
                durationHours: data.durationHours,
                laborCost: data.laborCost,
                scheduleTaskId
            }
        })
    );

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
}

export async function deleteTimeEntry(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const entry = await prisma.timeEntry.findUnique({ where: { id }});
    if (!entry) throw new Error("Not found");

    await withPayrollWriteTx([entry.startTime], (tx) =>
        (tx as unknown as typeof prisma).timeEntry.delete({ where: { id } })
    );

    revalidatePath(`/projects/${entry.projectId}/timeclock`);
    revalidatePath(`/projects/${entry.projectId}/costing`);
}
