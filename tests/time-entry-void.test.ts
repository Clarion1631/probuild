import test from "node:test";
import assert from "node:assert/strict";
import { assertVoidableTimeEntry, validateVoidRequest, TimeEntryVoidError } from "../src/lib/time-entry-void";

test("void requires a manager, a reason and an exact entry version", () => {
    assert.throws(() => validateVoidRequest("FIELD_CREW", { reason: "test", expectedUpdatedAt: new Date().toISOString() }), /manager/i);
    for (const reason of ["", "  ", null, "x".repeat(1001)]) assert.throws(() => validateVoidRequest("ADMIN", { reason, expectedUpdatedAt: new Date().toISOString() }));
    assert.throws(() => validateVoidRequest("ADMIN", { reason: "confirmed test", expectedUpdatedAt: "bad" }));
    for (const body of [null, [], "test", 4]) assert.throws(() => validateVoidRequest("ADMIN", body), (e: unknown) => e instanceof TimeEntryVoidError && e.status === 400);
    assert.equal(validateVoidRequest("MANAGER", { reason: " confirmed test ", expectedUpdatedAt: "2026-09-06T12:00:00Z" }).reason, "confirmed test");
});
test("invoice and QBO evidence refuse void; unlinked source punches remain untouched", () => {
    const row = { invoiceId: null, invoicedAt: null, qbTimeActivityId: null, qbSyncedAt: null, startTime: new Date(), endTime: null, durationHours: null };
    const before = structuredClone(row); assertVoidableTimeEntry(row); assert.deepEqual(row, before);
    for (const field of ["invoiceId", "invoicedAt", "qbTimeActivityId", "qbSyncedAt"]) {
        assert.throws(() => assertVoidableTimeEntry({ ...row, [field]: "linked" }), (e: unknown) => e instanceof TimeEntryVoidError && e.status === 409);
    }
});
