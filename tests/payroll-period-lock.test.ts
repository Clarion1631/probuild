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

const LF = String.fromCharCode(10);
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

test("the freeze reaches BACKWARD into the week, and never past the period", () => {
    // Overtime is allocated chronologically, so influence runs one way: hours
    // BEFORE the period (same workweek) decide how much of it is overtime;
    // hours AFTER it cannot touch what came earlier.
    const midWeek = period({
        periodStart: new Date("2026-08-19T07:00:00.000Z"), // Wed
        periodEnd: new Date("2026-08-27T07:00:00.000Z"), // Thu
    });

    // Monday of the period's own week: frozen, it feeds the OT walk.
    assert.equal(lockedPeriodFor([midWeek], new Date("2026-08-17T15:00:00.000Z"))?.id, "pp1");
    // The PREVIOUS Mon-Sun week: not frozen, a different week entirely.
    assert.equal(lockedPeriodFor([midWeek], new Date("2026-08-16T15:00:00.000Z")), null);
    // AFTER the period, same week: NOT frozen. It cannot change the locked
    // numbers, and freezing it made two adjacent periods overlap at the seam.
    assert.equal(lockedPeriodFor([midWeek], new Date("2026-08-28T15:00:00.000Z")), null);
});

test("two adjacent periods do not freeze each other's days", () => {
    // The regression this rule exists for: the second of two consecutive
    // periods could be neither exported nor locked.
    const first = period({
        id: "pp-first",
        periodStart: new Date("2026-08-16T07:00:00.000Z"),
        periodEnd: new Date("2026-08-30T07:00:00.000Z"),
    });
    // A punch inside the SECOND period is not frozen by the first one.
    assert.equal(lockedPeriodFor([first], new Date("2026-09-02T15:00:00.000Z")), null);
    // And the last instant of the first period still is.
    assert.equal(lockedPeriodFor([first], new Date("2026-08-29T15:00:00.000Z"))?.id, "pp-first");
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
        closeTimeEntry: async (id, userId, buildData) => guardedClose(id, userId, await buildData(INSIDE, { hourlyRate: 20, burdenRate: 5, role: "FIELD_CREW", name: "Owner", email: "owner@example.com", payType: "HOURLY" })),
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

// The per-writer allowlist that used to live here is gone. It only ever listed
// the writers somebody had remembered to add, so the four it did not know about
// (the logistics re-code, the review reprice, the change-order retag, the
// stale-DEFERRED flag) stayed unguarded while this file reported green.
// tests/payroll-writer-manifest.test.ts inverts it: it enumerates the writers
// that EXIST and fails when the set changes.


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
    dependencies.closeTimeEntry = async (id, userId, buildData, guard) => {
        // The guard carries the entry id (re-read FOR UPDATE inside the
        // transaction), the day it expects to lock, and the settlement that
        // must commit with it.
        assert.equal(guard.entryId, "te1");
        assert.equal(typeof guard.expectedDayKey, "string");
        assert.ok(guard.settle, "settlement must ride along in the close transaction");
        const hit = lockedPeriodFor([period()], INSIDE);
        if (hit) return { ok: false as const, locked: hit };
        updateCalls.push({ id });
        return { ok: true as const, entry: { id, userId, ...(await buildData(INSIDE, { hourlyRate: 20, burdenRate: 5, role: "FIELD_CREW", name: "Owner", email: "owner@example.com", payType: "HOURLY" })) } };
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
    assert.match(patchHalf, /withPayrollWriteTx\([\s\S]{0,200}entryIds: \[id\][\s\S]{0,300}dayKeys: \[/);
    // The edit and the day re-plan it triggers commit together.
    assert.match(patchHalf, /settleDayWithinTx\(/);
    // DELETE: the guard runs inside deleteEntryAndSettle's own transaction, and
    // locks the day before the row (the global order).
    assert.match(deleteHalf, /assertEntriesUnlockedInTx\(tx, \[id\], \{ dayKeys \}\)/);
    assert.match(deleteHalf, /dayLockKey\(/);
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
    assert.match(source, /export async function acquirePayrollLocks/);
    assert.match(source, /export async function assertEntriesUnlockedInTx/);
    // The public shape takes entry IDS, not pre-read dates, so a caller cannot
    // pass a stale timestamp even by accident.
    assert.match(source, /export type PayrollLockTarget = \{/);
    assert.match(source, /entryIds\?: string\[\];/);
});

test("lock and unlock are keyed on stable day keys, and a locked period is not re-lockable", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");

    const lock = source.slice(source.indexOf("export async function lockPayrollPeriod"));
    const lockBody = lock.slice(0, lock.indexOf("\nexport "));
    // Re-locking would overwrite lockedAt, the locker, the hash and BOTH
    // snapshots — rewriting the payroll audit after mutable inputs changed.
    // Checked before the transaction AND inside it (two concurrent locks would
    // both pass the outer check).
    assert.match(lockBody, /precheck\.period\?\.lockedAt/);
    assert.match(lockBody, /if \(existing\?\.lockedAt\)/);
    assert.match(lockBody, /periodStartKey_periodEndKey/);

    const unlock = source.slice(source.indexOf("export async function unlockPayrollPeriod"));
    const unlockBody = unlock.slice(0, unlock.indexOf("\n}"));
    // Matched on keys, and a zero-row update is reported as a failure rather
    // than a silent success.
    assert.match(unlockBody, /periodStartKey: range\.startKey/);
    assert.match(unlockBody, /unlocked\.count === 0/);
    assert.doesNotMatch(unlockBody, /startOfDateInTimeZone/, "unlock must not reconstruct timestamps");
});

test("LOCK ORDER: payroll advisory lock is taken BEFORE any row lock", async () => {
    // A writer holding a row while waiting on the payroll lock, against a
    // locker holding payroll and waiting on that row, is a deadlock. Postgres
    // would abort one at random — possibly the lock. Order is the whole defence.
    const order: string[] = [];
    const tx = {
        $executeRawUnsafe: async (query: string) => {
            order.push(query.includes("_shared") ? "payroll-shared" : "advisory-other");
            return 0;
        },
        $queryRawUnsafe: async (query: string) => {
            if (String(query).includes("FOR UPDATE")) order.push("row-lock");
            return [{ startTime: INSIDE }];
        },
        payrollPeriod: {
            findMany: async () => {
                order.push("read-periods");
                return [];
            },
        },
    };
    const { assertEntriesUnlockedInTx } = await import("../src/lib/payroll-period");
    await assertEntriesUnlockedInTx(tx, ["te1"]);
    assert.deepEqual(order, ["payroll-shared", "row-lock", "read-periods"]);
});

test("the entry guard validates the row's STORED startTime, not anything passed in", async () => {
    const { assertEntriesUnlockedInTx, isPeriodLockedError } = await import("../src/lib/payroll-period");
    const tx = {
        $executeRawUnsafe: async () => 0,
        // The DB says this row sits INSIDE the locked period, whatever the
        // caller believed when it read the row earlier.
        $queryRawUnsafe: async () => [{ startTime: INSIDE }],
        payrollPeriod: { findMany: async () => [period()] },
    };
    await assert.rejects(() => assertEntriesUnlockedInTx(tx, ["te1"]), (e: Error) => isPeriodLockedError(e));

    // And an unlocked row passes.
    const free = { ...tx, payrollPeriod: { findMany: async () => [period({ lockedAt: null })] } };
    await assertEntriesUnlockedInTx(free, ["te1"]);
});

test("DELETE guards on the entry ID, re-reading the stored time inside the transaction", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    const deleteHalf = source.slice(source.indexOf("export async function DELETE"));
    assert.match(deleteHalf, /assertEntriesUnlockedInTx\(tx, \[id\], \{/);
    assert.match(deleteHalf, /dayLockKey\(/, "the day must be locked before the row");
});

test("settlement takes the payroll lock BEFORE the wa-breaks day lock", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "wa-breaks-db.ts"), "utf8");
    for (const fn of ["export async function settleDay(", "export async function settleDayWithinTx("]) {
        const body = source.slice(source.indexOf(fn));
        const guardAt = body.indexOf("assertSettlementDayUnlocked");
        const dayLockAt = body.indexOf("dayLockKey(");
        assert.ok(guardAt > 0 && dayLockAt > 0, fn);
        assert.ok(guardAt < dayLockAt, `${fn}: payroll lock must precede the day lock`);
    }
});

test("a period cannot be locked until its whole OT envelope has elapsed", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const lock = source.slice(source.indexOf("export async function lockPayrollPeriod"));
    const body = lock.slice(0, lock.indexOf(String.fromCharCode(10) + "export "));
    // Hours still to be worked in the trailing workweek change how much of the
    // period is overtime, so freezing now freezes an unfinished number.
    assert.match(body, /envelope\.end\.getTime\(\) > Date\.now\(\)/);
    assert.match(body, /not over yet/);
    // And overlapping ENVELOPES are refused, not just overlapping periods.
    assert.match(body, /precheck\.overlappingLocks\.length > 0/);
});

test("the close is priced from the STORED startTime and compare-and-set on it", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "app", "api", "time-entries", "route.ts"), "utf8");
    const dep = source.slice(source.indexOf("closeTimeEntry: async (id, userId, buildData, guard)"));
    const body = dep.slice(0, dep.indexOf(LF + "    },"));
    // Read the row, price from what it says, and refuse to write if it moved
    // underneath us — a close computed from a pre-transaction read would price
    // a shift that had since been shifted to another day.
    assert.match(body, /SELECT "startTime" FROM "TimeEntry" WHERE "id" = \$1/);
    assert.match(body, /await buildData\(stored\.startTime, lockedOwner\)/);
    assert.match(body, /startTime: stored\.startTime/, "the claim must CAS on startTime");
    assert.match(body, /moved: true/);
    // PeriodLockedError leaves the transaction so the write rolls back; it is
    // converted to a result OUTSIDE. Catching it inside would commit.
    assert.ok(
        body.indexOf("} catch (error) {") > body.indexOf("await prisma.$transaction"),
        "the lock error must be caught outside the transaction"
    );
});

