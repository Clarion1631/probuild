/**
 * deleteEntryAndSettleInTx (src/lib/wa-breaks-db.ts) with a fake transaction.
 *
 * Codex gate on PR #434/#436: the route's owner/lock pre-check alone was a TOCTOU, and
 * a conditional WHERE with pre-computed day bounds still was not (the delete itself can
 * wait on a row lock across midnight). The transaction therefore: takes the day
 * advisory lock(s) → locks the row FOR UPDATE → judges the owner policy on the LOCKED
 * row with the clock read after all locks → deletes that row. Nothing can change the
 * row between the check and the delete. Privileged callers skip only the policy check.
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
const dayOf = async (d: Date) => (await import("../src/lib/company-day")).toCompanyDayKey(d);

// Fixed clock (Codex: `new Date()` inside the helper made "same day" flaky for the first
// hours after Pacific midnight). Every call passes `clock`, and createdAt === NOW.
const NOW = new Date("2026-08-30T19:00:00.000Z");
const clock = () => NOW;
const AFTER_MIDNIGHT = () => new Date("2026-08-31T08:30:00.000Z"); // 01:30 PDT the next day
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
 * Fake `tx`. `peek` is what the unlocked findUnique returns; `locked` is what the
 * SELECT … FOR UPDATE returns (defaults to `peek`) — the difference IS the race window
 * the design closes. deleteMany reports `deleteCount` (default 1). settleDayInTx's owner
 * lookup returns null so it writes nothing.
 */
function fakeTx(opts: { peek: Row | null; locked?: Row | null; deleteCount?: number }) {
    const calls: string[] = [];
    const tx = {
        $executeRawUnsafe: async (_sql: string, key: string) => { calls.push(`lock:${key}`); return 0; },
        $queryRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
            assert.match(strings.join("?"), /FOR UPDATE/, "row read is a SELECT … FOR UPDATE");
            calls.push("rowlock");
            const locked = opts.locked === undefined ? opts.peek : opts.locked;
            return locked ? [locked] : [];
        },
        timeEntry: {
            findUnique: async () => { calls.push("peek"); return opts.peek; },
            deleteMany: async (args: { where: Record<string, unknown> }) => { calls.push(`deleteMany:${JSON.stringify(args.where)}`); return { count: opts.deleteCount ?? 1 }; },
            delete: async () => { calls.push("delete"); return {}; },
            findMany: async () => [],
            update: async () => { calls.push("update"); return {}; },
        },
        user: { findUnique: async () => null },
    };
    return { tx: tx as any, calls };
}

const deleted = (calls: string[]) => calls.some((c) => c.startsWith("deleteMany:"));
const order = (calls: string[]) => calls.filter((c) => c === "peek" || c === "rowlock" || c.startsWith("lock:") || c.startsWith("deleteMany")).map((c) => c.split(":")[0]);

test("owner path: day lock → peek → row lock → policy on the locked row → delete", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row();
    const { tx, calls } = fakeTx({ peek: victim });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock), "deleted");
    assert.deepEqual(order(calls), ["lock", "peek", "rowlock", "deleteMany"]);
    assert.deepEqual(JSON.parse(calls.find((c) => c.startsWith("deleteMany:"))!.slice("deleteMany:".length)), { id: "te1" }, "deletes exactly the locked row");
    assert.equal(calls.includes("delete"), false, "never the P2025-throwing delete()");
});

test("owner path: the policy is judged on the LOCKED row — an invoice/QBO link that landed after the peek refuses, nothing deleted", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    for (const [locked, code] of [
        [row({ qbSyncedAt: NOW }), "LOCKED_DOWNSTREAM"],
        [row({ invoiceId: "inv1" }), "LOCKED_DOWNSTREAM"],
        [row({ userId: "u-other" }), "NOT_OWNER"],
    ] as Array<[Row, string]>) {
        const peek = row(); // looked clean when peeked (and when the route pre-checked)
        const { tx, calls } = fakeTx({ peek, locked });
        await assert.rejects(
            deleteEntryAndSettleInTx(tx, "te1", await dayOf(peek.startTime), "u-crew", CREW, clock),
            (err: unknown) => err instanceof DeleteRefusedError && err.code === code,
            code
        );
        assert.equal(calls.includes("rowlock"), true, `${code}: refused only after the row lock`);
        assert.equal(deleted(calls), false, `${code}: nothing deleted`);
        assert.equal(calls.includes("update"), false, `${code}: no re-plan`);
    }
});

