/**
 * The ONE pay-rate write path (src/lib/pay-rate-write.ts).
 *
 * Rates used to be written from three routes, each with its own permission
 * check, its own Number() conversion, and only one of them stamping
 * lastRateSyncAt. These tests pin the single path: who may write, what parses,
 * and that the staleness stamp cannot be skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyRateChange, applyRateChangeInTx, canWriteRates } from "../src/lib/pay-rate-write";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-pay-rate-write-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

function fakeClient() {
    const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const locks: string[] = [];
    // Every lock statement in order, advisory and row alike — the ORDER is the
    // thing that has to hold (payroll advisory first, then the row).
    const lockOrder: string[] = [];
    return {
        writes,
        // A transaction, because the real write takes the exclusive row lock and
        // updates in one atomic step. `locks` records that it did.
        locks,
        lockOrder,
        client: {
            $transaction: async (fn: any) =>
                fn({
                    user: { update: async (args: any) => { writes.push(args); return {}; } },
                    $queryRawUnsafe: async (_q: string, id: string) => { locks.push(id); lockOrder.push(`row:${id}`); return [{ id }]; },
                    $executeRawUnsafe: async (_q: string, key: string) => { lockOrder.push(`advisory:${key}`); return 0; },
                }),
        },
    };
}

const ADMIN = { role: "ADMIN" };
const FINANCE_REPORTS = { role: "FINANCE", permissions: { financialReports: true } };
const PLAIN_MANAGER = { role: "MANAGER", permissions: { financialReports: false } };
const FINANCE_NO_REPORTS = { role: "FINANCE", permissions: { financialReports: false } };
const CREW = { role: "FIELD_CREW", permissions: { financialReports: false } };

test("the rate gate is EXACTLY the payroll export's gate", () => {
    assert.equal(canWriteRates(ADMIN), true);
    assert.equal(canWriteRates(FINANCE_REPORTS), true);
    // A FINANCE user WITHOUT financialReports is refused — that is the part
    // Phase 5 tightened.
    assert.equal(canWriteRates(FINANCE_NO_REPORTS), false);
    assert.equal(canWriteRates(CREW), false);
    assert.equal(canWriteRates(null), false);
    // A MANAGER passes, because hasPermission grants managers everything
    // app-wide (access-rules.ts). Not a new grant — managers could already
    // write rates — and deliberately identical to the export's own check so the
    // rates panel and the download cannot disagree about who may act.
    assert.equal(canWriteRates(PLAIN_MANAGER), true);
});

test("a payload with no rate fields needs no payroll permission and writes nothing", async () => {
    const { writes, client } = fakeClient();
    const result = await applyRateChange(CREW, "u1", {}, client);
    assert.deepEqual(result, { ok: true, changed: false });
    assert.equal(writes.length, 0, "an ordinary profile edit must not be blocked");
});

test("a caller without payroll access cannot change a rate", async () => {
    const { writes, client } = fakeClient();
    const result = await applyRateChange(CREW, "u1", { hourlyRate: "31.00" }, client);
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 403);
    assert.equal(writes.length, 0);
});

test("every rate write stamps lastRateSyncAt, bumps payrollRevision, and stores an exact decimal", async () => {
    const { writes, client } = fakeClient();
    const result = await applyRateChange(ADMIN, "u1", { hourlyRate: "28.5", burdenRate: "6" }, client);
    assert.deepEqual(result, { ok: true, changed: true });
    const data = writes[0].data;
    // Prisma.Decimal, not a float — a rate must never round-trip through one.
    assert.equal(String(data.hourlyRate), "28.5");
    assert.equal(String(data.burdenRate), "6");
    assert.ok(data.lastRateSyncAt instanceof Date, "the staleness stamp cannot be skipped for an actual rate confirmation");
    assert.deepEqual(data.payrollRevision, { increment: 1 }, "the replay counter moves on every payroll-affecting write");
});

test("sub-cent, exponent and out-of-range rates are refused, not rounded", async () => {
    const { writes, client } = fakeClient();
    for (const bad of ["28.005", "1e2", "-1", "99999", "abc"]) {
        const result = await applyRateChange(ADMIN, "u1", { hourlyRate: bad }, client);
        assert.equal(result.ok, false, bad);
    }
    assert.equal(writes.length, 0);
});

test("pay type rides the same path, and only accepts the two real values", async () => {
    const { writes, client } = fakeClient();
    assert.equal((await applyRateChange(ADMIN, "u1", { payType: "SALARY" }, client)).ok, true);
    assert.equal(writes[0].data.payType, "SALARY");
    // Round-32 gate: a pay-type-only change must NOT stamp lastRateSyncAt —
    // that field means "a rate was actually confirmed", and this write never
    // touches hourlyRate/burdenRate. A stale Gusto approval (signed over the
    // old rate + pay type + old REVISION) still must not be replayable by a
    // write that only touches payType — payrollRevision is what advances now.
    assert.equal("lastRateSyncAt" in writes[0].data, false, "a pay-type-only write must not advance the rate-confirmed stamp");
    assert.deepEqual(writes[0].data.payrollRevision, { increment: 1 }, "the replay counter still advances on a pay-type-only write");
    assert.equal((await applyRateChange(ADMIN, "u1", { payType: "GUESS" }, client)).ok, false);
});

// ── Rate writes serialize against settlement (review round 18, item 2) ──────

test("a rate write takes the EXCLUSIVE row lock before updating, in one transaction", async () => {
    const { writes, locks, client } = fakeClient();
    const result = await applyRateChange(ADMIN, "u1", { hourlyRate: "31.00" }, client);
    assert.deepEqual(result, { ok: true, changed: true });
    assert.deepEqual(locks, ["u1"], "settlement holds FOR SHARE on this row while it reprices a day");
    assert.equal(writes.length, 1);
});

test("the lock is taken BEFORE the write, not after it", async () => {
    const order: string[] = [];
    const client = {
        $transaction: async (fn: any) =>
            fn({
                user: { update: async () => { order.push("write"); return {}; } },
                $queryRawUnsafe: async (q: string, id: string) => {
                    order.push(q.includes("FOR UPDATE") ? "lock" : "read");
                    return [{ id }];
                },
                $executeRawUnsafe: async () => { order.push("payroll"); return 0; },
            }),
    };
    await applyRateChange(ADMIN, "u1", { hourlyRate: "31.00" }, client as never);
    assert.deepEqual(
        order,
        ["payroll", "lock", "write"],
        "a lock taken after the write serializes nothing — and the payroll lock comes before the row lock"
    );
});

test("a refused write never reaches the transaction at all", async () => {
    let opened = false;
    const client = { $transaction: async (fn: any) => { opened = true; return fn({} as never); } };
    const result = await applyRateChange(CREW, "u1", { hourlyRate: "31.00" }, client as never);
    assert.equal(result.ok, false);
    assert.equal(opened, false);
});

test("settlement reads the owner's rates FOR SHARE, from the same helper family", () => {
    const guard = readFileSync(path.join(process.cwd(), "src/lib/pay-rate-guard.ts"), "utf8");
    // FOR SHARE, not FOR UPDATE: two settlements for different days may run at
    // once. Only a rate WRITER has to be excluded.
    assert.match(guard, /FROM "User" WHERE "id" = \$1 FOR SHARE/);
    assert.match(guard, /FROM "User" WHERE "id" = \$1 FOR UPDATE/);

    const settle = readFileSync(path.join(process.cwd(), "src/lib/wa-breaks-db.ts"), "utf8");
    const fn = settle.slice(settle.indexOf("async function settleDayInTx"));
    assert.match(fn, /readOwnerRatesForShare\(tx as never, userId, toNum\)/);
    // The plain unlocked read is gone — that is what let a rate import commit
    // halfway through a multi-entry day.
    assert.doesNotMatch(fn.slice(0, fn.indexOf("const rows =")), /tx\.user\.findUnique/);
});

test("the rate import locks every affected row, in a stable order", () => {
    const actions = readFileSync(path.join(process.cwd(), "src/lib/actions.ts"), "utf8");
    const fn = actions.slice(actions.indexOf("export async function applyGustoRateImport"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    assert.match(body, /lockOwnerRowForUpdate\(tx as never, row\.userId\)/);
    // Sorted, or two concurrent imports touching the same two people in
    // different orders deadlock on each other.
    assert.match(body, /\[\.\.\.clean\]\.sort\(\(a, b\) => a\.userId\.localeCompare\(b\.userId\)\)/);
    // Locks first, then the compare-and-set writes.
    assert.ok(body.indexOf("lockOwnerRowForUpdate") < body.indexOf("tx.user.updateMany"));
});

test("a pay-type-only write through the user PATCH route's shape leaves lastRateSyncAt alone and advances payrollRevision", async () => {
    // Mirrors exactly the payload src/app/api/users/[id]/route.ts (and the
    // manager employees / users POST routes) hand to applyRateChangeInTx: an
    // edit that carries payType but leaves hourlyRate and burdenRate
    // undefined. Round-31 made this ALSO stamp lastRateSyncAt so a stale
    // Gusto-import approval could not be replayed by a payType-only PATCH —
    // but that broke lastRateSyncAt's OWN meaning ("a rate was confirmed"),
    // which the round-32 gate flagged. payrollRevision now carries the replay
    // protection instead, and lastRateSyncAt goes back to rate-only.
    const { writes, client } = fakeClient();
    const result = await applyRateChange(
        ADMIN,
        "u1",
        { hourlyRate: undefined, burdenRate: undefined, payType: "HOURLY" },
        client
    );
    assert.deepEqual(result, { ok: true, changed: true });
    assert.equal(writes[0].data.payType, "HOURLY");
    assert.equal("lastRateSyncAt" in writes[0].data, false);
    assert.deepEqual(writes[0].data.payrollRevision, { increment: 1 });
});

// ── The opener vs the in-transaction worker (review round 19, item 1) ───────

test("applyRateChangeInTx does NOT open a transaction — a tx has no $transaction", async () => {
    // The crash this pins: every route runs its rate write inside its own
    // interactive transaction, and an interactive Prisma client has no
    // $transaction method. A version that opened one unconditionally threw
    // TypeError on every rate edit, and type-checked only because the call
    // sites cast their tx with `as never`.
    const writes: unknown[] = [];
    const tx = {
        user: { update: async (args: unknown) => { writes.push(args); return {}; } },
        $queryRawUnsafe: async (_q: string, id: string) => [{ id }],
        $executeRawUnsafe: async () => 0,
        // Deliberately absent: $transaction. Reaching for it is the bug.
    };
    const result = await applyRateChangeInTx(tx, ADMIN, "u1", { hourlyRate: "31.00" });
    assert.deepEqual(result, { ok: true, changed: true });
    assert.equal(writes.length, 1);
});

test("no call site casts its tx away any more", () => {
    for (const file of [
        "src/app/api/manager/employees/[id]/route.ts",
        "src/app/api/users/route.ts",
        "src/app/api/users/[id]/route.ts",
    ]) {
        const source = readFileSync(path.join(process.cwd(), file), "utf8");
        // `tx as never` is what let the wrong function be called for a whole
        // round without tsc noticing.
        assert.doesNotMatch(source, /tx as never/, file);
        assert.match(source, /applyRateChangeInTx\(\s*\n\s*tx,/, file);
        assert.doesNotMatch(source, /\bapplyRateChange\(/, `${file}: routes use the InTx variant`);
    }
});

test("applyRateChange is the ONLY opener, and refuses before taking a connection", async () => {
    let opened = false;
    const client = {
        $transaction: async (fn: any) => {
            opened = true;
            return fn({
                user: { update: async () => ({}) },
                $queryRawUnsafe: async (_q: string, id: string) => [{ id }],
                $executeRawUnsafe: async () => 0,
            });
        },
    };
    // Refused: never opens.
    const refused = await applyRateChange(CREW, "u1", { hourlyRate: "31.00" }, client as never);
    assert.equal(refused.ok, false);
    assert.equal(opened, false);

    // Allowed: opens exactly one.
    const allowed = await applyRateChange(ADMIN, "u1", { hourlyRate: "31.00" }, client as never);
    assert.deepEqual(allowed, { ok: true, changed: true });
    assert.equal(opened, true);
});

test("a payload with no rate fields still short-circuits without a transaction", async () => {
    let opened = false;
    const client = { $transaction: async (fn: any) => { opened = true; return fn({} as never); } };
    const result = await applyRateChange(CREW, "u1", {}, client as never);
    assert.deepEqual(result, { ok: true, changed: false });
    assert.equal(opened, false, "an ordinary profile edit must not need payroll permission OR a transaction");
});

// ── The payroll advisory lock (round 33, finding 1) ─────────────────────────

test("a rate or pay-type write takes the PAYROLL advisory lock, before the row lock", async () => {
    // The race this closes: lockPayrollPeriod holds the EXCLUSIVE payroll
    // advisory lock while it recomputes the CSVs and hashes them. A rate or
    // pay-type write that took only the row lock could commit inside that
    // window, so the period was frozen around a roster that had already moved —
    // payType decides who is on the Gusto file at all.
    for (const change of [{ hourlyRate: "31.00" }, { payType: "SALARY" }, { burdenRate: "6.00" }]) {
        const { client, lockOrder } = fakeClient();
        const result = await applyRateChange(ADMIN, "u1", change, client as never);
        assert.equal(result.ok, true);
        assert.deepEqual(
            lockOrder,
            ["advisory:payroll-period", "row:u1"],
            `${JSON.stringify(change)}: payroll lock first, THEN the row — the order is what keeps it deadlock-free`
        );
    }
});

test("a refused write takes no lock at all", async () => {
    // Permission and validation are decided before anything is locked, so a
    // rejected profile edit never contends with a pay period being locked.
    const denied = fakeClient();
    assert.equal((await applyRateChange(CREW, "u1", { hourlyRate: "31.00" }, denied.client as never)).ok, false);
    assert.deepEqual(denied.lockOrder, []);

    const invalid = fakeClient();
    assert.equal((await applyRateChange(ADMIN, "u1", { hourlyRate: "2$8" }, invalid.client as never)).ok, false);
    assert.deepEqual(invalid.lockOrder, [], "a malformed rate is refused before the locks, not after");
});
