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
        endTime: null,
        notes: null,
        reviewReason: null,
        ...overrides,
    };
}

function createDeps(overrides: {
    role?: string;
    authOk?: boolean;
    entry?: ClockOutTimeEntryRow | null;
    isLogistics?: boolean;
    ownerRates?: { hourlyRate: number; burdenRate: number; role: string; name: string | null } | null;
    /** Locked pay periods the PUT handler must refuse to write into (src/lib/payroll-period.ts). */
    lockedPeriods?: import("../src/lib/payroll-period").LockedPeriodRow[];
    /** Simulate a concurrent PUT winning the atomic close guard first. */
    closeRaceLost?: boolean;
    dayEntries?: import("../src/lib/wa-breaks").DayEntry[];
} = {}) {
    const updateCalls: Array<{ id: string; userId: string; data: Record<string, unknown> }> = [];
    const dependencies: ClockOutDependencies = {
        authenticate: async () =>
            overrides.authOk === false
                ? { ok: false, status: 401, error: "Unauthorized" }
                : { ok: true, user: { id: "u1", role: overrides.role ?? "FIELD_CREW", hourlyRate: 20, burdenRate: 5 } },
        findTimeEntry: async () => (overrides.entry !== undefined ? overrides.entry : baseEntry()),
        findProjectIsLogistics: async () => overrides.isLogistics ?? false,
        findOwnerRates: async () =>
            overrides.ownerRates !== undefined
                ? overrides.ownerRates
                : { hourlyRate: 20, burdenRate: 5, role: "FIELD_CREW", name: "Owner" },
        loadLockedPeriods: async () => overrides.lockedPeriods ?? [],
        // No other entries on the day unless a test says so — the WA meal rule
        // (src/lib/wa-breaks.ts) then sees only the closing entry.
        findDayEntries: async () => overrides.dayEntries ?? [],
        settleDay: async () => 0,
        flagSettlementFailed: async () => {},
        closeTimeEntry: async (id, userId, data) => {
            updateCalls.push({ id, userId, data });
            if (overrides.closeRaceLost) {
                const current = baseEntry({ endTime: new Date("2026-08-10T19:00:00.000Z") });
                return { ok: false, current };
            }
            return { ok: true, entry: { id, userId, ...data } };
        },
    };
    return { dependencies, updateCalls };
}

// Tests that don't care about the clock-out instant get a same-day endTime
// (START + 4h) injected — the route now refuses a punch longer than 24h, and
// the fixture entry starts on 2026-08-10, so "defaults to now" would trip it.
// Pass { raw: true } to send the body untouched.
function putReq(body: unknown, opts: { raw?: boolean } = {}) {
    const payload =
        !opts.raw && body && typeof body === "object" && !("endTime" in (body as object))
            ? { ...(body as object), endTime: new Date(START.getTime() + 4 * 3_600_000).toISOString() }
            : body;
    return new Request("https://example.test/api/time-entries", {
        method: "PUT",
        body: JSON.stringify(payload),
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
// It does not interfere with the unrelated notes check when both are present.
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

// ── mealSkipped persistence (WA meal-break voluntary waiver) ──────────────
// PUT is the mobile clock-out call, and always closes the entry, so every
// request here is a clock-out mutation by construction.

const WAIVER_NOTE = "Worked through WA meal break (voluntary waiver recorded at clock-out)";

test("mealSkipped: true persists it and sets needsReview + reviewReason", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ reviewReason: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: true, endTime: new Date(START.getTime() + 8 * 3_600_000).toISOString() }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data;
    assert.equal(data.mealSkipped, true);
    assert.equal(data.needsReview, true);
    assert.equal(data.reviewReason, WAIVER_NOTE);
});

test("mealSkipped: false persists false and does NOT set needsReview", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: false }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data;
    assert.equal(data.mealSkipped, false);
    assert.equal("needsReview" in data, false);
    assert.equal("reviewReason" in data, false);
});

test("mealSkipped absent leaves mealSkipped/needsReview/reviewReason untouched", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    // A 3h punch: no meal is owed, so the automatic-break model has nothing to
    // say and the legacy "absent = untouched" contract holds verbatim.
    const res = await PUT(putReq({ id: "te1", endTime: new Date(START.getTime() + 3 * 3_600_000).toISOString() }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data;
    assert.equal("mealSkipped" in data, false);
    assert.equal("needsReview" in data, false);
    assert.equal("reviewReason" in data, false);
});

test("non-boolean mealSkipped value is ignored", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: "true", endTime: new Date(START.getTime() + 3 * 3_600_000).toISOString() }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data;
    assert.equal("mealSkipped" in data, false);
    assert.equal("needsReview" in data, false);
    assert.equal("reviewReason" in data, false);
});

test("mealSkipped: true appends to an existing reviewReason instead of clobbering it", async () => {
    const { dependencies, updateCalls } = createDeps({
        entry: baseEntry({ reviewReason: "Flagged for missing GPS ping" }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: true, endTime: new Date(START.getTime() + 8 * 3_600_000).toISOString() }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].data.reviewReason, `Flagged for missing GPS ping; ${WAIVER_NOTE}`);
});

