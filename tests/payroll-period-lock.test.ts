/**
 * Pay-period locks (Phase 5 spec G4 / test 3).
 *
 * The rule itself is pure (src/lib/payroll-period.ts) and every write path
 * shares it, so it is tested directly, with an INJECTED loader — no database.
 * The clock-out route is exercised for real through its existing DI factory
 * (same pattern as tests/time-entries-clockout-route.test.ts).
 *
 * PATCH and DELETE on /api/time-entries/[id] are not DI-factored, so their 423
 * is covered by the shared helper above plus the wiring check at the bottom of
 * this file. That check reads source text, which is weaker than a behavioural
 * test — it is a tripwire for "somebody deleted the call", not a proof of
 * semantics. Recorded as a known gap rather than dressed up as coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    assertPeriodUnlocked,
    lockedPeriodFor,
    periodLockedMessage,
    type LockedPeriodRow,
} from "../src/lib/payroll-period";
import type { ClockOutDependencies, ClockOutTimeEntryRow } from "../src/app/api/time-entries/route";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-period-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const routeModulePromise = import("../src/app/api/time-entries/route");

// Mon 2026-08-17 00:00 PDT through Mon 2026-08-31 00:00 PDT (half-open).
const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");

function period(overrides: Partial<LockedPeriodRow> = {}): LockedPeriodRow {
    return {
        id: "pp1",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        lockedAt: new Date("2026-09-01T18:00:00.000Z"),
        ...overrides,
    };
}

const INSIDE = new Date("2026-08-20T15:00:00.000Z");
const AFTER = new Date("2026-09-02T15:00:00.000Z");

test("the range is half-open: periodStart is inside, periodEnd is not", () => {
    const periods = [period()];
    assert.ok(lockedPeriodFor(periods, PERIOD_START), "the first instant of the period is locked");
    assert.equal(lockedPeriodFor(periods, new Date(PERIOD_END.getTime() - 1))?.id, "pp1");
    assert.equal(lockedPeriodFor(periods, PERIOD_END), null, "periodEnd belongs to the NEXT period");
    assert.equal(lockedPeriodFor(periods, new Date(PERIOD_START.getTime() - 1)), null);
});

test("a period row with lockedAt null does not lock anything (that is what unlock leaves behind)", () => {
    assert.equal(lockedPeriodFor([period({ lockedAt: null })], INSIDE), null);
});

test("assertPeriodUnlocked answers 423 PERIOD_LOCKED with the period dates", async () => {
    const res = await assertPeriodUnlocked([INSIDE], async () => [period()]);
    assert.ok(res);
    assert.equal(res.status, 423);
    const body = await res.json();
    assert.equal(body.code, "PERIOD_LOCKED");
    assert.match(body.error, /2026-08-17 to 2026-08-30/);
    assert.equal(body.periodStart, PERIOD_START.toISOString());
});

test("the message names the LAST DAY of the period, not the exclusive end", () => {
    assert.match(periodLockedMessage(period()), /2026-08-17 to 2026-08-30/);
});

test("an edit that MOVES an entry into a locked period is refused", async () => {
    // Old time is outside the locked period; the new one is inside. Both are
    // passed, exactly as the PATCH handler does.
    const res = await assertPeriodUnlocked([AFTER, INSIDE], async () => [period()]);
    assert.ok(res);
    assert.equal(res.status, 423);
});

test("an unlocked period lets the same edit through", async () => {
    assert.equal(await assertPeriodUnlocked([AFTER, INSIDE], async () => [period({ lockedAt: null })]), null);
    assert.equal(await assertPeriodUnlocked([INSIDE], async () => []), null);
});

// ── The clock-out route, through its real handler ──────────────────────────

function clockOutDeps(lockedPeriods: LockedPeriodRow[]) {
    const updateCalls: Array<{ id: string }> = [];
    const entry: ClockOutTimeEntryRow = {
        id: "te1",
        userId: "u1",
        projectId: "p1",
        startTime: INSIDE,
        endTime: null,
        notes: null,
        reviewReason: null,
    };
    const dependencies: ClockOutDependencies = {
        authenticate: async () => ({ ok: true, user: { id: "u1", role: "FIELD_CREW", hourlyRate: 20, burdenRate: 5 } }),
        findTimeEntry: async () => entry,
        findProjectIsLogistics: async () => false,
        findOwnerRates: async () => ({ hourlyRate: 20, burdenRate: 5, role: "FIELD_CREW", name: "Owner" }),
        findDayEntries: async () => [],
        settleDay: async () => 0,
        flagSettlementFailed: async () => {},
        closeTimeEntry: async (id, userId, data) => {
            updateCalls.push({ id });
            return { ok: true, entry: { id, userId, ...data } };
        },
        loadLockedPeriods: async () => lockedPeriods,
    };
    return { dependencies, updateCalls };
}

function putReq() {
    return new Request("https://example.test/api/time-entries", {
        method: "PUT",
        body: JSON.stringify({ id: "te1", endTime: new Date(INSIDE.getTime() + 4 * 3_600_000).toISOString() }),
    });
}

test("PUT clock-out into a locked period returns 423 and writes nothing", async () => {
    const { dependencies, updateCalls } = clockOutDeps([period()]);
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 423);
    assert.equal((await res.json()).code, "PERIOD_LOCKED");
    assert.equal(updateCalls.length, 0, "a refused clock-out must not touch the entry");
});

test("PUT clock-out succeeds once the period is unlocked", async () => {
    const { dependencies, updateCalls } = clockOutDeps([period({ lockedAt: null })]);
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
});

// ── Wiring tripwire for the two handlers that are not DI-factored ──────────

test("PATCH and DELETE on /api/time-entries/[id] both still call assertPeriodUnlocked", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    const splitAt = source.indexOf("export async function DELETE");
    assert.ok(splitAt > 0, "DELETE handler not found — this check needs updating");
    const patchHalf = source.slice(0, splitAt);
    const deleteHalf = source.slice(splitAt);
    assert.match(patchHalf, /assertPeriodUnlocked\(\[existing\.startTime, newStart\]\)/);
    assert.match(deleteHalf, /assertPeriodUnlocked\(\[existing\.startTime\]\)/);
});