test("day locks are taken before row locks, in sorted order", async () => {
    const seen: string[] = [];
    const tx = {
        $executeRawUnsafe: async (query: string, key?: string) => {
            seen.push(query.includes("_shared") ? "payroll" : `day:${key}`);
            return 0;
        },
        $queryRawUnsafe: async () => {
            seen.push("rows");
            return [];
        },
        payrollPeriod: { findMany: async () => [] },
    };
    const { acquirePayrollLocks } = await import("../src/lib/payroll-period");
    await acquirePayrollLocks(tx, { dayKeys: ["wa-breaks:u1:2026-08-20", "wa-breaks:u1:2026-08-18"], entryIds: ["b", "a"] });
    assert.deepEqual(seen, [
        "payroll",
        "day:wa-breaks:u1:2026-08-18",
        "day:wa-breaks:u1:2026-08-20",
        "rows",
    ]);
});

test("the lock action re-checks period overlap INSIDE the transaction", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const lock = source.slice(source.indexOf("export async function lockPayrollPeriod"));
    const body = lock.slice(0, lock.indexOf(LF + "export "));
    const exclusiveAt = body.indexOf("acquirePayrollLockCreationLock");
    const recheckAt = body.indexOf("rangeConflicts");
    assert.ok(exclusiveAt > 0 && recheckAt > exclusiveAt, "the re-check must follow the exclusive lock");
    assert.match(body, /FOR UPDATE/);
});

