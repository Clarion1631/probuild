import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { leaseIsHeld } from "../src/lib/cron-lease";

/**
 * The durable run lease (Codex round-5 item 4).
 *
 * `pg_try_advisory_xact_lock` is transaction-scoped and pgbouncer forbids the
 * session kind, so the old claim released the instant its transaction committed
 * — before the first QBO call. It excluded nothing. These tests pin the lease's
 * decision rule and the ORDER the crons use it in, which no unit call can show.
 */

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
    assert.match(source, /const stampWarranted = summary\.ok && summary\.complete && summary\.clearedProbeOk && ambiguousCount === 0[\s]*&& !summary\.uncertified;/);
    assert.match(source, /if \(stampWarranted\) \{[\s\S]{0,600}BANK_PULL_LAST_SUCCESS_KEY/);
});
