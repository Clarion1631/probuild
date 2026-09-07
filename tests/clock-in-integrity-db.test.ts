import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { clockInGuarded, clockInIdentity } from "../src/lib/clock-in-integrity";
import { clockInStore } from "../src/lib/clock-in-integrity-db";
import { acquirePayrollWriteLock, type PayrollTxClient } from "../src/lib/payroll-period";

const url = process.env.CLOCK_IN_TEST_URL;
test("real Postgres serializes retries, guards all writers, retains tombstones and refuses locked periods", { skip: !url && "requires explicit disposable local PostgreSQL" }, async () => {
    assert.ok(url); assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
    process.env.DATABASE_URL = url; process.env.NEXTAUTH_SECRET = "local-clock-in-test-token-secret";
    const { applyClockInIntegrity: applyOriginalClockIn } = await import("../scripts/apply-clock-in-integrity.mjs");
    const db = new PrismaClient({ datasources: { db: { url } } });
    const newerSchema = await db.$queryRawUnsafe<Array<unknown>>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'TimeEntry' AND column_name = 'voidedAt'`);
    const applyClockInIntegrity = newerSchema.length ? (await import("../scripts/apply-time-entry-void.mjs")).applyTimeEntryVoid : applyOriginalClockIn;
    const stamp = Date.now().toString(); const startTime = new Date("2034-01-10T15:00:00Z");
    const user = await db.user.create({ data: { name: "Clock-in test", email: `clock-in-${stamp}@example.test`, role: "FIELD_CREW", status: "ACTIVATED" } });
    const otherUser = await db.user.create({ data: { name: "Other clock-in test", email: `clock-in-other-${stamp}@example.test`, role: "FIELD_CREW" } });
    const project = await db.project.create({ data: { name: `Clock-in test ${stamp}`, isLogistics: true, crew: { connect: { id: user.id } }, client: { create: { name: `Clock-in test ${stamp}`, initials: "CT" } } } });
    let periodId: string | undefined;
    const data = { userId: user.id, projectId: project.id, startTime };
    const punch = (requestId?: string, failAfter = false) => db.$transaction(async tx => {
        const payroll = tx as unknown as PayrollTxClient;
        await acquirePayrollWriteLock(payroll);
        const result = await clockInGuarded(clockInStore(payroll, user.id, startTime, "UTC", () => tx.timeEntry.create({ data })), clockInIdentity({ projectId: project.id, startTime: startTime.toISOString(), ...(requestId ? { requestId } : {}) }));
        if (failAfter) throw Error("rollback requested");
        return result;
    }, { maxWait: 10000, timeout: 10000 });
    try {
        await applyClockInIntegrity(db); await applyClockInIntegrity(db);
        await db.timeEntry.create({ data: { ...data, durationHours: 4 } });
        const results = await Promise.all(Array.from({ length: 6 }, () => punch("same-intent-1234")));
        assert.equal(new Set(results.map(r => r.id)).size, 1);
        assert.equal(await db.clockInRequest.count({ where: { userId: user.id } }), 1);
        await assert.rejects(punch(), /already have an open shift/);
        await assert.rejects(punch("different-1234"), /already have an open shift/);
        const first = results[0];
        await db.timeEntry.update({ where: { id: first.id }, data: { laborCost: 240, burdenCost: 40 } });
        const { signMobileToken } = await import("../src/lib/mobile-auth");
        const { POST } = await import("../src/app/api/time-entries/route");
        const token = await signMobileToken(user as never, "pin");
        const request = (requestId?: string) => new Request("https://example.test/api/time-entries", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, startTime: startTime.toISOString(), ...(requestId ? { requestId } : {}) }) });
        const conflict = await POST(request()); assert.equal(conflict.status, 409);
        const conflictBody = await conflict.json(); assert.equal(conflictBody.code, "ALREADY_CLOCKED_IN");
        const { TIME_ENTRY_CREW_SELECT } = await import("../src/lib/time-entry-projection");
        assert.deepEqual(Object.keys(conflictBody.entry).filter(k => !(k in TIME_ENTRY_CREW_SELECT)), []);
        assert.equal(conflictBody.entry.id, first.id);
        assert.ok(!("laborCost" in conflictBody.entry) && !("burdenCost" in conflictBody.entry));
        const replayResponse = await POST(request("same-intent-1234")); assert.equal(replayResponse.status, 200);
        assert.ok(!("laborCost" in await replayResponse.json()));
        await db.timeEntry.update({ where: { id: first.id }, data: { endTime: new Date("2034-01-10T17:00:00Z"), durationHours: 2 } });
        assert.equal((await punch("same-intent-1234")).id, first.id);
        await db.timeEntry.update({ where: { id: first.id }, data: { userId: otherUser.id } });
        await assert.rejects(punch("same-intent-1234"), /no longer available/, "a reassigned punch cannot be replayed to its former owner");
        await db.timeEntry.update({ where: { id: first.id }, data: { userId: user.id } });
        const attempts = await Promise.allSettled([punch("new-intent-1234"), punch("new-intent-5678")]);
        assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
        await db.timeEntry.deleteMany({ where: { userId: user.id } });
        await assert.rejects(punch("same-intent-1234"), /no longer available/);
        await assert.rejects(punch("rollback-1234", true), /rollback requested/);
        assert.equal(await db.timeEntry.count({ where: { userId: user.id } }), 0);
        assert.equal(await db.clockInRequest.count({ where: { userId: user.id, requestId: "rollback-1234" } }), 0);

        // The index protects writers that bypass the API lock as well.
        const direct = await Promise.allSettled([db.timeEntry.create({ data }), db.timeEntry.create({ data })]);
        assert.equal(direct.filter(r => r.status === "fulfilled").length, 1);
        await db.timeEntry.deleteMany({ where: { userId: user.id } });
        const retained = await punch("locked-replay-1234");
        await db.timeEntry.update({ where: { id: retained.id }, data: { endTime: new Date("2034-01-10T17:00:00Z"), durationHours: 2 } });
        const period = await db.payrollPeriod.create({ data: { periodStartKey: "2034-01-09", periodEndKey: "2034-01-16", periodStart: new Date("2034-01-09T00:00:00Z"), periodEnd: new Date("2034-01-16T00:00:00Z"), lockedAt: new Date(), timeZone: "UTC", exportHash: "test", summaryCsvSnapshot: "test", detailCsvSnapshot: "test" } });
        periodId = period.id;
        assert.equal((await punch("locked-replay-1234")).id, retained.id, "locked-period replay is a read of the original punch");
        // A saved request remains a read after its plan/phase disappears. This
        // exercises the real merged POST ordering, not just the guard helper.
        const oldPlanBody = {projectId:project.id,startTime:startTime.toISOString(),requestId:'old-plan-replay-1234',
            costCodeId:'removed-phase',estimateItemId:'removed-item',suggestionSource:'dispatch',
            suggestedScheduleTaskId:'removed-plan',suggestedCostCodeId:'removed-phase',suggestionOverridden:false};
        const oldPlanIdentity = clockInIdentity(oldPlanBody)!;
        await db.clockInRequest.create({data:{userId:user.id,...oldPlanIdentity,timeEntryId:retained.id}});
        const oldPlanResponse = await POST(new Request('https://example.test/api/time-entries',{
            method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(oldPlanBody),
        }));
        assert.equal(oldPlanResponse.status,200,'replay precedes removed plan/phase and locked-period validation');
        const oldPlanEntry = await oldPlanResponse.json();
        assert.equal(oldPlanEntry.id,retained.id);
        assert.ok(oldPlanEntry.endTime,'a historical replay is not reopened');
        assert.ok(!('laborCost' in oldPlanEntry));
        await assert.rejects(punch("locked-intent-1234"), /locked/i);
        assert.equal(await db.timeEntry.count({ where: { userId: user.id } }), 1);
        assert.equal(await db.clockInRequest.count({ where: { userId: user.id, requestId: "locked-intent-1234" } }), 0);

        // Only this disposable DB: simulate legacy duplicate punches. The
        // apply script refuses without changing either source punch.
        await db.$executeRawUnsafe('DROP INDEX "TimeEntry_one_open_per_user"');
        const duplicates = await Promise.all([db.timeEntry.create({ data }), db.timeEntry.create({ data })]);
        await assert.rejects(applyClockInIntegrity(db), /duplicate open punches/);
        assert.equal(await db.timeEntry.count({ where: { id: { in: duplicates.map(r => r.id) } } }), 2);
    } finally {
        if (periodId) await db.payrollPeriod.delete({ where: { id: periodId } });
        await db.clockInRequest.deleteMany({ where: { userId: user.id } });
        await db.timeEntry.deleteMany({ where: { userId: user.id } });
        await applyClockInIntegrity(db);
        await db.project.delete({ where: { id: project.id } });
        await db.client.delete({ where: { id: project.clientId } });
        await db.user.delete({ where: { id: user.id } });
        await db.user.delete({ where: { id: otherUser.id } });
        await db.$disconnect();
    }
});