/**
 * TODO (needs a real Postgres): the ordering and overlap guarantees above are
 * pinned here by injected sequence and by source, which proves the code takes
 * the locks in the right order but not that Postgres BLOCKS a second
 * connection. A true two-connection regression test — one transaction holding
 * the shared lock while another tries to create a period lock, and two
 * concurrent overlapping lock attempts — needs the throwaway database the CI
 * "Migrations reproduce production" job already builds. Left as a marked gap
 * rather than a test that pretends to cover it.
 */
test("concurrency guarantees needing a real database are recorded, not faked", () => {
    assert.ok(true);
});

test("OWNERSHIP overlap is judged on the pay-period range, not the OT envelope", () => {
    // Two consecutive periods necessarily share an OT envelope at the seam:
    // the envelope deliberately reaches into the neighbouring workweek so the
    // overtime split inside a locked period cannot move. Judging ownership on
    // it made the SECOND of two consecutive periods look like it overlapped the
    // first, so it could neither be exported nor locked.
    const db = readFileSync(path.join(__dirname, "..", "src", "lib", "gusto-export-db.ts"), "utf8");
    assert.match(db, /findOverlappingLockedPeriods\(startKey, endKey, client\)/);
    assert.doesNotMatch(db, /findOverlappingLockedPeriods\(envelope\.start, envelope\.end/);

    const actions = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const lock = actions.slice(actions.indexOf("export async function lockPayrollPeriod"));
    const body = lock.slice(0, lock.indexOf(LF + "export "));
    assert.match(body, /rangeConflicts/);
    // Compared on the stable day keys — see the dedicated test below.
    assert.match(body, /"periodStartKey" < \$\{range\.endKey\}/);
    // Freezing still uses the envelope — the two questions stay separate.
    assert.match(body, /envelope\.end\.getTime\(\) > Date\.now\(\)/);
});

test("consecutive Sunday-start periods do not own each other's days", async () => {
    const { payrollLockEnvelope } = await import("../src/lib/payroll-config");
    const TZ = "America/Los_Angeles";
    // Sun 08-16 -> Sun 08-30, then Sun 08-30 -> Sun 09-13. Adjacent, never
    // overlapping: half-open ranges share only the boundary instant.
    const firstStart = new Date("2026-08-16T07:00:00.000Z");
    const firstEnd = new Date("2026-08-30T07:00:00.000Z");
    const secondStart = firstEnd;
    const secondEnd = new Date("2026-09-13T07:00:00.000Z");
    assert.ok(firstEnd.getTime() <= secondStart.getTime(), "ranges are adjacent, not overlapping");

    // Their ENVELOPES, however, do overlap — which is exactly why ownership
    // must not be judged on them.
    const a = payrollLockEnvelope(firstStart, firstEnd, TZ);
    const b = payrollLockEnvelope(secondStart, secondEnd, TZ);
    assert.ok(a.end.getTime() > b.start.getTime(), "premise: the envelopes really do overlap at the seam");
});

test("the lock binds to the hash the reviewer was shown", () => {
    const actions = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const lock = actions.slice(actions.indexOf("export async function lockPayrollPeriod"));
    const body = lock.slice(0, lock.indexOf(LF + "export "));
    // Both internal hashes can agree with each other and still disagree with
    // what was on the page the human clicked from.
    // REQUIRED, and shape-checked: an optional comparison is one a caller can
    // skip by sending nothing, which is exactly how a period gets frozen around
    // numbers nobody approved.
    assert.match(body, /reviewedExportHash: string/);
    assert.doesNotMatch(body, /reviewedExportHash\?: string/);
    assert.match(body, /\/\^\[0-9a-f\]\{64\}\$\//);
    assert.match(body, /confirmed\.exportHash !== reviewedExportHash/);
    assert.doesNotMatch(body, /reviewedExportHash && confirmed/, "the check must be unconditional");
    assert.match(body, /refresh, check the numbers again/);

    // And the page hands it over, from a client component that can actually
    // show the refusal (an inline server-action form discards the result).
    const controls = readFileSync(
        path.join(__dirname, "..", "src", "app", "manager", "payroll-export", "PayrollLockControls.tsx"),
        "utf8"
    );
    assert.match(controls, /"use client"/);
    assert.match(controls, /lockPayrollPeriod\(startKey, endKeyExclusive, reviewedExportHash\)/);
    assert.match(controls, /toast\.error/);
    const page = readFileSync(
        path.join(__dirname, "..", "src", "app", "manager", "payroll-export", "page.tsx"),
        "utf8"
    );
    assert.match(page, /reviewedExportHash=\{result\.exportHash\}/);
    assert.doesNotMatch(page, /await lockPayrollPeriod\(/, "no inline form action — it would swallow the error");
});

test("PATCH re-reads the row and compare-and-sets on updatedAt", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    const patchHalf = source.slice(0, source.indexOf("export async function DELETE"));
    // Day locks are derived from BOTH the stored value and the new one, and the
    // row is re-read under the FOR UPDATE those locks were taken with.
    assert.match(patchHalf, /SELECT "startTime", "updatedAt" FROM "TimeEntry" WHERE "id" = \$1/);
    assert.match(patchHalf, /stored\.startTime\.getTime\(\) !== existing\.startTime\.getTime\(\)/);
    // CAS on updatedAt: a concurrent write can change endTime, the meal
    // outcome or the attestations WITHOUT moving startTime, and this edit
    // recomputed duration and cost from a copy read before any of that.
    assert.match(patchHalf, /updateMany\(\{[\s\S]{0,160}updatedAt: stored\.updatedAt/);
    assert.match(patchHalf, /SELECT "startTime", "updatedAt" FROM "TimeEntry"/);
    assert.match(patchHalf, /EntryMovedError/);
    assert.match(source, /code: "ENTRY_MOVED"/);
});

test("the project timeclock actions parse date-only input in the company zone", () => {
    // new Date("2026-07-27") is UTC midnight — the 26th here. The punch would
    // land on the wrong day, in the wrong workweek, possibly the wrong period.
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "projects", "[id]", "timeclock", "actions.ts"),
        "utf8"
    );
    assert.doesNotMatch(source, /new Date\(data\.date\)/);
    assert.equal((source.match(/dateInputInTimeZone\(data\.date, timeZone/g) ?? []).length, 2, "create AND update");
});

test("DELETE locks every candidate day before the row, and retries once if it moves", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    const deleteHalf = source.slice(source.indexOf("export async function DELETE"));
    // deleteEntryAndSettle re-plans BOTH the day it was told about and the day
    // it actually finds, so both have to be locked up front — in sorted order,
    // like every other path.
    assert.match(deleteHalf, /dayLockKey\(existing\.userId, toCompanyDayKey\(existing\.startTime\)\)/);
    assert.match(deleteHalf, /dayLockKey\(fresh\.userId, toCompanyDayKey\(fresh\.startTime\)\)/);
    assert.match(deleteHalf, /\]\)\]\.sort\(\)/);
    // One retry from a FRESH read, then give up: looping would hold locks while
    // whatever is rewriting the row keeps rewriting it.
    assert.match(deleteHalf, /deleteOnce\(0\)\) === "moved" && \(await deleteOnce\(1\)\) === "moved"/);
    assert.match(deleteHalf, /code: "ENTRY_MOVED"/);
});

