import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { voidTimeEntry } from "../src/lib/time-entry-void-db";
import { nonVoidedTimeEntryWhere } from "../src/lib/time-entry-void";
import { readClockInReplay } from "../src/lib/clock-in-integrity-db";
import { acquirePayrollWriteLock, assertEntriesUnlockedInTx, type PayrollTxClient } from "../src/lib/payroll-period";
import { loadDayEntries, settleDayWithinTx } from "../src/lib/wa-breaks-db";

const url = process.env.TIME_ENTRY_VOID_TEST_URL;
function signal() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
function sourceFields(row: Record<string, unknown>) { const copy = { ...row }; for (const key of ["voidedAt", "voidedById", "voidReason", "updatedAt"]) delete copy[key]; return copy; }

test("void preserves paid source evidence, settles meals, excludes payroll/billing, and serializes competing writers", { skip: !url && "requires disposable local PostgreSQL" }, async () => {
    assert.ok(url); assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
    assert.match(new URL(url).pathname, /void_test|probuild_migrations/);
    process.env.DATABASE_URL = url; process.env.NEXTAUTH_SECRET = "local-void-test-token";
    const db = new PrismaClient({ datasources: { db: { url } } });
    const tag = Date.now().toString(); const day = "2034-01-10";
    const actor = await db.user.create({ data: { name: "Void manager", email: `void-admin-${tag}@example.test`, role: "ADMIN", status: "ACTIVATED" } });
    const worker = await db.user.create({ data: { name: "Void worker", email: `void-worker-${tag}@example.test`, role: "FIELD_CREW", status: "ACTIVATED", payType: "HOURLY", hourlyRate: 30, burdenRate: 5 } });
    const project = await db.project.create({ data: { name: "Void test project", isLogistics: true, crew: { connect: { id: worker.id } }, client: { create: { name: "Void test client", initials: "VT" } } } });
    const estimate = await db.estimate.create({ data: { projectId: project.id, title: "Void test", code: `VOID-${tag}`, totalAmount: 0, balanceDue: 0 } });
    const co = await db.changeOrder.create({ data: { projectId: project.id, estimateId: estimate.id, code: `VOID-CO-${tag}`, title: "Void test actuals", pricingType: "COST_PLUS", status: "Approved" } });
    const made: string[] = []; const periods: string[] = [];
    const create = async (start: string, end: string | null, overrides: Record<string, unknown> = {}) => {
        const row = await db.timeEntry.create({ data: { userId: worker.id, projectId: project.id, changeOrderId: co.id, isBillable: true,
            startTime: new Date(`${day}T${start}Z`), endTime: end ? new Date(`${day}T${end}Z`) : null,
            ...(end ? { durationHours: 5.5, shiftHours: 6, mealDeductionHours: .5, mealOutcome: "AUTO_DEDUCTED", laborCost: 165, burdenCost: 27.5 } : {}), ...overrides } });
        made.push(row.id); return row;
    };
    const raw = async (id: string) => (await db.$queryRaw<Array<{ row: Record<string, unknown> }>>`SELECT to_jsonb(t) AS row FROM "TimeEntry" t WHERE id = ${id}`)[0].row;
    const perform = async (id: string, reason = "Confirmed test entry") => {
        const row = await db.timeEntry.findUniqueOrThrow({ where: { id } });
        return voidTimeEntry(db, { id, actorId: actor.id, reason, expectedUpdatedAt: row.updatedAt, timeZone: "UTC" });
    };
    try {
        const { applyTimeEntryVoid } = await import("../scripts/apply-time-entry-void.mjs");
        await applyTimeEntryVoid(db); await applyTimeEntryVoid(db);
        const original = await create("08:00:00", "14:00:00");
        const neighbor = await create("14:15:00", "17:15:00", { durationHours: 2.5, shiftHours: 3, laborCost: 75, burdenCost: 12.5 });
        await db.clockInRequest.create({ data: { userId: worker.id, requestId: `void-intent-${tag}`, requestHash: "original-hash", timeEntryId: original.id } });
        const before = await raw(original.id);
        await assert.rejects(db.timeEntry.update({ where: { id: original.id }, data: { voidedAt: new Date(), voidedById: actor.id } }), /TimeEntry_void_metadata_complete/);
        await assert.rejects(db.timeEntry.update({ where: { id: original.id }, data: { voidedAt: new Date(), voidedById: actor.id, voidReason: "test", durationHours: 0 } }), /void cannot alter source/);
        const { signMobileToken } = await import("../src/lib/mobile-auth");
        const { POST } = await import("../src/app/api/time-entries/[id]/void/route");
        const workerToken = await signMobileToken(worker as never, "pin");
        const actorToken = await signMobileToken(actor as never, "pin");
        const request = (token: string, body: unknown) => new Request("https://example.test/api/time-entries/void", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        const params = { params: Promise.resolve({ id: original.id }) };
        assert.equal((await POST(request(workerToken, { reason: "test", expectedUpdatedAt: original.updatedAt.toISOString() }), params)).status, 403);
        assert.equal((await POST(request(actorToken, { reason: "test" }), params)).status, 400);
        assert.deepEqual(await raw(original.id), before);
        const actorHeld = signal(), releaseActor = signal(); let revokedVoidDone = false;
        const revoke = db.$transaction(async tx => {
            await tx.user.update({ where: { id: actor.id }, data: { status: "DISABLED" } });
            actorHeld.resolve(); await releaseActor.promise;
        }, { timeout: 10000 });
        await actorHeld.promise;
        const revokedVoid = perform(original.id).then(() => true, () => false).finally(() => { revokedVoidDone = true; });
        await new Promise(r => setTimeout(r, 120)); assert.equal(revokedVoidDone, false);
        releaseActor.resolve(); await revoke; assert.equal(await revokedVoid, false);
        assert.deepEqual(await raw(original.id), before, "revoked actor cannot write using stale authority");
        await db.user.update({ where: { id: actor.id }, data: { status: "ACTIVATED" } });
        await perform(original.id);
        const after = await raw(original.id);
        assert.deepEqual(sourceFields(after), sourceFields(before), "all original punch/meal/cost fields survive");
        assert.equal(after.voidReason, "Confirmed test entry"); assert.equal(after.voidedById, actor.id);
        const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "TimeEntry", entityId: original.id, action: "VOID" } });
        assert.equal(audit.actorId, actor.id); assert.equal(audit.actorEmail, actor.email);
        assert.deepEqual((audit.snapshot as any).before, before); assert.deepEqual((audit.snapshot as any).after, after);
        assert.equal((await db.timeEntry.findUniqueOrThrow({ where: { id: neighbor.id } })).durationHours, 3, "remaining three-hour shift no longer owes a meal");
        assert.equal((await readClockInReplay(db, worker.id, `void-intent-${tag}`))!.entry, null);
        await perform(original.id); assert.equal(await db.auditLog.count({ where: { entityId: original.id } }), 1);
        const replayResponse = await POST(request(actorToken, { reason: "Confirmed test entry", expectedUpdatedAt: original.updatedAt.toISOString() }), params);
        assert.equal(replayResponse.status, 200);
        const replayBody = await replayResponse.json();
        assert.equal(replayBody.id, original.id); assert.ok(replayBody.voidedAt);
        assert.ok(!("laborCost" in replayBody)); assert.ok(!("burdenCost" in replayBody));
        await assert.rejects(db.timeEntry.update({ where: { id: original.id }, data: { notes: "erase evidence" } }), /TIME_ENTRY_VOIDED/);
        await assert.rejects(db.timeEntry.delete({ where: { id: original.id } }), /TIME_ENTRY_VOIDED/);
        await assert.rejects(db.$transaction(tx => assertEntriesUnlockedInTx(tx as unknown as PayrollTxClient, [original.id], { timeZone: "UTC" })), /voided/);
        assert.equal((await loadDayEntries(worker.id, day, "", "UTC")).length, 1);
        const { loadGustoExport } = await import("../src/lib/gusto-export-db");
        const payroll = await loadGustoExport(new Date("2034-01-09T00:00:00Z"), new Date("2034-01-16T00:00:00Z"), { timeZone: "UTC" });
        assert.deepEqual(payroll.detail.filter(row => row.user.id === worker.id).map(row => row.entryId), [neighbor.id]);
        const { loadCostPlusActuals } = await import("../src/lib/billing-core");
        const bill = await db.$transaction(tx => loadCostPlusActuals(tx, co.id, new Date("2034-01-11"), 0, 0, true));
        assert.deepEqual(bill.timeEntries.map(row => row.id), [neighbor.id]);

        // Audit insertion failure must roll back the void AND meal replanning.
        const rollback = await create("18:00:00", "23:00:00", { shiftHours: 5, durationHours: 5, mealDeductionHours: 0 });
        const rollbackBefore = await raw(rollback.id), neighborBefore = await raw(neighbor.id);
        await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD CONSTRAINT "Void_test_audit_failure" CHECK (snapshot->>'reason' IS DISTINCT FROM 'rollback-test')`);
        await assert.rejects(perform(rollback.id, "rollback-test"));
        assert.deepEqual(await raw(rollback.id), rollbackBefore); assert.deepEqual(await raw(neighbor.id), neighborBefore);
        await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" DROP CONSTRAINT "Void_test_audit_failure"`);

        // A real meal settlement owns the day before void. Its committed
        // recalculation invalidates the stale reviewed version; a fresh review
        // preserves that final source, then replans only the remaining rows.
        const meal = await create("00:00:00", "02:00:00");
        const mealHeld = signal(), releaseMeal = signal(); let mealVoidDone = false;
        const mealSettlement = db.$transaction(async tx => {
            await settleDayWithinTx(tx as never, worker.id, day, null, "UTC");
            mealHeld.resolve(); await releaseMeal.promise;
        }, { timeout: 10000 });
        await mealHeld.promise;
        const mealVoid = perform(meal.id).then(() => true, () => false).finally(() => { mealVoidDone = true; });
        await new Promise(r => setTimeout(r, 120)); assert.equal(mealVoidDone, false, "void waits for meal settlement");
        releaseMeal.resolve(); await mealSettlement; assert.equal(await mealVoid, false, "changed meal source needs fresh review");
        const settledMeal = await raw(meal.id);
        assert.equal(settledMeal.durationHours, 2);
        await perform(meal.id);
        assert.deepEqual(sourceFields(await raw(meal.id)), sourceFields(settledMeal));

        // The retained original open punch cannot occupy the unique slot.
        const open = await create("23:10:00", null); await perform(open.id);
        await create("23:20:00", null);
        assert.equal(await db.timeEntry.count({ where: nonVoidedTimeEntryWhere({ userId: worker.id, endTime: null, durationHours: null }) }), 1);
        const { applyClockInIntegrity } = await import("../scripts/apply-clock-in-integrity.mjs");
        await applyClockInIntegrity(db); // historical apply must preserve newer predicate

        // Billing holds the exact canonical row locks, then stamps linkage.
        const locked = signal(), release = signal(); let voidDone = false;
        const billing = db.$transaction(async tx => {
            await loadCostPlusActuals(tx, co.id, new Date("2034-01-11"), 0, 0, true);
            locked.resolve(); await release.promise;
            await tx.timeEntry.update({ where: { id: rollback.id }, data: { invoiceId: "test-billing-link" } });
        }, { timeout: 10000 });
        await locked.promise;
        const competingVoid = perform(rollback.id).then(() => ({ ok: true }), error => ({ ok: false, error })).finally(() => { voidDone = true; });
        await new Promise(r => setTimeout(r, 120)); assert.equal(voidDone, false, "void waits behind billing row lock");
        release.resolve(); await billing; assert.equal((await competingVoid).ok, false);
        assert.equal((await db.timeEntry.findUniqueOrThrow({ where: { id: rollback.id } })).voidedAt, null);
        await assert.rejects(perform(rollback.id), /linked/);
        await assert.rejects(perform(neighbor.id), /linked/, "linked neighboring meal source also requires reversal review");

        // A payroll freeze wins the shared/exclusive lock race, then void must
        // refuse rather than alter the frozen source or any settlement row.
        const held = signal(), releasePayroll = signal(); let attempted = false;
        const freezing = db.$transaction(async tx => {
            await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('payroll-period'))"); held.resolve(); await releasePayroll.promise;
            const period = await tx.payrollPeriod.create({ data: { periodStartKey: "2034-01-09", periodEndKey: "2034-01-16", periodStart: new Date("2034-01-09"), periodEnd: new Date("2034-01-16"), lockedAt: new Date(), timeZone: "UTC", exportHash: "test", summaryCsvSnapshot: "test", detailCsvSnapshot: "test" } }); periods.push(period.id);
        }, { timeout: 10000 });
        await held.promise; const duringFreeze = perform(neighbor.id).then(() => true, () => false).finally(() => { attempted = true; });
        await new Promise(r => setTimeout(r, 120)); assert.equal(attempted, false); releasePayroll.resolve(); await freezing; assert.equal(await duringFreeze, false);
        await db.payrollPeriod.update({ where: { id: periods[0] }, data: { lockedAt: null } });
        await assert.rejects(perform(neighbor.id), /export evidence/, "retained exported period remains protected after unlock");
    } finally {
        // Disposable fixture cleanup only. ACCESS EXCLUSIVE is held until the
        // immutable trigger is re-enabled, so no other connection sees it off.
        await db.$transaction(async tx => {
            await tx.$executeRawUnsafe(`ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "Void_test_audit_failure"`);
            await tx.$executeRawUnsafe(`ALTER TABLE "TimeEntry" DISABLE TRIGGER "TimeEntry_preserve_voided"`);
            await tx.clockInRequest.deleteMany({ where: { userId: worker.id } });
            await tx.timeEntry.deleteMany({ where: { id: { in: made } } });
            await tx.$executeRawUnsafe(`ALTER TABLE "TimeEntry" ENABLE TRIGGER "TimeEntry_preserve_voided"`);
            await tx.auditLog.deleteMany({ where: { entity: "TimeEntry", entityId: { in: made } } });
            await tx.payrollPeriod.deleteMany({ where: { id: { in: periods } } });
        });
        await db.changeOrder.delete({ where: { id: co.id } }); await db.estimate.delete({ where: { id: estimate.id } });
        await db.project.delete({ where: { id: project.id } }); await db.client.delete({ where: { id: project.clientId } });
        await db.user.deleteMany({ where: { id: { in: [actor.id, worker.id] } } }); await db.$disconnect();
    }
});
