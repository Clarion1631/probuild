/**
 * deleteEntryAndSettleInTx (src/lib/wa-breaks-db.ts) with a fake transaction.
 *
 * Codex gate on PR #434: the route's owner/lock pre-check alone was a TOCTOU — an
 * invoice or QuickBooks sync landing between the check and the delete could still be
 * erased by a field worker. The owner path must (a) re-check the policy on the row as
 * read inside the transaction and (b) delete CONDITIONALLY, refusing a lost claim
 * with nothing deleted. The privileged path stays unconditional.
 *
 * wa-breaks-db imports @/lib/prisma, which reads env at load — set before the dynamic
 * import (no top-level await: tsx transpiles this file as CJS). No database is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeleteVictim } from "../src/lib/time-entry-delete-policy";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const load = () => import("../src/lib/wa-breaks-db");
const policy = () => import("../src/lib/time-entry-delete-policy");

// Fixed clock (Codex: `new Date()` inside the helper made "same day" flaky for the first
// hours after Pacific midnight). Every call passes `clock`, and createdAt === NOW.
const NOW = new Date("2026-08-30T19:00:00.000Z");
const clock = () => NOW;
const CREW = { id: "u-crew", role: "FIELD_CREW" };
type Row = DeleteVictim & { startTime: Date };

function row(overrides: Partial<Row> = {}): Row {
    return {
        userId: "u-crew",
        startTime: new Date(NOW.getTime() - 2 * 3_600_000),
        createdAt: NOW,
        invoiceId: null,
        invoicedAt: null,
        qbTimeActivityId: null,
        qbSyncedAt: null,
        ...overrides,
    };
}

/**
 * Fake `tx`: first findUnique returns `first`, later reads return `after` (defaults to
 * `first`) — that second read is the "explain the lost claim" path. deleteMany reports
 * `claimCount`. settleDayInTx's owner lookup returns null so it writes nothing.
 */
function fakeTx(opts: { first: Row | null; after?: Row | null; claimCount?: number }) {
    const calls: string[] = [];
    let reads = 0;
    const tx = {
        $executeRawUnsafe: async (_sql: string, key: string) => { calls.push(`lock:${key}`); return 0; },
        timeEntry: {
            findUnique: async () => { reads += 1; return reads === 1 ? opts.first : (opts.after === undefined ? opts.first : opts.after); },
            deleteMany: async (args: { where: Record<string, unknown> }) => { calls.push(`deleteMany:${JSON.stringify(args.where)}`); return { count: opts.claimCount ?? 1 }; },
            delete: async () => { calls.push("delete"); return {}; },
            findMany: async () => [],
            update: async () => { calls.push("update"); return {}; },
        },
        user: { findUnique: async () => null },
    };
    return { tx: tx as any, calls };
}

const dayOf = async (d: Date) => (await import("../src/lib/company-day")).toCompanyDayKey(d);
const boundsOf = async (d: Date) => { const cd = await import("../src/lib/company-day"); return cd.companyDayBounds(cd.toCompanyDayKey(d)); };

test("owner path: same-day unlinked entry is claimed with a conditional deleteMany", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row();
    const { tx, calls } = fakeTx({ first: victim });
    const result = await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock);
    assert.equal(result, "deleted");
    const claim = calls.find((c) => c.startsWith("deleteMany:"));
    assert.ok(claim, "used the conditional deleteMany");
    const where = JSON.parse(claim!.slice("deleteMany:".length));
    const today = await boundsOf(NOW);
    // The company-day window rides INSIDE the atomic delete (Codex round 2): a delete
    // that waits on a row lock across midnight must not remove yesterday's entry.
    assert.deepEqual(where, {
        id: "te1", userId: "u-crew", invoiceId: null, invoicedAt: null, qbTimeActivityId: null, qbSyncedAt: null,
        createdAt: { gte: today.start.toISOString(), lt: today.end.toISOString() },
    });
    assert.equal(calls.includes("delete"), false, "never the unconditional delete");
});

test("owner path: a claim lost while the re-read still passes the policy is reported as CLAIM_LOST, not a guessed reason", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const victim = row();
    // Row changed and changed back (or a writer is mid-flight): count 0, but nothing to blame.
    const { tx, calls } = fakeTx({ first: victim, after: row(), claimCount: 0 });
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "CLAIM_LOST"
    );
    assert.equal(calls.includes("update"), false);
});

