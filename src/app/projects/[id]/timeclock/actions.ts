"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { resolveScheduleTaskIdForPunch } from "@/lib/punch-task-binding";
import { dayKeyFromDateOnly } from "@/lib/company-day";
import { dateInputInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";
import {
    assertManualEntryDelete,
    assertManualEntryWrite,
    assertNotClockGeneratedEntry,
    assertNotLegacyUnitEntry,
    assertUsableDuration,
} from "@/lib/manual-time-entry-auth";
import { withPayrollWriteTx } from "@/lib/payroll-period";
import { settleDayWithinTx, settlementDays } from "@/lib/wa-breaks-db";
import { toNum } from "@/lib/prisma-helpers";
import {
    appendZeroRateReview,
    canAcknowledgeZeroRate,
    readOwnerRatesForUpdate,
    zeroRateBlocks,
    zeroRateManagerMessage,
} from "@/lib/pay-rate-guard";



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
    // Crew write their OWN hours; only the office writes somebody else's.
    // `userId` arrives in the request body, so this is the only thing standing
    // between a crew member and posting hours against a colleague.
    const actor = await assertManualEntryWrite(data.projectId, data.userId);
    const durationHours = assertUsableDuration(data.durationHours);
    const acknowledgeZeroRate =
        data.acknowledgeZeroRate === true && canAcknowledgeZeroRate(actor, data.userId);

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
        const priced = await priceManualEntry(tx, data.userId, durationHours, acknowledgeZeroRate);
        return (tx as unknown as typeof prisma).timeEntry.create({
            data: {
                projectId: data.projectId,
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                // endTime stays NULL — durationHours is the paid time entered
                // by hand, not a span (see time-expense-core.ts).
                durationHours,
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
    const durationHours = assertUsableDuration(data.durationHours);
    const timeZone = await resolveCompanyTimeZone();
    const startTime = dateInputInTimeZone(data.date, timeZone, "Time entry date");
    if (!startTime || Number.isNaN(startTime.getTime())) throw new Error("A valid time-entry date is required");

    // Resolve against the STORED row: this action never writes projectId, so a
    // supplied one could attach another project's task, and a null estimate item
    // would drop a good mobile binding on an ordinary hours edit.
    const existing = await prisma.timeEntry.findUnique({
        where: { id },
        select: {
            projectId: true, userId: true, startTime: true, endTime: true,
            estimateItemId: true, durationHours: true, laborCost: true,
        },
    });
    if (!existing) throw new Error("Not found");
    // Authorized against the STORED row's project and owner, plus the target
    // this edit would move it to — an id proves nothing about what it points at.
    assertNotLegacyUnitEntry(existing);
    assertNotClockGeneratedEntry(existing);
    const actor = await assertManualEntryWrite(existing.projectId, existing.userId);
    await assertManualEntryWrite(existing.projectId, data.userId);
    const acknowledgeZeroRate =
        data.acknowledgeZeroRate === true && canAcknowledgeZeroRate(actor, data.userId);
    const scheduleTaskId = await resolveScheduleTaskIdForPunch({
        userId: data.userId,
        projectId: existing.projectId,
        dayKey: dayKeyFromDateOnly(data.date),
        estimateItemId: existing.estimateItemId,
    });

    // Both dates — editing inside a locked period, and moving a punch into one.
    // Both DAYS too: an edit can move an entry off one day and onto another, and
    // each day's meal deduction is computed from everything left on it. The day
    // keys go in the target so their advisory locks are taken up front, in the
    // documented payroll -> day -> row order.
    const days = settlementDays([existing.startTime, startTime]);
    const owners = Array.from(new Set([existing.userId, data.userId]));
    await withPayrollWriteTx({ entryIds: [id], instants: [startTime], dayKeys: days }, async (tx) => {
        const priced = await priceManualEntry(tx, data.userId, durationHours, acknowledgeZeroRate);
        const updated = await (tx as unknown as typeof prisma).timeEntry.update({
            where: { id },
            data: {
                userId: data.userId,
                costCodeId: data.costCodeId,
                startTime,
                durationHours,
                ...priced,
                scheduleTaskId
            }
        });
        // Re-settle inside the SAME transaction: if this edit changed what a day
        // contains, that day's meal deduction / shiftHours / mealOutcome are now
        // stale, and a settlement that ran afterwards in its own transaction
        // could be interleaved with another writer.
        for (const owner of owners) {
            for (const dayKey of days) await settleDayWithinTx(tx as never, owner, dayKey);
        }
        return updated;
    });

    revalidatePath(`/projects/${data.projectId}/timeclock`);
    revalidatePath(`/projects/${data.projectId}/costing`);
}

export async function deleteTimeEntry(id: string) {
    // Authorized against the STORED row: this used to be a bare session check,
    // so any signed-in account could delete ANY entry in the system by id.
    const { entry } = await assertManualEntryDelete(id);
    assertNotClockGeneratedEntry(entry);

    const days = settlementDays([entry.startTime]);
    await withPayrollWriteTx({ entryIds: [id], dayKeys: days }, async (tx) => {
        await (tx as unknown as typeof prisma).timeEntry.delete({ where: { id } });
        // Removing hours can drop a day back under the meal-break threshold, so
        // the day is re-planned here rather than left describing a shift that
        // no longer exists.
        for (const dayKey of days) await settleDayWithinTx(tx as never, entry.userId, dayKey);
    });

    revalidatePath(`/projects/${entry.projectId}/timeclock`);
    revalidatePath(`/projects/${entry.projectId}/costing`);
}
