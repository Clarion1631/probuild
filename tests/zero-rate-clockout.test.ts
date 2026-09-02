/**
 * $0-rate clock-out block (Phase 5 spec G2 / test 4).
 *
 * The whole point of the feature is that the entry STAYS OPEN, so every route
 * test here asserts on `closeTimeEntry` never being called — a 422 with the row
 * closed anyway would be the exact bug this is meant to prevent.
 *
 * Exercised through the real PUT handler via its DI factory. The PATCH mirror
 * is not DI-factored; its rule is the same pure predicate, tested directly, and
 * its wiring is asserted at the bottom of this file (a tripwire, not a proof —
 * same honest caveat as tests/payroll-period-lock.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    isSalariedOwner,
    ZERO_RATE_WORKER_MESSAGE,
    zeroRateBlocks,
    zeroRateManagerMessage,
} from "../src/lib/pay-rate-guard";
import type { ClockOutDependencies, ClockOutTimeEntryRow } from "../src/app/api/time-entries/route";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-zero-rate-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const routeModulePromise = import("../src/app/api/time-entries/route");

const START = new Date("2026-08-10T15:00:00.000Z");

test("the rule BLOCKS BY DEFAULT and exempts only the salaried", () => {
    assert.equal(zeroRateBlocks({ role: "FIELD_CREW", hourlyRate: 0 }), true);
    assert.equal(zeroRateBlocks({ role: "MANAGER", hourlyRate: 0 }), true);
    assert.equal(zeroRateBlocks({ role: "ADMIN", hourlyRate: 0 }), false, "salaried by role");
    assert.equal(zeroRateBlocks({ role: "FINANCE", hourlyRate: 0 }), false);
    assert.equal(zeroRateBlocks({ role: "FIELD_CREW", hourlyRate: 0.01 }), false, "a real rate settles it");
    // A missing/NaN rate is not a rate either.
    assert.equal(zeroRateBlocks({ role: "FIELD_CREW", hourlyRate: Number.NaN }), true);
});

test("a role nobody has heard of FAILS CLOSED — the allowlist version failed open", () => {
    // The earlier version listed the HOURLY roles and blocked only those, so a
    // role added later would have booked $0 shifts silently.
    assert.equal(zeroRateBlocks({ role: "APPRENTICE", hourlyRate: 0 }), true);
    assert.equal(zeroRateBlocks({ role: null, hourlyRate: 0 }), true);
    assert.equal(zeroRateBlocks({ hourlyRate: 0 }), true);
});

test("a SALARIED MANAGER is exempt — CJ and Richard would otherwise never clock out", () => {
    // They are MANAGERs in ProBuild and salaried in Gusto, so $0 is the CORRECT
    // hourly rate for them. A role-only rule left them permanently stuck with an
    // open punch and there is no sweeper that closes one.
    assert.equal(isSalariedOwner({ role: "MANAGER", email: "cj@goldentouchremodeling.com" }), true);
    assert.equal(zeroRateBlocks({ role: "MANAGER", email: "CJ@GoldenTouchRemodeling.com", hourlyRate: 0 }), false);
    assert.equal(zeroRateBlocks({ role: "MANAGER", email: "rlord@goldentouchremodeling.com", hourlyRate: 0 }), false);
    assert.equal(zeroRateBlocks({ role: "MANAGER", email: "tim@example.com", hourlyRate: 0 }), true);
});

function deps(options: {
    selfRole?: string;
    selfRate?: number;
    ownerId?: string;
    selfEmail?: string;
    ownerRates?: { hourlyRate: number; burdenRate: number; role: string; name: string | null; email: string };
}) {
    const updateCalls: Array<{ id: string }> = [];
    const entry: ClockOutTimeEntryRow = {
        id: "te1",
        userId: options.ownerId ?? "u1",
        projectId: "p1",
        startTime: START,
        endTime: null,
        notes: null,
        reviewReason: null,
    };
    const dependencies: ClockOutDependencies = {
        authenticate: async () => ({
            ok: true,
            user: {
                id: "u1",
                role: options.selfRole ?? "FIELD_CREW",
                email: options.selfEmail ?? "worker@example.com",
                hourlyRate: options.selfRate ?? 0,
                burdenRate: 0,
            },
        }),
        findTimeEntry: async () => entry,
        findProjectIsLogistics: async () => false,
        findOwnerRates: async () =>
            options.ownerRates ?? { hourlyRate: 0, burdenRate: 0, role: "FIELD_CREW", name: "Tim Brennan", email: "tim@example.com" },
        findDayEntries: async () => [],
        settleDay: async () => 0,
        flagSettlementFailed: async () => {},
        closeTimeEntry: async (id, userId, data) => {
            updateCalls.push({ id });
            return { ok: true, entry: { id, userId, ...data } };
        },
        loadLockedPeriods: async () => [],
    };
    return { dependencies, updateCalls };
}

function putReq() {
    return new Request("https://example.test/api/time-entries", {
        method: "PUT",
        body: JSON.stringify({ id: "te1", endTime: new Date(START.getTime() + 4 * 3_600_000).toISOString() }),
    });
}

test("a $0-rate worker clocking themselves out gets 422 ZERO_RATE_BLOCKED and stays on the clock", async () => {
    const { dependencies, updateCalls } = deps({ selfRate: 0 });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "ZERO_RATE_BLOCKED");
    assert.equal(body.error, ZERO_RATE_WORKER_MESSAGE);
    assert.equal(updateCalls.length, 0, "the punch must stay OPEN — no time is lost");
});

test("a manager closing someone else's $0-rate punch gets the manager-facing message", async () => {
    const { dependencies, updateCalls } = deps({
        selfRole: "MANAGER",
        selfRate: 45,
        ownerId: "owner-1",
        ownerRates: { hourlyRate: 0, burdenRate: 0, role: "FIELD_CREW", name: "Tim Brennan", email: "tim@example.com" },
    });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "ZERO_RATE_BLOCKED");
    assert.equal(body.error, zeroRateManagerMessage("Tim Brennan"));
    assert.match(body.error, /Team Members/);
    assert.equal(updateCalls.length, 0);
});

test("an ADMIN owner at $0 is exempt and clocks out normally", async () => {
    const { dependencies, updateCalls } = deps({ selfRole: "ADMIN", selfRate: 0 });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
});

test("a salaried MANAGER at $0 clocks out through the real route", async () => {
    const { dependencies, updateCalls } = deps({
        selfRole: "MANAGER",
        selfRate: 0,
        selfEmail: "cj@goldentouchremodeling.com",
    });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
});

test("a worker WITH a rate is unaffected", async () => {
    const { dependencies, updateCalls } = deps({ selfRate: 28 });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
});

test("the PATCH edit path still mirrors the block, and only on an OPEN -> CLOSED transition", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    assert.match(source, /if \(closingOpenEntry && zeroRateBlocks\(/);
    assert.match(source, /email: owner\.email/, "the manager mirror must pass the email, or a salaried manager is blocked");
    assert.match(source, /zeroRateBlockedResponse\(\{ closerIsOwner: isOwner, ownerName: owner\.name \}\)/);
});
