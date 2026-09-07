import test from "node:test";
import assert from "node:assert/strict";
import { clockInIdentity, clockInGuarded, ClockInConflict, type ClockInStore } from "../src/lib/clock-in-integrity";

const body = { projectId: "shop", startTime: "2026-09-08T15:00:00Z", requestId: "intent-12345678" };
function fixture() {
    const rows: any[] = []; const requests = new Map<string, any>(); const calls: string[] = [];
    const store: ClockInStore<any> = {
        lock: async () => { calls.push("lock"); },
        replay: async (id) => requests.get(id) ?? null,
        open: async () => rows.find(r => r.endTime === null && r.durationHours === null) ?? null,
        assertUnlocked: async () => { calls.push("payroll"); },
        create: async () => { calls.push("create"); const row = { id: String(rows.length + 1), userId: "worker", endTime: null, durationHours: null }; rows.push(row); return row; },
        remember: async (id, hash, entry) => { requests.set(id, { requestHash: hash, entry }); },
    };
    return { store, rows, requests, calls };
}
test("same intent replays original even after close; changed payload conflicts", async () => {
    const f = fixture(); const identity = clockInIdentity(body);
    const row = await clockInGuarded(f.store, identity);
    row.endTime = new Date(); row.durationHours = 2;
    assert.equal(await clockInGuarded(f.store, identity), row);
    assert.equal(f.calls.filter(x => x === "create").length, 1);
    await assert.rejects(clockInGuarded(f.store, clockInIdentity({ ...body, projectId: "other" })), (e: unknown) => e instanceof ClockInConflict && e.code === "REQUEST_ID_CONFLICT");
});
test("other open blocks legacy and keyed requests; manual hours do not", async () => {
    const f = fixture(); f.rows.push({ id: "manual", endTime: null, durationHours: 4 });
    await clockInGuarded(f.store, clockInIdentity(body));
    for (const input of [{ projectId: "shop" }, { ...body, requestId: "second-12345678" }]) {
        await assert.rejects(clockInGuarded(f.store, clockInIdentity(input)), (e: unknown) => e instanceof ClockInConflict && e.code === "ALREADY_CLOCKED_IN");
    }
});
test("payroll refusal never creates a row/request; deleted replay is a tombstone", async () => {
    const f = fixture(); f.store.assertUnlocked = async () => { throw Error("locked payroll"); };
    await assert.rejects(clockInGuarded(f.store, clockInIdentity(body)), /locked payroll/);
    assert.equal(f.rows.length, 0); assert.equal(f.requests.size, 0);
    const identity = clockInIdentity(body)!;
    f.requests.set(identity.requestId, { requestHash: identity.requestHash, entry: null });
    await assert.rejects(clockInGuarded(f.store, identity), (e: unknown) => e instanceof ClockInConflict && e.code === "CLOCK_IN_UNAVAILABLE");
});
test("identity is allowlisted/order independent and validates keys and dates", () => {
    assert.equal(clockInIdentity({ ignored: 1, ...body })?.requestHash, clockInIdentity({ requestId: body.requestId, startTime: body.startTime, projectId: body.projectId })?.requestHash);
    assert.equal(clockInIdentity({ projectId: "shop" }), null);
    for (const requestId of ["", "bad key!!", null, 3]) assert.throws(() => clockInIdentity({ ...body, requestId }));
    assert.throws(() => clockInIdentity({ ...body, startTime: "bad date" }));
});
