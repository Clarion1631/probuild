"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { dayKeyFromDateOnly } from "@/lib/company-day";
import { dateInputInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission, canAccessProject } from "@/lib/permissions";
import { withPayrollWriteTx } from "@/lib/payroll-period";
import { toNum } from "@/lib/prisma-helpers";
import {
    appendZeroRateReview,
    readOwnerRatesForUpdate,
    zeroRateBlocks,
    zeroRateManagerMessage,
} from "@/lib/pay-rate-guard";

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


/**
 * Price a manual entry from the member's STORED rates, and apply the same
 * $0-rate policy as every other write path.
 *
 * laborCost used to be a parameter. A server action's arguments are an HTTP
 * body, so that let a caller post any cost they liked against any worker —
 * straight into payroll and job costing. The rate is read from the database
 * here and nowhere else.
 *
 * This is always an office action (there is no worker-side manual create), so
 * it follows the MANAGER branch of the zero-rate rule: refused by default, and
 * allowed only when the caller explicitly acknowledges it, in which case the
 * entry is flagged for payroll (src/lib/pay-rate-guard.ts).
 */
async function priceManualEntry(
    tx: { $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown> },
    userId: string,
    durationHours: number,
    acknowledgeZeroRate: boolean
): Promise<{ laborCost: number; burdenCost: number; needsReview?: boolean; reviewReason?: string }> {
    // Row-locked, INSIDE the caller's write transaction. Reading the rate before
    // the transaction let a concurrent rate import land in between, and the
    // entry was then stamped at a rate that was no longer true — including a $0
    // one this guard would have refused.
    const member = await readOwnerRatesForUpdate(tx, userId, toNum);
    if (!member) throw new Error("Crew member not found");

    const zeroRate = zeroRateBlocks({
        role: member.role,
        email: member.email,
        payType: member.payType,
        hourlyRate: member.hourlyRate,
    });
    if (zeroRate && !acknowledgeZeroRate) {
        throw new Error(zeroRateManagerMessage(member.name));
    }

    return {
        laborCost: durationHours * member.hourlyRate,
        burdenCost: durationHours * member.burdenRate,
        ...(zeroRate ? appendZeroRateReview(null) : {}),
    };
}

export async function createTimeEntry(data: {
    projectId: string;
    userId: string;
    costCodeId: string | null;
    date: string;
    durationHours: number;
    /** Deliberate "book it at $0 and flag it for payroll" — never the default. */
    acknowledgeZeroRate?: boolean;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    const acknowledgeZeroRate = data.acknowledgeZeroRate === true;

    await assertTimeclockProjectAccess(data.projectId);

    // Company-local calendar day, NOT new Date(): new Date("2026-07-27") is UTC
    // midnight, which is the 26th here — the punch lands on the wrong day, in
    // the wrong workweek, and therefore possibly in the wrong pay period. The
    // same parser createTimeEntryCore uses.
    const timeZone = await resolveCompanyTimeZone();
    const startTime = dateInputInTimeZone(data.date, timeZone, "Time entry date");
    if (!startTime || Number.isNaN(startTime.getTime())) throw new Error("A valid time-entry date is required");
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
    await withPayrollWriteTx({ instants: [startTime] }, async (tx) => {
        const priced = await priceManualEntry(tx, data.userId, data.durationHours, acknowledgeZeroRate);
        return (tx as unknown as typeof prisma).timeEntry.create({
            data: {
                projectId: data.projectId,
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                // endTime stays NULL — durationHours is the paid time entered
                // by hand, not a span (see time-expense-core.ts).
                durationHours: data.durationHours,
                ...priced,
                scheduleTaskId
            }
        });
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
    /** Deliberate "book it at $0 and flag it for payroll" — never the default. */
    acknowledgeZeroRate?: boolean;
}) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    const acknowledgeZeroRate = data.acknowledgeZeroRate === true;

    const timeZone = await resolveCompanyTimeZone();
    const startTime = dateInputInTimeZone(data.date, timeZone, "Time entry date");
    if (!startTime || Number.isNaN(startTime.getTime())) throw new Error("A valid time-entry date is required");

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
    await withPayrollWriteTx({ entryIds: [id], instants: [startTime] }, async (tx) => {
        const priced = await priceManualEntry(tx, data.userId, data.durationHours, acknowledgeZeroRate);
        return (tx as unknown as typeof prisma).timeEntry.update({
            where: { id },
            data: {
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                durationHours: data.durationHours,
                ...priced,
                scheduleTaskId
            }
        });
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
}

export async function deleteTimeEntry(id: string) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");

    const entry = await prisma.timeEntry.findUnique({ where: { id }});
    if (!entry) throw new Error("Not found");

    await withPayrollWriteTx({ entryIds: [id] }, (tx) =>
        (tx as unknown as typeof prisma).timeEntry.delete({ where: { id } })
    );

    revalidatePath(`/projects/${entry.projectId}/timeclock`);
    revalidatePath(`/projects/${entry.projectId}/costing`);
}
