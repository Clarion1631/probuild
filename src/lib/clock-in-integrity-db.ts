import type { Prisma, TimeEntry } from "@prisma/client";
import { assertPeriodUnlockedInTx, type PayrollTxClient } from "./payroll-period";
import type { ClockInStore } from "./clock-in-integrity";

export async function readClockInReplay(db: Pick<Prisma.TransactionClient, "clockInRequest">, userId: string, requestId: string) {
    const request = await db.clockInRequest.findUnique({ where: { userId_requestId: { userId, requestId } }, include: { timeEntry: true } });
    return request ? { requestHash: request.requestHash, entry: request.timeEntry?.userId === userId ? request.timeEntry : null } : null;
}

export function clockInStore(tx: PayrollTxClient, userId: string, startTime: Date, timeZone: string, create: () => Promise<TimeEntry>): ClockInStore<TimeEntry> {
    const db = tx as unknown as Prisma.TransactionClient;
    return {
        // Global payroll lock is already held. This independent per-user lock
        // is taken only by creators, before any TimeEntry row lock; no existing
        // settlement/editor path acquires it in the reverse order.
        lock: async () => { await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `clock-in:${userId}`); },
        replay: (id) => readClockInReplay(db, userId, id),
        open: () => db.timeEntry.findFirst({ where: { userId, endTime: null, durationHours: null }, orderBy: { startTime: "asc" } }),
        assertUnlocked: () => assertPeriodUnlockedInTx(tx, [startTime], { timeZone }),
        create,
        remember: async (requestId, requestHash, entry) => { await db.clockInRequest.create({ data: { userId, requestId, requestHash, timeEntryId: entry.id } }); },
    };
}