test("owner path: the day is judged AFTER both locks — a clock that crosses midnight while locking refuses, no delete", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    // Row moved to another day so the second advisory lock is taken; the clock reads
    // pre-midnight when the route pre-checked and post-midnight once the locks are held.
    const victim = row({ startTime: new Date(NOW.getTime() - 3 * 24 * 3_600_000) });
    const knownDay = await dayOf(NOW);
    assert.notEqual(knownDay, await dayOf(victim.startTime));
    const { tx, calls } = fakeTx({ first: victim });
    const afterMidnight = () => new Date("2026-08-31T08:30:00.000Z"); // 01:30 PDT next day
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", knownDay, "u-crew", CREW, afterMidnight),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "NOT_TODAY"
    );
    assert.equal(calls.filter((c) => c.startsWith("lock:")).length, 2, "both day locks were taken before the refusal");
    assert.equal(calls.some((c) => c.startsWith("deleteMany")), false);
});

test("privileged path: a row that vanished between read and delete is 'gone', not a throw", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row({ userId: "u-other" });
    const { tx, calls } = fakeTx({ first: victim, claimCount: 0 });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-other", undefined, clock), "gone");
    assert.equal(calls.includes("update"), false, "no re-plan for a no-op");
});

test("owner path: a claim lost to an invoice/QBO sync throws LOCKED_DOWNSTREAM and deletes nothing", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const victim = row();
    const { tx, calls } = fakeTx({ first: victim, after: row({ qbSyncedAt: NOW }), claimCount: 0 });
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "LOCKED_DOWNSTREAM"
    );
    assert.equal(calls.includes("delete"), false);
    assert.equal(calls.includes("update"), false, "no re-plan after a refused delete");
});

test("owner path: a claim lost to a reassignment throws NOT_OWNER", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const victim = row();
    const { tx } = fakeTx({ first: victim, after: row({ userId: "u-other" }), claimCount: 0 });
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "NOT_OWNER"
    );
});

test("owner path: a claim lost because the row vanished reports 'gone'", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row();
    const { tx } = fakeTx({ first: victim, after: null, claimCount: 0 });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock), "gone");
});

test("owner path: the in-transaction re-check refuses BEFORE any delete is attempted", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000);
    for (const [victim, code] of [
        [row({ createdAt: yesterday }), "NOT_TODAY"],
        [row({ invoiceId: "inv1" }), "LOCKED_DOWNSTREAM"],
        [row({ userId: "u-other" }), "NOT_OWNER"],
    ] as Array<[Row, string]>) {
        const { tx, calls } = fakeTx({ first: victim });
        await assert.rejects(
            deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock),
            (err: unknown) => err instanceof DeleteRefusedError && err.code === code,
            code
        );
        assert.equal(calls.some((c) => c.startsWith("deleteMany") || c === "delete"), false, `${code}: nothing deleted`);
        assert.equal(calls.filter((c) => c.startsWith("lock:")).length >= 1, true, `${code}: refused only after the day lock was taken`);
    }
});

test("privileged path (no guard): unconditional delete, even of a locked, older, other-user row", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row({ userId: "u-other", createdAt: new Date(NOW.getTime() - 3 * 24 * 3_600_000), invoiceId: "inv1", qbSyncedAt: NOW });
    const { tx, calls } = fakeTx({ first: victim });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-other", undefined, clock), "deleted");
    const claim = calls.find((c) => c.startsWith("deleteMany:"));
    assert.ok(claim, "privileged delete is a deleteMany too (P2025-safe)");
    assert.deepEqual(JSON.parse(claim!.slice("deleteMany:".length)), { id: "te1" }, "…but unconditional");
    assert.equal(calls.includes("delete"), false);
});

test("a victim that is already gone returns 'gone' without deleting", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { tx, calls } = fakeTx({ first: null });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", "2026-08-30", "u-crew", CREW, clock), "gone");
    assert.equal(calls.some((c) => c.startsWith("deleteMany") || c === "delete"), false);
});

test("a row moved to another day takes that day's lock too (both days re-planned)", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row({ startTime: new Date(NOW.getTime() - 3 * 24 * 3_600_000) });
    const knownDay = await dayOf(NOW);
    const actualDay = await dayOf(victim.startTime);
    assert.notEqual(knownDay, actualDay);
    const { tx, calls } = fakeTx({ first: victim });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", knownDay, "u-crew", CREW, clock), "deleted");
    const locks = calls.filter((c) => c.startsWith("lock:"));
    assert.deepEqual(locks, [`lock:wa-breaks:u-crew:${knownDay}`, `lock:wa-breaks:u-crew:${actualDay}`]);
});
