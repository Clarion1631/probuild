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
    assertPeriodUnlockedOrThrow,
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

test("the lock covers the whole WORKWEEKS the period touches, not just the period", () => {
    const periods = [period()];
    // The fixture period is Mon 2026-08-17 .. Mon 2026-08-31, so it is already
    // whole Mon-Sun weeks: the envelope and the period coincide here.
    assert.ok(lockedPeriodFor(periods, PERIOD_START), "the first instant of the period is locked");
    assert.equal(lockedPeriodFor(periods, new Date(PERIOD_END.getTime() - 1))?.id, "pp1");
    assert.equal(lockedPeriodFor(periods, PERIOD_END), null, "the next week is not frozen");
    assert.equal(lockedPeriodFor(periods, new Date(PERIOD_START.getTime() - 1)), null);
});

test("a punch on the SUNDAY before a Monday-start locked period is frozen too", () => {
    // Overtime is a property of the workweek. Sunday 2026-08-16 is in the
    // Mon 2026-08-10 week, which does NOT overlap the period — untouched.
    // But a period that opens mid-week drags its own week in: shift the period
    // to start Wednesday and the Sunday/Monday before it become editable-no-more.
    const midWeek = period({
        periodStart: new Date("2026-08-19T07:00:00.000Z"), // Wed
        periodEnd: new Date("2026-08-31T07:00:00.000Z"),
    });
    const mondayBefore = new Date("2026-08-17T15:00:00.000Z");
    const sundayBefore = new Date("2026-08-16T15:00:00.000Z");
    assert.equal(lockedPeriodFor([midWeek], mondayBefore)?.id, "pp1", "same workweek as the period start");
    assert.equal(
        lockedPeriodFor([midWeek], sundayBefore),
        null,
        "the PREVIOUS Mon-Sun week does not decide this period's overtime"
    );
    // And the trailing partial week: the period ends Mon 08-31, so the week of
    // 08-24 is fully inside. A punch on Sun 08-30 is inside the period anyway;
    // the interesting case is a period ending MID-week.
    const midWeekEnd = period({
        periodStart: new Date("2026-08-17T07:00:00.000Z"),
        periodEnd: new Date("2026-08-27T07:00:00.000Z"), // Thu
    });
    const fridayAfter = new Date("2026-08-28T15:00:00.000Z");
    assert.equal(
        lockedPeriodFor([midWeekEnd], fridayAfter)?.id,
        "pp1",
        "a punch in the trailing partial week still moves the locked period's OT split"
    );
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
    // Mirrors the real dependency: the guard runs INSIDE the close transaction,
    // so a locked period comes back as a result, not as a pre-check.
    // The real dependency re-reads the row FOR UPDATE inside the transaction and
    // checks its STORED startTime, then settles the day in the same transaction.
    const guardedClose = (id: string, userId: string, data: Record<string, unknown>) => {
        const hit = lockedPeriodFor(lockedPeriods, INSIDE);
        if (hit) return { ok: false as const, locked: hit };
        updateCalls.push({ id });
        return { ok: true as const, entry: { id, userId, ...data } };
    };
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
        authenticate: async () => ({ ok: true, user: { id: "u1", role: "FIELD_CREW", email: "u1@example.com", payType: "HOURLY", hourlyRate: 20, burdenRate: 5 } }),
        findTimeEntry: async () => entry,
        findProjectIsLogistics: async () => false,
        findOwnerRates: async () => ({ hourlyRate: 20, burdenRate: 5, role: "FIELD_CREW", name: "Owner", email: "owner@example.com", payType: "HOURLY" }),
        findDayEntries: async () => [],
        settleDay: async () => 0,
        flagSettlementFailed: async () => {},
        closeTimeEntry: async (id, userId, data) => guardedClose(id, userId, data),
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

/**
 * The canonical list of writers that can change how many payroll hours a period
 * holds. Every one of them must call a lock assertion. This is a TRIPWIRE, not
 * a behavioural proof — it catches "somebody added a writer and forgot", which
 * is the failure mode that actually happened (the first cut of this feature
 * gated the three API routes and left four server actions wide open).
 *
 * If you add a TimeEntry writer that touches startTime, durationHours, or
 * existence, add it here and gate it. If it only touches flags, notes, cost
 * coding, change-order tags or billing stamps, it belongs in the exclusion
 * comment in src/lib/payroll-period.ts instead.
 */
const GATED_WRITERS: Array<{ file: string; mustMatch: RegExp[] }> = [
    {
        file: "src/lib/time-expense-core.ts",
        // createTimeEntryCore — the canonical manual create, and the reason
        // gating it here covers createTimeEntry in time-expense-actions too.
        mustMatch: [/withPayrollWriteTx\(\{ instants: \[startTime\] \}/],
    },
    {
        file: "src/lib/time-expense-actions.ts",
        mustMatch: [
            /withPayrollWriteTx\(\{ entryIds: \[id\], instants: \[startTime\] \}/, // updateTimeEntry
            /withPayrollWriteTx\(\{ entryIds: \[id\] \}/, // deleteTimeEntry
            /withPayrollWriteTx\(\{ entryIds: allowedIds \}/, // deleteTimeEntries
        ],
    },
    {
        file: "src/app/projects/[id]/timeclock/actions.ts",
        mustMatch: [
            /withPayrollWriteTx\(\{ instants: \[startTime\] \}/, // createTimeEntry
            /withPayrollWriteTx\(\{ entryIds: \[id\], instants: \[startTime\] \}/, // updateTimeEntry
            /withPayrollWriteTx\(\{ entryIds: \[id\] \}/, // deleteTimeEntry
        ],
    },
    {
        file: "src/app/api/time-entries/route.ts",
        mustMatch: [
            /withPayrollWriteTx\(\{ instants: \[entryStartTime\] \}/, // POST clock-in (client-supplied startTime)
            /assertPeriodUnlockedInTx\(/, // PUT clock-out, inside the close transaction
            /FOR UPDATE/, // and the row is re-read there, not trusted from earlier
        ],
    },
    {
        file: "src/app/api/time-entries/[id]/route.ts",
        mustMatch: [
            /withPayrollWriteTx\(\{ entryIds: \[id\], instants: \[newStart\] \}/, // PATCH
            /guard: \(tx\) => assertPeriodUnlockedInTx\(tx, \[existing\.startTime\]\)/, // DELETE
        ],
    },
];

test("every payroll-hours writer calls a lock assertion", () => {
    for (const writer of GATED_WRITERS) {
        const source = readFileSync(path.join(__dirname, "..", ...writer.file.split("/")), "utf8");
        for (const pattern of writer.mustMatch) {
            assert.match(source, pattern, `${writer.file} is missing ${pattern}`);
        }
    }
});

test("a lock taken AFTER the fail-fast check still stops the write (in-transaction guard)", async () => {
    // The injected-sequence pattern: the stand-alone loader says "unlocked"
    // (the fail-fast check passes), but by the time the close transaction runs,
    // the period is locked. Only the in-transaction guard can catch that, and
    // the row must not be closed.
    //
    // This simulates the race on ONE connection. A true two-connection test —
    // proving pg_advisory_xact_lock_shared actually blocks a concurrent lock
    // creation — needs a real Postgres and belongs in the CI database job.
    const { dependencies, updateCalls } = clockOutDeps([]);
    dependencies.loadLockedPeriods = async () => [];
    dependencies.closeTimeEntry = async (id, userId, data, guard) => {
        // The guard now carries the entry id (re-read FOR UPDATE inside the
        // transaction) and the settlement that must commit with it.
        assert.equal(guard.entryId, "te1");
        assert.ok(guard.settle, "settlement must ride along in the close transaction");
        const hit = lockedPeriodFor([period()], INSIDE);
        if (hit) return { ok: false as const, locked: hit };
        updateCalls.push({ id });
        return { ok: true as const, entry: { id, userId, ...data } };
    };
    const { createClockOutHandler } = await routeModulePromise;
    const res = await createClockOutHandler(dependencies).PUT(putReq());
    assert.equal(res.status, 423);
    assert.equal((await res.json()).code, "PERIOD_LOCKED");
    assert.equal(updateCalls.length, 0, "the entry was closed into a period that had just been locked");
});

test("the advisory locks are the documented pair, on one key", async () => {
    const calls: string[] = [];
    const tx = {
        $executeRawUnsafe: async (query: string, key: string) => {
            calls.push(`${query.includes("_shared") ? "shared" : "exclusive"}:${key}`);
            return 0;
        },
        $queryRawUnsafe: async () => [],
        payrollPeriod: { findMany: async () => [] },
    };
    const { acquirePayrollWriteLock, acquirePayrollLockCreationLock, PAYROLL_ADVISORY_LOCK_KEY } = await import(
        "../src/lib/payroll-period"
    );
    await acquirePayrollWriteLock(tx);
    await acquirePayrollLockCreationLock(tx);
    // Writers take SHARED (they do not conflict with each other), lock creation
    // takes EXCLUSIVE (it must wait for every in-flight writer). Same key, or
    // they would not serialize against each other at all.
    assert.deepEqual(calls, [`shared:${PAYROLL_ADVISORY_LOCK_KEY}`, `exclusive:${PAYROLL_ADVISORY_LOCK_KEY}`]);
});

test("assertPeriodUnlockedInTx takes the shared lock BEFORE reading, and throws inside the tx", async () => {
    const order: string[] = [];
    const tx = {
        $executeRawUnsafe: async () => {
            order.push("lock");
            return 0;
        },
        $queryRawUnsafe: async () => [],
        payrollPeriod: {
            findMany: async () => {
                order.push("read");
                return [period()];
            },
        },
    };
    const { assertPeriodUnlockedInTx, isPeriodLockedError } = await import("../src/lib/payroll-period");
    await assert.rejects(
        () => assertPeriodUnlockedInTx(tx, [INSIDE]),
        (error: Error) => {
            assert.ok(isPeriodLockedError(error));
            return true;
        }
    );
    // Reading first would let a lock commit between the read and the write.
    assert.deepEqual(order, ["lock", "read"]);
});

test("a locked period is enforced in the zone it was LOCKED in, not today's company zone", async () => {
    // Same period row, two different stored zones. The envelope is derived from
    // a time zone, so re-deriving it after a CompanySettings change would move
    // the boundaries of a period that was already paid.
    const utcLocked = period({ timeZone: "UTC" });
    const laLocked = period({ timeZone: "America/Los_Angeles" });
    // 2026-08-17T02:00Z is still Sunday 08-16 in Los Angeles (the week before)
    // but already Monday 08-17 in UTC.
    const boundary = new Date("2026-08-17T02:00:00.000Z");
    assert.equal(lockedPeriodFor([utcLocked], boundary, { timeZone: "America/Los_Angeles" })?.id, "pp1");
    assert.equal(lockedPeriodFor([laLocked], boundary, { timeZone: "UTC" }), null);
});

test("every gated write happens in the SAME transaction as its lock check", () => {
    // The guard is only a guard if the check and the write share a transaction.
    // A stand-alone assertPeriodUnlocked() before a bare prisma write is the
    // shape this test exists to catch.
    const bare = readFileSync(path.join(__dirname, "..", "src", "lib", "time-expense-actions.ts"), "utf8");
    assert.doesNotMatch(bare, /await prisma\.timeEntry\.(deleteMany|updateMany|update|delete)\(/);
    const timeclock = readFileSync(
        path.join(__dirname, "..", "src", "app", "projects", "[id]", "timeclock", "actions.ts"),
        "utf8"
    );
    assert.doesNotMatch(timeclock, /await prisma\.timeEntry\.(create|update|delete)\(/);
});

test("PATCH and DELETE on /api/time-entries/[id] both still call the lock guard", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    const splitAt = source.indexOf("export async function DELETE");
    assert.ok(splitAt > 0, "DELETE handler not found — this check needs updating");
    const patchHalf = source.slice(0, splitAt);
    const deleteHalf = source.slice(splitAt);
    // PATCH: a cheap fail-fast check, then the real in-transaction guard.
    assert.match(patchHalf, /assertPeriodUnlocked\(\[existing\.startTime, newStart\]\)/);
    assert.match(patchHalf, /withPayrollWriteTx\(\{ entryIds: \[id\], instants: \[newStart\] \}/);
    // The edit and the day re-plan it triggers commit together.
    assert.match(patchHalf, /settleDayWithinTx\(/);
    // DELETE: the guard runs inside deleteEntryAndSettle's own transaction.
    assert.match(deleteHalf, /guard: \(tx\) => assertPeriodUnlockedInTx\(tx, \[existing\.startTime\]\)/);
});

test("assertPeriodUnlockedOrThrow throws with the same message the routes return", async () => {
    // Server actions have no response object; a returned value would be ignored
    // by every caller, so the action variant must THROW.
    await assert.rejects(
        () => assertPeriodUnlockedOrThrow([INSIDE], async () => [period()]),
        (error: Error) => {
            assert.equal(error.message, periodLockedMessage(period()));
            return true;
        }
    );
    await assertPeriodUnlockedOrThrow([INSIDE], async () => [period({ lockedAt: null })]);
    await assertPeriodUnlockedOrThrow([AFTER], async () => [period()]);
});

test("settlement itself refuses a day inside a locked period", async () => {
    // settleDay rewrites durationHours/laborCost for a whole day and runs after
    // a close, so it is a payroll write with no user touching that row. It gets
    // its own guard, under the same shared advisory lock.
    const { assertDayUnlockedInTx, isPeriodLockedError } = await import("../src/lib/payroll-period");
    const took: string[] = [];
    const tx = {
        $executeRawUnsafe: async (query: string) => {
            took.push(query.includes("_shared") ? "shared" : "exclusive");
            return 0;
        },
        $queryRawUnsafe: async () => [],
        payrollPeriod: { findMany: async () => [period()] },
    };
    await assert.rejects(
        () => assertDayUnlockedInTx(tx, "2026-08-20", "America/Los_Angeles"),
        (error: Error) => isPeriodLockedError(error)
    );
    assert.deepEqual(took, ["shared"]);

    // A day outside every locked period settles normally.
    await assertDayUnlockedInTx(tx, "2026-09-10", "America/Los_Angeles");
});

test("a write validates the row's STORED startTime, not the caller's stale copy", () => {
    // A concurrent writer can move a row after this request read it, and a
    // locker can then lock the period it moved into. The guard re-reads the row
    // FOR UPDATE inside the transaction, so the stale value cannot be used.
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "payroll-period.ts"), "utf8");
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /resolveGuardInstants/);
    // The public shape takes entry IDS, not pre-read dates, so a caller cannot
    // pass a stale timestamp even by accident.
    assert.match(source, /export type PayrollWriteTarget = \{/);
    assert.match(source, /entryIds\?: string\[\];/);
});
