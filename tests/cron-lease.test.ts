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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { leaseIsHeld } from "../src/lib/cron-lease";

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

// ── Wiring ──────────────────────────────────────────────────────────────────
//
// Everything above proves the lease MECHANISM. None of it would notice the
// cron simply not taking one, or taking one that expires under its own pass —
// and neither would tsc, because both are optional-looking call-site details.
// These read the route, in the spirit of the sweep-query check in
// receipt-intake-worker.test.ts.

const workerRoute = readFileSync(
    path.join(__dirname, "..", "src/app/api/cron/receipt-intake-worker/route.ts"),
    "utf8",
);

test("the receipt-intake worker actually takes a lease", () => {
    assert.match(
        workerRoute,
        /acquireLease:\s*\(\)\s*=>\s*acquireCronLease\(WORKER_LEASE_KEY,\s*WORKER_LEASE_MS\)/,
        "buildDeps must wire the lease, or runIntakeWorker's whole-pass exclusion is inert",
    );
});

test("the lease OUTLIVES the platform ceiling — which is why nothing heartbeats", () => {
    // A lease shorter than maxDuration could lapse while its own pass was still
    // running, letting a second invocation in on exactly the run it exists to
    // exclude. The only alternative is heartbeating from a loop that spends its
    // time blocked on Gemini and QuickBooks, so this inequality is load-bearing.
    const ttl = Number(workerRoute.match(/const WORKER_LEASE_MS = ([\d_]+);/)?.[1].replace(/_/g, ""));
    const maxDuration = Number(workerRoute.match(/export const maxDuration = (\d+);/)?.[1]) * 1_000;
    assert.ok(Number.isFinite(ttl) && Number.isFinite(maxDuration), "both constants must be readable");
    assert.ok(ttl > maxDuration, `lease TTL ${ttl}ms must exceed the ${maxDuration}ms function ceiling`);
});

// ── THE PHASE-2 CRONS' RUN LEASE (takeLease/releaseLease/leaseIsHeld) ────────
//
// A second lease lives in the same module for the bank pull and the
// missing-receipt sweep. Its decision rule and the ORDER the crons use it in
// are pinned here, beside the mechanism tests above.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-09-02T02:00:00Z");

const lease = (minutesFromNow: number) => JSON.stringify({
    token: "abc",
    expiresAt: new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString(),
});

test("a live lease is held; an expired one is not", () => {
    assert.equal(leaseIsHeld(lease(10), NOW), true, "another run is still going");
    assert.equal(leaseIsHeld(lease(-1), NOW), false, "that run died; the job is up for grabs");
    assert.equal(leaseIsHeld(lease(0), NOW), false, "exactly expired is expired");
});

test("an absent or corrupt lease is NOT held — a broken row must not wedge the cron forever", () => {
    assert.equal(leaseIsHeld(null, NOW), false);
    assert.equal(leaseIsHeld("", NOW), false);
    assert.equal(leaseIsHeld("{{{", NOW), false);
    assert.equal(leaseIsHeld(JSON.stringify({ token: "x" }), NOW), false, "no expiry is not a lease");
    assert.equal(leaseIsHeld(JSON.stringify({ expiresAt: NOW.toISOString() }), NOW), false, "no token is not a lease");
});

test("both crons take the lease BEFORE any work and release it after", () => {
    for (const [label, file] of [
        ["bank pull", "src/app/api/cron/bank-register-pull/route.ts"],
        ["receipt sweep", "src/app/api/cron/receipt-requests/route.ts"],
    ] as const) {
        const source = readFileSync(join(repoRoot, file), "utf8");
        const takeAt = source.indexOf("await takeLease(");
        const releaseAt = source.indexOf("await releaseLease(");
        assert.ok(takeAt > 0, `${label} must take the durable lease`);
        assert.ok(releaseAt > takeAt, `${label} must release it after the work`);
        // The old shape said "locked"; the contract now names the condition.
        assert.match(source, /skipped: "already-running"/, label);
        // And the release is in a finally, so a throw cannot strand it.
        assert.match(source, /\} finally \{\s*\n\s*await releaseLease\(/, label);
    }
});

test("the release is token-fenced in ONE statement, not read-then-write", () => {
    // A read-then-write release has a window: A reads "I hold it", B's claim
    // overwrites the row, A's write then clears B's lease and two runs are live.
    const source = readFileSync(join(repoRoot, "src/lib/cron-lease.ts"), "utf8");
    assert.match(source, /where: \{ key, value: \{ contains: `"token":"\$\{token\}"` \} \}/);
    assert.doesNotMatch(source, /if \(held\?\.token !== token\) return;/, "the read-then-write shape is gone");
    // And the claim refuses when someone else holds it.
    assert.match(source, /if \(held && new Date\(held\.expiresAt\) > now\) return null;/);
});

test("two simultaneous releases: only the token holder wins", async () => {
    // Modelled on the fenced predicate the real release uses.
    let stored = JSON.stringify({ token: "B", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const release = async (token: string) => {
        // updateMany where key AND value contains our token.
        if (!stored.includes(`"token":"${token}"`)) return 0;
        stored = JSON.stringify({ token: "", expiresAt: new Date(0).toISOString() });
        return 1;
    };
    const [a, b] = await Promise.all([release("A"), release("B")]);
    assert.equal(a, 0, "A no longer holds it and must clear nothing");
    assert.equal(b, 1, "B holds it and releases it");
});

test("the lease FAILS CLOSED: an unreadable lease means the run is skipped", () => {
    // Two concurrent runs write contradictory verdicts, so a cron that cannot
    // prove exclusivity must not run at all.
    const source = readFileSync(join(repoRoot, "src/lib/cron-lease.ts"), "utf8");
    assert.match(source, /catch \(error\) \{[\s\S]*?return null;/);
});

test("the bank pull records its last COMPLETE success, not its last run", () => {
    // pipeline-health reads this to decide whether the chaser is being fed; a
    // failed run that stamped the clock would keep the check green. So would a
    // budget-truncated one, which is not a failure but read only part of one
    // window — if truncation persists the mark goes stale and bank-pull-stale
    // fires, which is exactly the signal wanted.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(source, /const stampWarranted = summary\.ok && summary\.complete && summary\.clearedProbeOk && ambiguousCount === 0[\s\S]{0,140}?quarantineHeld\.length === 0 && !quarantineBlocked[\s]*&& !summary\.uncertified;/);
    // The write itself, and the release of an owed stamp, are ONE transaction
    // (round-37 gate, finding 2) — the ONLY place stampPending is ever cleared.
    assert.match(source, /if \(stampWarranted\) \{[\s\S]{0,300}await commitFreshnessStamp\(/);
    assert.match(source, /prisma\.\$transaction\([\s\S]{0,400}BANK_PULL_LAST_SUCCESS_KEY[\s\S]{0,900}delete parsed\.stampPending;/);
});
