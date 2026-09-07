import type { Prisma, PrismaClient } from "@prisma/client";
import { acquirePayrollLocks, assertPeriodUnlockedInTx, dayLockKey, lockedPeriodFor, type PayrollTxClient } from "./payroll-period";
import { dayKeyInTimeZone } from "./tz-date";
import { settlementCandidateIds, settleDayWithinTx } from "./wa-breaks-db";
import { assertVoidableTimeEntry, TimeEntryVoidError, validateVoidRequest } from "./time-entry-void";

type VoidInput = { id: string; actorId: string; reason: string; expectedUpdatedAt: Date; timeZone: string };
export async function voidTimeEntry(db: PrismaClient, input: VoidInput) {
    const observed = await db.timeEntry.findUnique({ where: { id: input.id } });
    if (!observed) throw new TimeEntryVoidError("Time entry not found", 404, "NOT_FOUND");
    const day = dayKeyInTimeZone(observed.startTime, input.timeZone);
    return db.$transaction(async tx => {
        const payroll = tx as unknown as PayrollTxClient;
        // Stabilize day membership before collecting the rows the meal re-plan
        // may change. No TimeEntry or User lock has been taken at this point.
        await acquirePayrollLocks(payroll, { entryIds: [], dayKeys: [dayLockKey(observed.userId, day)] });
        const ids = [...new Set([input.id, ...await settlementCandidateIds(tx, observed.userId, day)])].sort();
        const instants = await acquirePayrollLocks(payroll, { entryIds: ids, dayKeys: [dayLockKey(observed.userId, day)] });
        const row = await tx.timeEntry.findUniqueOrThrow({ where: { id: input.id } });
        // User locks follow TimeEntry locks, and are sorted like other payroll
        // writers. Lock actor + owner together before settlement reads rates.
        const users = await tx.$queryRaw<Array<{ id: string; role: string; status: string; email: string }>>`
            SELECT id, role, status, email FROM "User" WHERE id IN (${input.actorId}, ${row.userId}) ORDER BY id FOR SHARE`;
        const actor = users.find(user => user.id === input.actorId);
        if (!actor || actor.status === "DISABLED") throw new TimeEntryVoidError("Manager access is required", 403, "FORBIDDEN");
        validateVoidRequest(actor.role, { reason: input.reason, expectedUpdatedAt: input.expectedUpdatedAt.toISOString() });
        if (row.voidedAt) return row; // authenticated replay, never another write/audit
        await assertPeriodUnlockedInTx(payroll, instants, { timeZone: input.timeZone });
        if (row.userId !== observed.userId || dayKeyInTimeZone(row.startTime, input.timeZone) !== day || row.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
            throw new TimeEntryVoidError("This entry changed. Refresh and review it before voiding.", 409, "ENTRY_CHANGED");
        }
        assertVoidableTimeEntry(row);
        // Retained export evidence remains a block even after a period was
        // unlocked. Reuse the canonical workweek envelope with an in-memory
        // locked marker; this does not change the PayrollPeriod record.
        const exports = await tx.payrollPeriod.findMany({ where: { OR: [{ lockedAt: { not: null } }, { exportHash: { not: null } }, { summaryCsvSnapshot: { not: null } }, { detailCsvSnapshot: { not: null } }] } });
        const snapshots = await tx.$queryRaw<Array<{ row: Prisma.JsonObject }>>`SELECT to_jsonb(t) AS row FROM "TimeEntry" t WHERE id = ANY(${ids}::text[]) ORDER BY id`;
        for (const entry of snapshots) {
            if (lockedPeriodFor(exports.map(period => ({ ...period, lockedAt: period.lockedAt ?? new Date(0) })), new Date(String(entry.row.startTime)), { timeZone: input.timeZone })) {
                throw new TimeEntryVoidError("This day has payroll export evidence. Review the payroll reversal before voiding.", 423, "PAYROLL_EXPORTED");
            }
        }
        // Settlement can reprice a neighboring shift. Linked evidence on any
        // affected row needs the same reversal review as the target itself.
        const affected = await tx.timeEntry.findMany({ where: { id: { in: ids }, voidedAt: null } });
        for (const entry of affected) assertVoidableTimeEntry(entry);
        const claim = await tx.timeEntry.updateMany({ where: { id: input.id, updatedAt: row.updatedAt, voidedAt: null }, data: { voidedAt: new Date(), voidedById: actor.id, voidReason: input.reason } });
        if (claim.count !== 1) throw new TimeEntryVoidError("This entry changed. Refresh and try again.", 409, "ENTRY_CHANGED");
        await settleDayWithinTx(tx as never, row.userId, day, null, input.timeZone);
        const after = await tx.$queryRaw<Array<{ row: Prisma.JsonObject }>>`SELECT to_jsonb(t) AS row FROM "TimeEntry" t WHERE id = ANY(${ids}::text[]) ORDER BY id`;
        await tx.auditLog.create({ data: { entity: "TimeEntry", entityId: input.id, action: "VOID", actorId: actor.id, actorEmail: actor.email,
            snapshot: { reason: input.reason, before: snapshots.find(item => item.row.id === input.id)!.row, after: after.find(item => item.row.id === input.id)!.row,
                affectedEntriesBefore: snapshots.map(item => item.row), affectedEntriesAfter: after.map(item => item.row) } } });
        return tx.timeEntry.findUniqueOrThrow({ where: { id: input.id } });
    }, { timeout: 15000 });
}
