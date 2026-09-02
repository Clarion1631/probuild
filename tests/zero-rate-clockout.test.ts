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
    ZERO_RATE_REVIEW_NOTE,
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

test("the STORED payType beats the role and the env list, both ways", () => {
    // The column is the answer a human gave; the env list is a fallback that
    // fails open by construction (an absent email looks exactly like "hourly").
    assert.equal(zeroRateBlocks({ role: "MANAGER", email: "tim@example.com", payType: "SALARY", hourlyRate: 0 }), false);
    assert.equal(
        zeroRateBlocks({ role: "ADMIN", email: "boss@example.com", payType: "HOURLY", hourlyRate: 0 }),
        true,
        "an explicit HOURLY overrides the salaried-by-role default"
    );
    assert.equal(
        zeroRateBlocks({ role: "MANAGER", email: "cj@goldentouchremodeling.com", payType: "HOURLY", hourlyRate: 0 }),
        true,
        "and it overrides the env list too"
    );
});

test("EMPLOYEE is a legacy role and is hourly", () => {
    // It is absent from ROLE_LABELS/ROLES so nothing creates one today, but it
    // is still a live branch in access-rules.ts, so rows can carry it.
    assert.equal(zeroRateBlocks({ role: "EMPLOYEE", hourlyRate: 0 }), true);
    assert.equal(isSalariedOwner({ role: "EMPLOYEE", email: "old@example.com" }), false);
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
    ownerPayType?: string | null;
    ownerRates?: { hourlyRate: number; burdenRate: number; role: string; name: string | null; email: string; payType: string | null };
}) {
    const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
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
                payType: options.ownerPayType ?? null,
                hourlyRate: options.selfRate ?? 0,
                burdenRate: 0,
            },
        }),
        findTimeEntry: async () => entry,
        findProjectIsLogistics: async () => false,
        findOwnerRates: async () =>
            options.ownerRates ?? { hourlyRate: 0, burdenRate: 0, role: "FIELD_CREW", name: "Tim Brennan", email: "tim@example.com", payType: options.ownerPayType ?? null },
        findDayEntries: async () => [],
        settleDay: async () => 0,
        flagSettlementFailed: async () => {},
        closeTimeEntry: async (id, userId, data, _guard) => {
            updateCalls.push({ id, data });
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

test("a MANAGER closing someone else's $0-rate punch is ALLOWED, and flagged", async () => {
    // Blocking the office too created a punch nobody could close: past
    // MAX_SHIFT_HOURS every path refuses it and nothing sweeps a stranded punch.
    // So the close goes through and carries a review flag that the payroll
    // export then refuses to run past.
    const { dependencies, updateCalls } = deps({
        selfRole: "MANAGER",
        selfRate: 45,
        ownerId: "owner-1",
        ownerRates: { hourlyRate: 0, burdenRate: 0, role: "FIELD_CREW", name: "Tim Brennan", email: "tim@example.com", payType: "HOURLY" },
    });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 200, "the office must always have a way to close a stranded punch");
    assert.equal(updateCalls.length, 1);
    const data = updateCalls[0].data;
    assert.equal(data.needsReview, true);
    assert.match(String(data.reviewReason), new RegExp(ZERO_RATE_REVIEW_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(data.laborCost, 0, "the $0 cost is real — the flag is what stops it being silent");
});

test("the manager-facing message still exists for the surfaces that show it", () => {
    assert.match(zeroRateManagerMessage("Tim Brennan"), /Team Members/);
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
    assert.match(source, /closingOpenEntry &&[\s\S]{0,20}zeroRateBlocks\(/);
    assert.match(source, /email: owner\.email/, "the manager mirror must pass the email, or a salaried manager is blocked");
    assert.match(source, /payType: owner\.payType/, "and the stored payType, which beats both");
    // Owner-only refusal, and a flag on the manager path — the same shape the
    // PUT tests above exercise for real.
    assert.match(source, /if \(zeroRate && isOwner\)/);
    assert.match(source, /appendZeroRateReview\(/);
});