test("the project timeclock action never accepts a caller-supplied cost", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "projects", "[id]", "timeclock", "actions.ts"),
        "utf8"
    );
    // A server action's arguments are an HTTP body: any cost posted from the
    // client could be anything, against anyone, straight into payroll.
    // The ACTION's parameter object must not carry it (the pricing helper's
    // own return type legitimately does).
    const createSig = source.slice(source.indexOf("export async function createTimeEntry(data: {"));
    assert.doesNotMatch(createSig.slice(0, createSig.indexOf("}")), /laborCost/);
    const updateSig = source.slice(source.indexOf("export async function updateTimeEntry(id: string, data: {"));
    assert.doesNotMatch(updateSig.slice(0, updateSig.indexOf("}")), /laborCost/);
    assert.doesNotMatch(source, /laborCost: data\.laborCost/);
    // Priced INSIDE the write transaction now, from a row-locked read.
    assert.match(source, /priceManualEntry\(tx, data\.userId, durationHours, acknowledgeZeroRate\)/);
    // Derived from the STORED rates, with the same $0 policy as every other
    // write path: refused unless explicitly acknowledged, then flagged.
    assert.match(source, /readOwnerRatesForUpdate\(tx, userId, toNum\)/);
    assert.match(source, /zeroRateBlocks\(/);
    assert.match(source, /zeroRate && !acknowledgeZeroRate/);
    assert.match(source, /appendZeroRateReview\(null\)/);

    // The client stopped sending one too.
    const client = readFileSync(
        path.join(__dirname, "..", "src", "app", "projects", "[id]", "timeclock", "TimeClockClient.tsx"),
        "utf8"
    );
    assert.doesNotMatch(client, /laborCost: cost/);
});