test("mealSkipped: true repeated does not duplicate the waiver reason", async () => {
    const { dependencies, updateCalls } = createDeps({
        entry: baseEntry({ reviewReason: WAIVER_NOTE }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: true, endTime: new Date(START.getTime() + 8 * 3_600_000).toISOString() }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].data.reviewReason, WAIVER_NOTE);
    assert.equal(updateCalls[0].data.needsReview, true);
});

test("mealSkipped: false after true removes the waiver reason and clears needsReview when nothing else justifies review", async () => {
    const { dependencies, updateCalls } = createDeps({
        entry: baseEntry({ reviewReason: WAIVER_NOTE }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: false }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].data.reviewReason, "");
    assert.equal(updateCalls[0].data.needsReview, false);
});

test("mealSkipped: false alongside another reviewReason removes only the waiver note, leaving the other reason's review flag alone", async () => {
    const { dependencies, updateCalls } = createDeps({
        entry: baseEntry({ reviewReason: `Flagged for missing GPS ping; ${WAIVER_NOTE}` }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", mealSkipped: false }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].data.reviewReason, "Flagged for missing GPS ping");
    assert.equal("needsReview" in updateCalls[0].data, false);
});

// PUT always ends the shift (endTime defaults to now), so there is no "non-clock-out
// edit" call site to exercise through this route — that guard is covered directly
// on the shared applyMealSkippedWaiver() helper in tests/logistics-time-entry.test.ts,
// which the PATCH /api/time-entries/[id] edit flow also uses (defense in depth,
// mirroring the logistics-notes check above).

test("computes durationHours/laborCost/burdenCost from the OWNER's rates, not the editor's", async () => {
    const { dependencies, updateCalls } = createDeps({
        role: "MANAGER",
        entry: baseEntry({ userId: "owner-1", startTime: new Date("2026-08-10T15:00:00.000Z") }),
        ownerRates: { hourlyRate: 50, burdenRate: 10, role: "FIELD_CREW", name: "Owner One" },
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

// ── clock-out hardening: re-close, future/invalid endTime ────────────────

test("re-clock-out on an already-closed entry is rejected with 409 ALREADY_CLOCKED_OUT, and the closed entry is included for client reconciliation", async () => {
    const closedEntry = baseEntry({ endTime: new Date("2026-08-10T19:00:00.000Z") });
    const { dependencies, updateCalls } = createDeps({ entry: closedEntry });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T20:00:00.000Z" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ALREADY_CLOCKED_OUT");
    assert.deepEqual(body.entry, JSON.parse(JSON.stringify(closedEntry)));
    assert.equal(updateCalls.length, 0);
});

test("a concurrent close race lost at the DB-level guard still surfaces as 409 ALREADY_CLOCKED_OUT with the entry's current state", async () => {
    // The in-memory already-closed check above passes (entry looks open),
    // but a concurrent PUT wins the atomic updateMany guard first.
    const { dependencies, updateCalls } = createDeps({ closeRaceLost: true, entry: baseEntry({ endTime: null }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T19:00:00.000Z" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ALREADY_CLOCKED_OUT");
    assert.equal(body.entry.id, "te1");
    assert.equal(body.entry.endTime, "2026-08-10T19:00:00.000Z");
    // The DB guard was actually attempted (this is what caught the race,
    // not the in-memory check, which had already passed).
    assert.equal(updateCalls.length, 1);
});

test("closeTimeEntry's atomic guard scopes to the entry's own stored userId, not the requester's", async () => {
    const { dependencies, updateCalls } = createDeps({
        role: "MANAGER",
        entry: baseEntry({ userId: "owner-1" }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].userId, "owner-1");
});

test("a future endTime beyond the clock-skew allowance is rejected with 400", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour ahead
    const res = await PUT(putReq({ id: "te1", endTime: farFuture }));
    assert.equal(res.status, 400);
    assert.equal(updateCalls.length, 0);
});

test("an endTime within the small clock-skew allowance is accepted", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date(Date.now() - 3_600_000) }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const withinSkew = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 minutes ahead
    const res = await PUT(putReq({ id: "te1", endTime: withinSkew }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
});

test("endTime equal to startTime is rejected with 400", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: START.toISOString() }));
    assert.equal(res.status, 400);
    assert.equal(updateCalls.length, 0);
});

test("endTime before startTime is rejected with 400", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const before = new Date(START.getTime() - 60 * 60 * 1000).toISOString();
    const res = await PUT(putReq({ id: "te1", endTime: before }));
    assert.equal(res.status, 400);
    assert.equal(updateCalls.length, 0);
});

test("an unparseable endTime is rejected with 400", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "not-a-date" }));
    assert.equal(res.status, 400);
    assert.equal(updateCalls.length, 0);
});