test("owner path: the clock is read AFTER the row lock — midnight passing while waiting for the row refuses NOT_TODAY", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const victim = row();
    const { tx, calls } = fakeTx({ peek: victim });
    // The route pre-checked at 12:00 PDT; by the time the row lock is granted it is 01:30 PDT next day.
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, AFTER_MIDNIGHT),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "NOT_TODAY"
    );
    assert.deepEqual(order(calls), ["lock", "peek", "rowlock"], "refused after the row lock, before any delete");
});

test("owner path: an older entry is refused on the locked row (createdAt is immutable, so no field race exists)", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const victim = row({ createdAt: new Date(NOW.getTime() - 24 * 3_600_000) });
    const { tx, calls } = fakeTx({ peek: victim });
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "NOT_TODAY"
    );
    assert.equal(deleted(calls), false);
});

test("a row moved to another day between the caller's read and the peek takes that day's lock too, then deletes and re-plans both days", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row({ startTime: new Date(NOW.getTime() - 3 * 24 * 3_600_000) });
    const knownDay = await dayOf(NOW);
    const actualDay = await dayOf(victim.startTime);
    assert.notEqual(knownDay, actualDay);
    const { tx, calls } = fakeTx({ peek: victim });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", knownDay, "u-crew", CREW, clock), "deleted");
    assert.deepEqual(calls.filter((c) => c.startsWith("lock:")), [`lock:wa-breaks:u-crew:${knownDay}`, `lock:wa-breaks:u-crew:${actualDay}`]);
    assert.equal(calls.indexOf("rowlock") > calls.lastIndexOf(`lock:wa-breaks:u-crew:${actualDay}`), true, "advisory locks are all taken BEFORE the row lock");
});

test("a row moved AGAIN between the peek and the row lock (onto a day we hold no lock for) is refused CLAIM_LOST — never lock a day while holding the row", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { DeleteRefusedError } = await policy();
    const peek = row();
    const locked = row({ startTime: new Date(NOW.getTime() - 5 * 24 * 3_600_000) }); // manager moved it meanwhile
    const { tx, calls } = fakeTx({ peek, locked });
    await assert.rejects(
        deleteEntryAndSettleInTx(tx, "te1", await dayOf(peek.startTime), "u-crew", CREW, clock),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "CLAIM_LOST"
    );
    assert.equal(deleted(calls), false);
    assert.equal(calls.filter((c) => c.startsWith("lock:")).length, 1, "no advisory lock was taken after the row lock");
    // Same for the privileged path: the move is about lock ordering, not authorization.
    const p = fakeTx({ peek, locked });
    await assert.rejects(
        deleteEntryAndSettleInTx(p.tx, "te1", await dayOf(peek.startTime), "u-crew", undefined, clock),
        (err: unknown) => err instanceof DeleteRefusedError && err.code === "CLAIM_LOST"
    );
    assert.equal(deleted(p.calls), false);
});

test("privileged path (no guard): locked, older, other-user row is deleted — policy is skipped, locking is not", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row({ userId: "u-other", createdAt: new Date(NOW.getTime() - 3 * 24 * 3_600_000), invoiceId: "inv1", qbSyncedAt: NOW });
    const { tx, calls } = fakeTx({ peek: victim });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-other", undefined, AFTER_MIDNIGHT), "deleted");
    assert.deepEqual(order(calls), ["lock", "peek", "rowlock", "deleteMany"]);
});

test("a victim that is already gone at the peek returns 'gone' without locking or deleting", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const { tx, calls } = fakeTx({ peek: null });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", "2026-08-30", "u-crew", CREW, clock), "gone");
    assert.deepEqual(order(calls), ["lock", "peek"]);
});

test("a victim that vanished between the peek and the row lock returns 'gone' (no P2025)", async () => {
    const { deleteEntryAndSettleInTx } = await load();
    const victim = row();
    const { tx, calls } = fakeTx({ peek: victim, locked: null });
    assert.equal(await deleteEntryAndSettleInTx(tx, "te1", await dayOf(victim.startTime), "u-crew", CREW, clock), "gone");
    assert.equal(deleted(calls), false);
    const p = fakeTx({ peek: victim, deleteCount: 0 }); // belt-and-braces: deleteMany reporting 0 is also "gone"
    assert.equal(await deleteEntryAndSettleInTx(p.tx, "te1", await dayOf(victim.startTime), "u-other", undefined, clock), "gone");
    assert.equal(p.calls.includes("update"), false, "no re-plan for a no-op");
});
