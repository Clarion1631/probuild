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
    appendZeroRateReview,
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
        closeTimeEntry: async (id, userId, buildData, guard) => {
            // The real dependency reads the STORED startTime under FOR UPDATE
            // and prices the close from it; the fixture entry never moves.
            void guard;
            // The real dependency reads these FOR UPDATE inside the close
            // transaction and prices from them.
            // The whole row-locked owner: buildData re-runs the $0 check on it.
            const lockedOwner = options.ownerId
                ? options.ownerRates ?? {
                      hourlyRate: 0,
                      burdenRate: 0,
                      role: "FIELD_CREW",
                      name: "Tim Brennan",
                      email: "tim@example.com",
                      payType: "HOURLY",
                  }
                : {
                      hourlyRate: options.selfRate ?? 0,
                      burdenRate: 0,
                      role: options.selfRole ?? "FIELD_CREW",
                      name: null,
                      email: options.selfEmail ?? "worker@example.com",
                      payType: options.ownerPayType ?? null,
                  };
            const data = await buildData(START, lockedOwner);
            updateCalls.push({ id, data });
            return { ok: true, entry: { id, userId, ...data } };
        },
        loadLockedPeriods: async () => [],
    };
    return { dependencies, updateCalls };
}

function putReq(extra: Record<string, unknown> = {}) {
    return new Request("https://example.test/api/time-entries", {
        method: "PUT",
        body: JSON.stringify({
            id: "te1",
            endTime: new Date(START.getTime() + 4 * 3_600_000).toISOString(),
            ...extra,
        }),
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

test("a MANAGER's ORDINARY close at $0 is refused too — the silent $0 was the bug", async () => {
    // The escape must not be the default outcome of a normal manager close.
    const { dependencies, updateCalls } = deps({
        selfRole: "MANAGER",
        selfRate: 45,
        ownerId: "owner-1",
        ownerRates: { hourlyRate: 0, burdenRate: 0, role: "FIELD_CREW", name: "Tim Brennan", email: "tim@example.com", payType: "HOURLY" },
    });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, "ZERO_RATE_BLOCKED");
    assert.equal(updateCalls.length, 0);
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
    // The DELIBERATE escape: an explicit acknowledgement, sent only by the
    // manager UI's "close at $0 and flag for payroll" control.
    const res = await createClockOutHandler(dependencies).PUT(putReq({ acknowledgeZeroRate: true }));
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

test("the PATCH edit path mirrors the block on ANY cost recomputation", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    // Widened from the OPEN -> CLOSED transition: shrinking a closed 8h entry to
    // 4h at a $0 rate rewrites the cost just as silently.
    assert.match(source, /const recomputesCost = newEnd != null;/);
    assert.match(source, /recomputesCost &&[\s\S]{0,40}zeroRateBlocks\(/);
    assert.match(source, /email: owner\.email/, "the manager mirror must pass the email, or a salaried manager is blocked");
    assert.match(source, /payType: owner\.payType/, "and the stored payType, which beats both");
    // Owner-only refusal, and a flag on the manager path — the same shape the
    // PUT tests above exercise for real.
    assert.match(source, /if \(zeroRate && !acknowledgedZeroRate\)/);
    assert.match(source, /appendZeroRateReview\(/);
});

test("clearing the zero-rate review flag requires a real rate and reprices the entry", () => {
    // The flag is the ONLY thing stopping a manager-closed $0 shift being
    // exported and locked, so "Mark reviewed" must not be a rubber stamp.
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function markTimeEntryReviewed"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    assert.match(body, /ZERO_RATE_REVIEW_NOTE/, "it has to recognise the zero-rate flag specifically");
    assert.match(body, /zeroRateBlocks\(/, "and re-check the rate before clearing it");
    assert.match(body, /reprice/, "and reprice the entry rather than leaving the $0 cost");
    assert.match(body, /data\.laborCost = hours \* owner\.hourlyRate/);
    assert.match(body, /updatedAt: live\.updatedAt/, "and it refuses a stale review");
});

test("a WORKER cannot acknowledge their own $0 rate", async () => {
    // A phone cannot fix a pay rate, so the escape is not theirs to take —
    // otherwise the crew app could opt itself out of the guard entirely.
    const { dependencies, updateCalls } = deps({ selfRate: 0 });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq({ acknowledgeZeroRate: true }));
    assert.equal(res.status, 422);
    assert.equal(updateCalls.length, 0);
});

test("the PATCH mirror also refuses by default and needs the same explicit flag", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    assert.match(source, /body\.acknowledgeZeroRate === true && canAcknowledgeZeroRate\(user, existing\.userId\)/);
    assert.match(source, /if \(zeroRate && !acknowledgedZeroRate\)/);
});

test("a rate zeroed AFTER the precheck is still caught, inside the transaction", async () => {
    // The pre-read said the owner had a rate; a rate import committed before
    // the close transaction opened. The authoritative check runs on the
    // row-locked owner, so the stale precheck cannot wave it through.
    const { dependencies, updateCalls } = deps({ selfRate: 28 });
    const { createClockOutHandler } = await routeModulePromise;
    dependencies.closeTimeEntry = async (id, userId, buildData) => {
        // The owner as the transaction finds them: rate gone.
        const data = await buildData(START, {
            hourlyRate: 0,
            burdenRate: 0,
            role: "FIELD_CREW",
            name: "Tim Brennan",
            email: "tim@example.com",
            payType: "HOURLY",
        });
        updateCalls.push({ id, data });
        return { ok: true as const, entry: { id, userId, ...data } };
    };
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 422, "the locked read is what decides");
    assert.equal((await res.json()).code, "ZERO_RATE_BLOCKED");
    assert.equal(updateCalls.length, 0, "nothing may be written");
});

test("a rate FIXED after the precheck stops refusing", async () => {
    // The mirror image, and the reason this cannot just re-use the precheck:
    // the office sets the rate while the worker is clocking out.
    const { dependencies, updateCalls } = deps({ selfRate: 28 });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].data.laborCost, 28 * 4, "priced from the locked read");
});

test("only an office role, on somebody ELSE's entry, may acknowledge a $0 close", async () => {
    const { canAcknowledgeZeroRate } = await import("../src/lib/pay-rate-guard");
    // A phone cannot fix a pay rate, so letting the crew acknowledge would let
    // the app opt itself out of the guard entirely.
    assert.equal(canAcknowledgeZeroRate({ role: "FIELD_CREW", id: "u1" }, "u2"), false);
    assert.equal(canAcknowledgeZeroRate({ role: "EMPLOYEE", id: "u1" }, "u2"), false);
    // Self-acknowledgement is the same hole wearing a different hat.
    assert.equal(canAcknowledgeZeroRate({ role: "MANAGER", id: "u1" }, "u1"), false);
    assert.equal(canAcknowledgeZeroRate({ role: "ADMIN", id: "u1" }, "u1"), false);
    // The real cases.
    assert.equal(canAcknowledgeZeroRate({ role: "MANAGER", id: "u1" }, "u2"), true);
    assert.equal(canAcknowledgeZeroRate({ role: "ADMIN", id: "u1" }, "u2"), true);
    assert.equal(canAcknowledgeZeroRate({ role: "FINANCE", id: "u1" }, "u2"), true);
    assert.equal(canAcknowledgeZeroRate(null, "u2"), false);
    assert.equal(canAcknowledgeZeroRate({ role: "ADMIN", id: "u1" }, null), false);
});

test("a FIELD_CREW acknowledgement is ignored by the route", async () => {
    const { dependencies, updateCalls } = deps({ selfRole: "FIELD_CREW", selfRate: 0 });
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq({ acknowledgeZeroRate: true }));
    assert.equal(res.status, 422);
    assert.equal(updateCalls.length, 0);
});