test("the guarded writers really are wrapped, not merely listed", () => {
    // Complements the manifest: that test proves nobody added a writer without
    // classifying it; this one proves the classification is not a fiction.
    const cases: Array<[string, RegExp]> = [
        ["lib/actions.ts", /withPayrollWrite\({ entryIds: \[entryId\] }/],
        ["lib/time-expense-core.ts", /withPayrollWrite\({ entryIds: input\.ids }/],
        ["app/api/time-entries/[id]/logistics/route.ts", /withPayrollWrite\({ entryIds: \[id\] }/],
        ["app/api/time-entries/[id]/meal-skip/route.ts", /withPayrollWrite\({ entryIds: \[id\] }/],
        ["app/api/time-entries/route.ts", /withPayrollWrite\({ entryIds: \[latest\.id\] }/],
    ];
    for (const [file, pattern] of cases) {
        const source = readFileSync(path.join(__dirname, "..", "src", ...file.split("/")), "utf8");
        assert.match(source, pattern, `${file} claims to be guarded`);
    }
});

test("markTimeEntryReviewed cannot clear a zero-rate flag without repricing", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function markTimeEntryReviewed"));
    const body = fn.slice(0, fn.indexOf(LF + "export "));
    // It is the one write that can turn a flagged $0 shift into an exportable
    // one, so it re-checks the rate, reprices, AND takes the payroll lock.
    assert.match(body, /ZERO_RATE_REVIEW_NOTE/);
    assert.match(body, /zeroRateBlocks\(/);
    assert.match(body, /withPayrollWrite\(/);
    // Re-read row-locked, repriced from THAT read, and compare-and-set.
    assert.match(body, /FROM "TimeEntry" WHERE "id" = \$1/);
    assert.match(body, /updatedAt: live\.updatedAt/);
});

test("PATCH applies the zero-rate guard to ANY cost recomputation, not just a close", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "[id]", "route.ts"),
        "utf8"
    );
    // Shrinking an 8h entry to 4h at a $0 rate rewrites the cost just as
    // silently as closing one does; `closingOpenEntry &&` let that through.
    assert.match(source, /const recomputesCost = newEnd != null;/);
    assert.match(source, /recomputesCost &&\s*\n\s*zeroRateBlocks\(/);
    // And the owner's rate is re-read, row-locked, INSIDE the write transaction:
    // a rate import could zero it between the pre-read and the write.
    // The row-locked read lives in the shared helper now.
    assert.match(source, /readOwnerRatesForUpdate\(/);
    assert.match(source, /ZeroRateAtWriteError/);
});

test("period ownership is compared on STABLE day keys, never timestamps", () => {
    // Timestamps are derived from company-local days, so they shift when the
    // company time zone changes — and an overlap test on shifted values gives a
    // different answer for the same two periods than it did yesterday.
    const db = readFileSync(path.join(__dirname, "..", "src", "lib", "gusto-export-db.ts"), "utf8");
    const fn = db.slice(db.indexOf("export async function findOverlappingLockedPeriods"));
    const body = fn.slice(0, fn.indexOf(LF + "}"));
    assert.match(body, /periodStartKey: \{ lt: endKey \}/);
    assert.match(body, /periodEndKey: \{ gt: startKey \}/);
    assert.doesNotMatch(body, /periodStart: \{ lt:/, "must not compare timestamps");

    const actions = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const lock = actions.slice(actions.indexOf("export async function lockPayrollPeriod"));
    const lockBody = lock.slice(0, lock.indexOf(LF + "export "));
    // BOTH transactional checks, not just one of them.
    assert.match(lockBody, /"periodStartKey" < \$\{range\.endKey\}[\s\S]{0,120}"periodEndKey" > \$\{range\.startKey\}/);
    assert.doesNotMatch(lockBody, /"periodStart" < \$\{periodEnd\}/, "no timestamp comparison survives");
});

test("a locked period's downloads stay enabled regardless of live blockers", () => {
    // The snapshot exists precisely so a locked period can still be downloaded
    // after its entries move; disabling on live blockers made that impossible.
    const page = readFileSync(
        path.join(__dirname, "..", "src", "app", "manager", "payroll-export", "page.tsx"),
        "utf8"
    );
    assert.match(page, /const servesSnapshot = !!result\.snapshot;/);
    assert.match(page, /const blocked = !servesSnapshot && \(result\.blocking\.length > 0 \|\| overlapsLock\);/);
});

test("a former employee's pay type can be answered without reactivating them", () => {
    const actions = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const fn = actions.slice(actions.indexOf("export async function setUserPayType"));
    const body = fn.slice(0, fn.indexOf(LF + "}"));
    // Re-activating a leaver to unblock payroll puts them back on the dispatch
    // board and in every picker — a worse cure than the disease.
    assert.match(body, /options: \{ historical\?: boolean \} = \{\}/);
    assert.match(body, /options\.historical \? \{ id: userId \} : \{ id: userId, status: \{ not: "DISABLED" \} \}/);
    // And status is never in the update.
    assert.doesNotMatch(body, /data: \{ payType, status/);

    const panel = readFileSync(
        path.join(__dirname, "..", "src", "app", "company", "team-members", "page.tsx"),
        "utf8"
    );
    assert.match(panel, /Historical payroll/);
    assert.match(panel, /setUserPayType\(user\.id, value, \{ historical: true \}\)/);
    assert.match(panel, /historicalFrom=/);
});

test("updateTimeEntry derives cost from stored rates inside the transaction", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "time-expense-actions.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function updateTimeEntry"));
    const body = fn.slice(0, fn.indexOf(LF + "export "));
    // A server action's arguments are an HTTP body: laborCost as a parameter
    // let a caller post any cost against any worker.
    assert.doesNotMatch(body, /laborCost: number;/);
    assert.doesNotMatch(body, /laborCost: data\.laborCost/);
    assert.match(body, /priceEntryFromStoredRates\(/);
    // Read FOR UPDATE inside the write transaction, so a concurrent rate change
    // cannot land between the read and the write.
    assert.match(source, /readOwnerRatesForUpdate\(/);
    assert.match(source, /zeroRateBlocks\(/);
});

test("the canonical manual create prices INSIDE its payroll transaction", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "time-expense-core.ts"), "utf8");

    // createTimeEntryFromStoredRatesCore reads nothing itself any more: a rate
    // import landing between its read and the insert produced an entry created
    // at a rate that was no longer true.
    const wrapper = source.slice(source.indexOf("export async function createTimeEntryFromStoredRatesCore"));
    const wrapperBody = wrapper.slice(0, wrapper.indexOf(LF + "}"));
    assert.doesNotMatch(wrapperBody, /prisma\.user\.findUnique/);
    assert.match(wrapperBody, /priceFromStoredRates: true/);

    // The rates, the $0 decision and both costs all resolve in the write
    // transaction, from a row-locked read.
    const core = source.slice(source.indexOf("export async function createTimeEntryCore"));
    const coreBody = core.slice(0, core.indexOf(LF + "export "));
    assert.match(coreBody, /withPayrollWriteTx\(/);
    const txAt = coreBody.indexOf("withPayrollWriteTx(");
    assert.ok(coreBody.indexOf("readOwnerRatesForUpdate(") > txAt, "the rate read must be INSIDE the transaction");
    assert.ok(coreBody.indexOf("calculateCrewTimeCosts(") > txAt, "and so must the pricing");
    assert.match(coreBody, /zeroRate && data\.acknowledgeZeroRate !== true/);
    assert.match(coreBody, /appendZeroRateReview\(null\)/);
    // One transaction: the insert is in the same callback.
    assert.ok(coreBody.indexOf("timeEntry.create(") > txAt);
});
