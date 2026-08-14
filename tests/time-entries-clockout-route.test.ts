/**
 * Route-level tests for PUT /api/time-entries — the mobile app's actual
 * clock-out call (apps/mobile/lib/api.ts timeEntries.clockOut -> PUT, not the
 * PATCH [id] edit-flow). Uses the same dependency-injection pattern as
 * tests/pay-period-summary-route.test.ts.
 *
 * time-entries/route.ts imports mobile-auth.ts STATICALLY (unlike the DI'd
 * mobile/pay-period-summary route), and mobile-auth.ts throws at module load
 * if NEXTAUTH_SECRET is unset — so it must be set before this file's dynamic
 * import below. The value is never used for real verification here; every
 * test injects its own `authenticate`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClockOutDependencies, ClockOutTimeEntryRow } from "../src/app/api/time-entries/route";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-time-entries-route-tests";

// No top-level await (tsx transforms this test file to CJS) — the dynamic
// import() call itself still only fires once this line of module-level code
// runs, which is after the env var assignment above, so mobile-auth.ts's
// module-load guard is already satisfied by the time it evaluates.
const routeModulePromise = import("../src/app/api/time-entries/route");

const START = new Date("2026-08-10T15:00:00.000Z");

function baseEntry(overrides: Partial<ClockOutTimeEntryRow> = {}): ClockOutTimeEntryRow {
    return {
        id: "te1",
        userId: "u1",
        projectId: "p1",
        startTime: START,
        notes: null,
        ...overrides,
    };
}

function createDeps(overrides: {
    role?: string;
    authOk?: boolean;
    entry?: ClockOutTimeEntryRow | null;
    isLogistics?: boolean;
    ownerRates?: { hourlyRate: number; burdenRate: number } | null;
} = {}) {
    const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
    const dependencies: ClockOutDependencies = {
        authenticate: async () =>
            overrides.authOk === false
                ? { ok: false, status: 401, error: "Unauthorized" }
                : { ok: true, user: { id: "u1", role: overrides.role ?? "FIELD_CREW", hourlyRate: 20, burdenRate: 5 } },
        findTimeEntry: async () => (overrides.entry !== undefined ? overrides.entry : baseEntry()),
        findProjectIsLogistics: async () => overrides.isLogistics ?? false,
        findOwnerRates: async () =>
            overrides.ownerRates !== undefined ? overrides.ownerRates : { hourlyRate: 20, burdenRate: 5 },
        updateTimeEntry: async (id, data) => {
            updateCalls.push({ id, data });
            return { id, ...data };
        },
    };
    return { dependencies, updateCalls };
}

function putReq(body: unknown) {
    return new Request("https://example.test/api/time-entries", {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

test("propagates the authenticate() failure status/error unchanged", async () => {
    const { dependencies } = createDeps({ authOk: false });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 401);
});

test("400 when id is missing", async () => {
    const { dependencies } = createDeps();
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({}));
    assert.equal(res.status, 400);
});

test("404 when the entry does not exist", async () => {
    const { dependencies } = createDeps({ entry: null });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 404);
});

test("403 when a non-owner, non-manager tries to clock someone else out", async () => {
    const { dependencies } = createDeps({ role: "FIELD_CREW", entry: baseEntry({ userId: "someone-else" }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 403);
});

test("logistics clock-out with no existing/supplied notes -> 400 LOGISTICS_NOTES_REQUIRED, no update issued", async () => {
    const { dependencies, updateCalls } = createDeps({ isLogistics: true, entry: baseEntry({ notes: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "LOGISTICS_NOTES_REQUIRED");
    assert.equal(updateCalls.length, 0);
});

test("logistics clock-out with notes already on the entry -> closes fine, notes left untouched", async () => {
    const { dependencies, updateCalls } = createDeps({
        isLogistics: true,
        entry: baseEntry({ notes: "Drove to the shop for materials" }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal("notes" in updateCalls[0].data, false);
});

test("logistics clock-out with notes supplied in the request -> closes fine, notes persisted trimmed", async () => {
    const { dependencies, updateCalls } = createDeps({ isLogistics: true, entry: baseEntry({ notes: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", notes: "  Picked up lumber from the yard  " }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].data.notes, "Picked up lumber from the yard");
});

test("non-logistics project clock-out is unaffected: closes fine with no notes at all", async () => {
    const { dependencies, updateCalls } = createDeps({ isLogistics: false, entry: baseEntry({ notes: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal("notes" in updateCalls[0].data, false);
});

// mobile's clockOut() also sends `mealSkipped` (WA L&I meal-break attestation).
// It is not read/persisted by this route today (pre-existing gap, not part of
// this change) — this test only guards that the new notes logic doesn't
// misinterpret it or otherwise break the request when it's present.
test("mealSkipped in the body does not interfere with the clock-out or the notes check", async () => {
    const { dependencies, updateCalls } = createDeps({ isLogistics: false, entry: baseEntry({ notes: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: true }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal("notes" in updateCalls[0].data, false);
});

test("mealSkipped + logistics with no notes still correctly rejects on the notes rule", async () => {
    const { dependencies, updateCalls } = createDeps({ isLogistics: true, entry: baseEntry({ notes: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: true }));
    assert.equal(res.status, 400);
    assert.equal(updateCalls.length, 0);
});

test("computes durationHours/laborCost/burdenCost from the OWNER's rates, not the editor's", async () => {
    const { dependencies, updateCalls } = createDeps({
        role: "MANAGER",
        entry: baseEntry({ userId: "owner-1", startTime: new Date("2026-08-10T15:00:00.000Z") }),
        ownerRates: { hourlyRate: 50, burdenRate: 10 },
    });
    // requester (u1, MANAGER) has hourlyRate 20/burdenRate 5 per createDeps default auth — must not be used.
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T19:00:00.000Z" }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data;
    assert.equal(data.durationHours, 4);
    assert.equal(data.laborCost, 200); // 4 * 50
    assert.equal(data.burdenCost, 40); // 4 * 10
    assert.equal(data.editedByManagerId, "u1");
});