test("normal clock-out with no endTime supplied (defaults to now) is unaffected", async () => {
    // A punch that started an hour ago — "now" is a legitimate same-day end.
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date(Date.now() - 3_600_000) }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1" }, { raw: true }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
});

test("normal clock-out with a valid past-of-now endTime is unaffected", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry() });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T19:00:00.000Z" }));
    assert.equal(res.status, 200);
    assert.equal(updateCalls[0].data.durationHours, 4);
});

// ── WA automatic-break model (src/lib/wa-breaks.ts) at the route level ──────

test("8h clock-out with no attestation auto-deducts the 30-min meal: paid 7.5h, cost from paid hours, outcome AUTO_DEDUCTED", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-10T14:00:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T22:00:00.000Z" }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.shiftHours, 8);
    assert.equal(data.mealDeductionHours, 0.5);
    assert.equal(data.durationHours, 7.5);
    assert.equal(data.laborCost, 7.5 * 20);
    assert.equal(data.mealOutcome, "AUTO_DEDUCTED");
    // No yes/no captured → deducted but FLAGGED (review finding #2), never silent.
    assert.equal(data.needsReview, true);
});

test("8h clock-out with mealSkipped=true (worked through) pays the full 8h and flags for review", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-10T14:00:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T22:00:00.000Z", mealSkipped: true }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.durationHours, 8);
    assert.equal(data.mealDeductionHours, 0);
    assert.equal(data.mealOutcome, "WORKED_THROUGH");
    assert.equal(data.needsReview, true);
    assert.equal(data.mealSkipped, true);
});

test("8h clock-out on an APPROVED skip pays 8h with NO review flag (express permission already on record)", async () => {
    const { dependencies, updateCalls } = createDeps({
        entry: baseEntry({ startTime: new Date("2026-08-10T14:00:00.000Z"), mealSkipStatus: "APPROVED" }),
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T22:00:00.000Z", mealSkipped: true }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.durationHours, 8);
    assert.equal(data.mealOutcome, "WAIVED_APPROVED");
    assert.notEqual(data.needsReview, true);
});

test("short 4h clock-out: no meal required, no deduction; restBreaksMissed=true still flags (paid)", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-10T14:00:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T18:00:00.000Z", restBreaksMissed: true }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.durationHours, 4);
    assert.equal(data.mealOutcome, "NOT_REQUIRED");
    assert.equal(data.restBreaksMissed, true);
    assert.equal(data.needsReview, true);
    assert.match(String(data.reviewReason), /rest break/);
});

test("Switch-Task day (4h earlier entry + 4h closing, 10-min gap) still deducts ONE meal on the closing entry", async () => {
    const { dependencies, updateCalls } = createDeps({
        entry: baseEntry({ startTime: new Date("2026-08-10T18:10:00.000Z") }),
        dayEntries: [{ startTime: new Date("2026-08-10T14:00:00.000Z"), endTime: new Date("2026-08-10T18:00:00.000Z"), mealDeductionHours: null }],
    });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T22:10:00.000Z" }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.mealDeductionHours, 0.5);
    assert.equal(data.durationHours, 3.5);
});

test("REVIEW #1 (route): deferMeal=true on a 5.5h intermediate close deducts nothing and settles nothing", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-10T13:30:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T19:00:00.000Z", deferMeal: true }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.mealOutcome, "DEFERRED");
    assert.equal(data.mealDeductionHours, 0);
    assert.equal(data.durationHours, 5.5);
    assert.notEqual(data.needsReview, true);
});

test("REVIEW #2 (route): an 8h auto-deduction with NO attestation captured is flagged, never silent", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-10T14:00:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T22:00:00.000Z" }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.mealOutcome, "AUTO_DEDUCTED");
    assert.equal(data.needsReview, true);
    assert.match(String(data.reviewReason), /no lunch answer/);
});

test("REVIEW #2 (route): an 8h auto-deduction WITH a 'took lunch' answer (mealSkipped=false) is NOT flagged", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-10T14:00:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T22:00:00.000Z", mealSkipped: false, restBreaksMissed: false }));
    assert.equal(res.status, 200);
    const data = updateCalls[0].data as Record<string, unknown>;
    assert.equal(data.mealOutcome, "AUTO_DEDUCTED");
    assert.equal(data.durationHours, 7.5);
    assert.notEqual(data.needsReview, true);
});

test("a clock-out that would make the punch longer than 24h is rejected with SHIFT_TOO_LONG (forgotten clock-out, not a shift)", async () => {
    const { dependencies, updateCalls } = createDeps({ entry: baseEntry({ startTime: new Date("2026-08-08T14:00:00.000Z") }) });
    const { createClockOutHandler } = await routeModulePromise;
    const { PUT } = createClockOutHandler(dependencies);
    const res = await PUT(putReq({ id: "te1", endTime: "2026-08-10T02:00:00.000Z" }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "SHIFT_TOO_LONG");
    assert.equal(updateCalls.length, 0);
});