// ---------------------------------------------------------------------------
// Review round 15, items 1 and 2: settlement is a PRICING decision, and the
// manual actions do not touch clocked rows.
// ---------------------------------------------------------------------------

function settlementSource(): string {
    return readFileSync(path.join(process.cwd(), "src/lib/wa-breaks-db.ts"), "utf8");
}

test("settlement never writes laborCost = 0 for an hourly member at a $0 rate", () => {
    const fn = settlementSource();
    const body = fn.slice(fn.indexOf("async function settleDayInTx"));
    // The policy is the SAME one the clock-out guard uses — not a second,
    // divergent copy of "is this rate ok".
    assert.match(body, /zeroRateBlocks\(\{/);
    assert.match(body, /appendZeroRateReview\(/);
    // The costs are only written on the non-blocked branch. Multiplying
    // paidHours by a zero rate was the one path that could book a free shift
    // without anybody choosing to.
    assert.match(body, /const pricing = zeroRate\s*\?\s*appendZeroRateReview/);
    assert.match(body, /:\s*\{\s*laborCost: update\.paidHours \* hourlyRate/);
    assert.doesNotMatch(
        body.slice(body.indexOf("tx.timeEntry.update")),
        /^\s*laborCost: update\.paidHours \* hourlyRate,$/m,
        "the unconditional cost write must be gone"
    );
});

test("the zero-rate policy reads the whole owner, not just the number", () => {
    const fn = settlementSource();
    const body = fn.slice(fn.indexOf("async function settleDayInTx"));
    // role / email / payType are what exempt a salaried owner. Selecting only
    // the rates would make every salaried $0 look like a blocked hourly one.
    assert.match(body, /select: \{ email: true, role: true, payType: true, hourlyRate: true, burdenRate: true \}/);
});

test("a $0-rate row is not skipped by the no-op shortcut until it carries the flag", () => {
    const fn = settlementSource();
    const body = fn.slice(fn.indexOf("async function settleDayInTx"));
    // Otherwise a day whose hours already match would never get flagged, and
    // the export would run straight past it.
    assert.match(body, /const same =\s*\n\s*!zeroRate &&/);
    assert.match(body, /zeroRate && row\.needsReview && \(row\.reviewReason \?\? ""\)\.includes\(ZERO_RATE_REVIEW_NOTE\)/);
});

test("the salaried are exempt, so settlement still prices them", () => {
    // The flip side of the rule: a salaried MANAGER has a CORRECT $0 rate and
    // must not be flagged every time their day is re-planned.
    assert.equal(zeroRateBlocks({ role: "MANAGER", email: "cj@goldentouchremodeling.com", payType: "SALARY", hourlyRate: 0 }), false);
    assert.equal(zeroRateBlocks({ role: "FIELD_CREW", email: "garrett@example.com", payType: "HOURLY", hourlyRate: 0 }), true);
    // A real rate settles it for anybody.
    assert.equal(zeroRateBlocks({ role: "FIELD_CREW", email: "garrett@example.com", payType: "HOURLY", hourlyRate: 25 }), false);
});

test("a DEFERRED day settled at a $0 rate is flagged, not priced at zero", () => {
    // The deferred path settles LATER, when the answer arrives — by then the
    // clock-out guard is long gone, so settlement is the only thing standing
    // between a $0 rate and a free shift.
    const flagged = appendZeroRateReview("Meal break not taken — deferred");
    assert.equal(flagged.needsReview, true);
    assert.match(flagged.reviewReason, /Meal break not taken — deferred/);
    assert.match(flagged.reviewReason, /\$0 pay rate/);
    // The existing notice is composed onto, never replaced: both reasons matter.
    assert.equal(flagged.reviewReason.split("; ").length, 2);
});

test("every entry on a multi-entry day gets the flag, not just the closing one", () => {
    // settleDayInTx loops the whole plan, and the pricing branch is inside the
    // loop — so two shifts on one day both come back flagged.
    const fn = settlementSource();
    const body = fn.slice(fn.indexOf("async function settleDayInTx"));
    const loop = body.slice(body.indexOf("for (const update of plan)"));
    assert.ok(loop.indexOf("const pricing = zeroRate") > -1, "pricing is decided per ROW, inside the loop");
    assert.ok(loop.indexOf("const pricing") < loop.indexOf("tx.timeEntry.update"));
    // And appending is idempotent, so a second pass over the same row does not
    // stack the note twice.
    const once = appendZeroRateReview(null);
    const twice = appendZeroRateReview(once.reviewReason);
    assert.equal(twice.reviewReason, once.reviewReason);
});
