/**
 * The whole-invocation cron lease.
 *
 * The property under test is the one the receipt-intake worker's "one worker at
 * a time" claim actually rests on, so it is asserted against a fake store that
 * can be driven into the exact interleavings a production race would produce —
 * rather than being asserted by reading the code, which is how the advisory
 * lock came to be described as doing a job it never did.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { acquireCronLease, type CronLeaseStore } from "../src/lib/cron-lease";

const KEY = "test-lease";

/** An in-memory store with the same CAS semantics as the AutomationSetting one. */
function memoryStore(seed: string | null = null) {
    let value = seed;
    const store: CronLeaseStore & { peek: () => string | null; failAll: boolean } = {
        failAll: false,
        peek: () => value,
        async get() {
            if (store.failAll) throw new Error("db down");
            return value;
        },
        async insert(_key, next) {
            if (store.failAll) throw new Error("db down");
            // The primary key is what makes this atomic in Postgres.
            if (value !== null) return false;
            value = next;
            return true;
        },
        async swap(_key, from, to) {
            if (store.failAll) throw new Error("db down");
            if (value !== from) return false;
            value = to;
            return true;
        },
        async remove(_key, expected) {
            if (store.failAll) throw new Error("db down");
            if (value === expected) value = null;
        },
    };
    return store;
}

const at = (iso: string) => () => new Date(iso);

test("the first invocation takes a lease that did not exist", async () => {
    const store = memoryStore();
    const lease = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" });
    assert.ok(lease);
    assert.equal(lease.token, "A");
    assert.equal(store.peek(), "2026-09-01T12:01:30.000Z|A");
});

test("TWO SIMULTANEOUS INVOCATIONS: exactly one gets to process", async () => {
    // Both read the same absent row and both try to insert. In Postgres the
    // primary key decides; here the fake store decides the same way. Whichever
    // wins, the other must be told to do nothing — never both, and never
    // neither.
    const store = memoryStore();
    const now = at("2026-09-01T12:00:00.000Z");
    const [a, b] = await Promise.all([
        acquireCronLease(KEY, 90_000, { store, now, token: "A" }),
        acquireCronLease(KEY, 90_000, { store, now, token: "B" }),
    ]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one invocation holds the lease");
});

test("a second invocation arriving mid-pass is turned away", async () => {
    const store = memoryStore();
    const first = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" });
    assert.ok(first);
    // 30 seconds into a pass whose lease runs for 90.
    const second = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:30.000Z"), token: "B" });
    assert.equal(second, null);
});

test("a CRASHED invocation's stale lease expires and the next run proceeds", async () => {
    // The invocation that took this lease was killed at the platform ceiling
    // and never reached its `finally`. Nothing will ever release it, so the
    // expiry has to be what frees the queue.
    const store = memoryStore("2026-09-01T12:01:30.000Z|A");
    const next = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:05:00.000Z"), token: "B" });
    assert.ok(next, "the next cron five minutes later takes it over");
    assert.equal(store.peek(), "2026-09-01T12:06:30.000Z|B");
});

test("two runs racing to take over the SAME expired lease: only one wins", async () => {
    const store = memoryStore("2026-09-01T12:01:30.000Z|A");
    const now = at("2026-09-01T12:05:00.000Z");
    const [b, c] = await Promise.all([
        acquireCronLease(KEY, 90_000, { store, now, token: "B" }),
        acquireCronLease(KEY, 90_000, { store, now, token: "C" }),
    ]);
    assert.equal([b, c].filter(Boolean).length, 1, "the CAS on the expired value settles it");
});

test("releasing frees the lease immediately", async () => {
    const store = memoryStore();
    const lease = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" });
    await lease!.release();
    assert.equal(store.peek(), null);
    // And the very next invocation may run — it does not wait out the TTL.
    const next = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:01.000Z"), token: "B" });
    assert.ok(next);
});

test("an overrun invocation cannot release the lease that replaced it", async () => {
    // A holds a lease, overruns, and its lease expires. B takes over and is
    // mid-pass. A finally reaches its `finally` and releases — which must free
    // NOTHING, or B would be running unprotected with a lease anyone can take.
    const store = memoryStore();
    const a = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" });
    const b = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:05:00.000Z"), token: "B" });
    assert.ok(b, "B took over the expired lease");

    await a!.release();

    assert.equal(store.peek(), "2026-09-01T12:06:30.000Z|B", "B still holds it");
});

test("release never throws, even when the store is broken", async () => {
    const store = memoryStore();
    const lease = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" });
    store.failAll = true;
    await lease!.release();
    // A lease left behind expires on its own. What must not happen is the run
    // it protected failing because the cleanup did.
});

test("a store that cannot be read means NO lease — fail closed", async () => {
    const store = memoryStore();
    store.failAll = true;
    assert.equal(
        await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" }),
        null,
        "running unprotected is the thing the lease exists to prevent",
    );
});

test("a CORRUPT lease value reads as expired rather than wedging the cron forever", async () => {
    // Nothing else writes this key, but a value that could never be parsed and
    // was treated as "live" would stop the worker permanently with no way back
    // short of a manual delete. The CAS still makes the takeover safe.
    const store = memoryStore("not-a-date|???");
    const lease = await acquireCronLease(KEY, 90_000, { store, now: at("2026-09-01T12:00:00.000Z"), token: "A" });
    assert.ok(lease);
});
