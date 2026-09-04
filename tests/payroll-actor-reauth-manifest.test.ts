/**
 * EVERY payroll mutation re-decides its caller's authority INSIDE the
 * transaction, the same way every User writer takes the payroll advisory lock
 * (tests/payroll-user-writer-manifest.test.ts) and every TimeEntry writer is
 * gated (tests/payroll-writer-manifest.test.ts).
 *
 * THE HOLE (round 21, P1). Each of these actions called
 * `requirePayrollAccess()` — or read `user.role !== "ADMIN"` — and only THEN
 * opened a transaction. Between those two moments a payroll action can wait a
 * long time: on the payroll advisory lock (exclusive, behind every in-flight
 * hours writer), on User row locks, on TimeEntry row locks, and in the case of
 * the settle button, on a whole loop of one transaction per deferred day. An
 * account disabled, demoted or stripped of `financialReports` inside that
 * window still committed, with authority it no longer had — imports landed pay
 * rates, periods were frozen under a revoked locker's name, and unlock threw
 * away the frozen CSVs of an already-paid period.
 *
 * The fix is `requireFinancialActorInTx` (src/lib/user-mutation-guard.ts): the
 * actor's row is locked FOR SHARE and re-read inside the transaction, and
 * `canActOnFinancials` — the SAME predicate the door check composes — is run
 * against what the lock holds.
 *
 * This file is the inversion that keeps it true. It enumerates the payroll
 * actions that EXIST and fails when the set changes, so a new one has to be
 * classified as re-authorizing, as delegating to a writer that does, or as a
 * documented read-only exemption. It cannot be added silently.
 *
 * What this proves: no payroll writer escapes review. What it does NOT prove:
 * that the re-authorization actually refuses a revoked actor at runtime — that
 * is tests/payroll-actor-reauth-db.test.ts, on two real connections.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");
const ACTIONS = readFileSync(path.join(SRC, "lib", "actions.ts"), "utf8");

/** The banner the Phase 5 payroll actions live under. Everything after it is this surface. */
const PAYROLL_BANNER = "// ============ Payroll (Phase 5";

function payrollSection(): string {
    const start = ACTIONS.indexOf(PAYROLL_BANNER);
    assert.ok(start > 0, "the payroll section banner moved — this whole file scans from it");
    return ACTIONS.slice(start);
}

/** Every exported server action in the payroll section, with its body text. */
function payrollActions(): Map<string, string> {
    const section = payrollSection();
    const pattern = /export async function (\w+)\s*\(/g;
    const found: Array<{ name: string; at: number }> = [];
    for (const match of section.matchAll(pattern)) {
        found.push({ name: match[1], at: match.index! });
    }
    const bodies = new Map<string, string>();
    found.forEach((entry, index) => {
        const end = index + 1 < found.length ? found[index + 1].at : section.length;
        bodies.set(entry.name, section.slice(entry.at, end));
    });
    return bodies;
}

/** Any write issued on a transaction client. */
const TX_WRITE = /\btx\.\w+\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/;

/**
 * Every payroll action, and how its caller's authority survives the wait.
 *
 * "reauth"    — calls requireFinancialActorInTx inside its own transaction,
 *               after the advisory lock and before its first write.
 * "delegated" — hands the actor's id to a writer that does the same thing in
 *               ITS transaction, named here and checked below.
 * "read-only" — writes nothing at all, so there is no commit to authorize.
 */
const MANIFEST: Record<
    string,
    { kind: "reauth" | "delegated" | "read-only"; requireAdmin?: true; delegate?: string; why: string }
> = {
    previewGustoRateImport: {
        kind: "read-only",
        why: "parses a pasted CSV and returns a diff for a human to look at; it opens no transaction and writes nothing",
    },
    applyGustoRateImport: {
        kind: "reauth",
        why: "writes hourlyRate/payType for a whole batch, after waiting on the shared payroll lock and one FOR UPDATE per member",
    },
    setUserPayType: {
        kind: "reauth",
        why: "writes payType, which decides who is on the Gusto roster at all",
    },
    lockPayrollPeriod: {
        kind: "reauth",
        why: "freezes a period and its CSV snapshots under the locker's name, behind the EXCLUSIVE payroll lock — the longest wait on this surface",
    },
    settleDeferredDaysForPeriod: {
        kind: "delegated",
        delegate: "settleDay",
        why: "one transaction PER DEFERRED DAY, so a single door check covered an unbounded run; the operator's id travels into each of them",
    },
    discardPayrollPeriod: {
        kind: "reauth",
        requireAdmin: true,
        why: "retires a period row; ADMIN only, and canActOnFinancials admits a MANAGER",
    },
    unlockPayrollPeriod: {
        kind: "reauth",
        requireAdmin: true,
        why: "drops the frozen CSV snapshots of an exported period; ADMIN only, for the same reason",
    },
};

test("every payroll action is classified — a new one cannot appear silently", () => {
    const found = [...payrollActions().keys()].sort();
    // The control: a scanner that found nothing would make every assertion
    // below vacuously true.
    assert.ok(found.length >= 6, `expected the payroll actions to be found, got ${found.length}: ${found.join(", ")}`);
    assert.deepEqual(
        found,
        Object.keys(MANIFEST).sort(),
        "a payroll action appeared, moved or vanished — classify it (reauth, delegated, or read-only with a reason)"
    );
});

test("every payroll action that writes re-authorizes INSIDE its transaction", () => {
    const bodies = payrollActions();
    for (const [name, entry] of Object.entries(MANIFEST)) {
        const body = bodies.get(name)!;
        if (entry.kind === "read-only") {
            assert.ok(!/prisma\.\$transaction\(/.test(body), `${name} is classified read-only but opens a transaction`);
            assert.ok(!TX_WRITE.test(body), `${name} is classified read-only but writes`);
            continue;
        }
        if (entry.kind === "delegated") continue;

        assert.match(
            body,
            /requireFinancialActorInTx\(/,
            `${name} writes inside a transaction but never re-decides its caller's authority there`
        );
        // ...on the transaction client, not on a fresh connection outside it.
        assert.match(body, /requireFinancialActorInTx\(tx as never/, `${name} must re-authorize on ITS OWN tx`);
    }
});

test("the re-authorization sits after the advisory lock and before the first write", () => {
    // Tier 1 (the payroll advisory lock) then tier 2 (User rows) — the global
    // order in src/lib/payroll-period.ts. A re-check taken before the advisory
    // lock would be another read that a wait can invalidate; one taken after
    // the write would authorize nothing.
    const bodies = payrollActions();
    for (const [name, entry] of Object.entries(MANIFEST)) {
        if (entry.kind !== "reauth") continue;
        const body = bodies.get(name)!;
        const lockAt = Math.max(
            body.indexOf("acquirePayrollWriteLock(tx as never)"),
            body.indexOf("acquirePayrollLockCreationLock(tx as never)")
        );
        assert.ok(lockAt > 0, `${name}: no payroll advisory lock found to order against`);
        const checkAt = body.indexOf("requireFinancialActorInTx(tx as never");
        assert.ok(checkAt > lockAt, `${name}: the actor re-check must come AFTER the payroll advisory lock`);
        const writeAt = body.search(TX_WRITE);
        assert.ok(writeAt > 0, `${name}: no transactional write found to order against`);
        assert.ok(checkAt < writeAt, `${name}: the actor re-check must come BEFORE the first write`);
    }
});

test("the two ADMIN-only period actions ask for ADMIN under the lock, not merely financial access", () => {
    // canActOnFinancials admits a MANAGER (hasPermission returns true for
    // ADMIN and MANAGER unconditionally — src/lib/access-rules.ts). Re-checking
    // only that would be WEAKER than the door check these two already run, and
    // a weaker in-transaction check is worse than none: it reads as a guard.
    const bodies = payrollActions();
    for (const [name, entry] of Object.entries(MANIFEST)) {
        const body = bodies.get(name)!;
        if (!entry.requireAdmin) {
            assert.ok(
                !/requireAdmin: true/.test(body),
                `${name} is not ADMIN-only at the door, so it must not claim to be under the lock`
            );
            continue;
        }
        assert.match(body, /requireFinancialActorInTx\(tx as never, user\.id, \{ requireAdmin: true \}\)/, name);
        // ...and the door check it mirrors is still there.
        assert.match(body, /user\.role !== "ADMIN"/, `${name} must still refuse a non-admin before opening a transaction`);
    }
});

test("the delegated action hands its operator down, and the delegate re-authorizes", () => {
    const bodies = payrollActions();
    for (const [name, entry] of Object.entries(MANIFEST)) {
        if (entry.kind !== "delegated") continue;
        const body = bodies.get(name)!;
        // The action captures the actor rather than discarding the pre-check's
        // return value, and passes it into every per-day call.
        assert.match(body, /const settler = await requirePayrollAccess\(\);/, name);
        assert.match(
            body,
            new RegExp(`${entry.delegate}\\([^)]*settler\\.id\\)`),
            `${name} must pass its operator into ${entry.delegate}`
        );
    }

    // The delegate's own half: settleDay re-decides the operator under the
    // payroll lock, and — critically — RETHROWS that refusal. It swallows
    // ordinary failures and returns -1, which the caller counts as "day
    // skipped"; a swallowed authorization refusal would be reported as a
    // successful run that settled nothing.
    const waBreaks = readFileSync(path.join(SRC, "lib", "wa-breaks-db.ts"), "utf8");
    const settleDay = waBreaks.slice(waBreaks.indexOf("export async function settleDay("));
    const body = settleDay.slice(0, settleDay.indexOf("\nexport "));
    assert.match(body, /requireFinancialActorInTx\(tx as never, actorId/, "settleDay must re-authorize its operator");
    assert.ok(
        body.indexOf("assertSettlementDayUnlocked(tx") < body.indexOf("requireFinancialActorInTx("),
        "the payroll advisory lock (tier 1) is taken before the actor's row (tier 2)"
    );
    assert.ok(
        body.indexOf("requireFinancialActorInTx(") < body.indexOf("pg_advisory_xact_lock(hashtext($1))"),
        "the actor's row is taken before the day lock, same order as every other payroll path"
    );
    assert.match(body, /if \(isUserMutationActorInvalidError\(error\)\) throw error;/, "a revoked operator is not a skipped day");
});

test("requireFinancialActorInTx is the shared predicate, taken under a row lock", () => {
    // The guard itself, so the manifest above is asserting something real. A
    // version of this function that did not lock, or that hand-rolled the
    // permission test, would satisfy every grep in this file otherwise.
    const guard = readFileSync(path.join(SRC, "lib", "user-mutation-guard.ts"), "utf8");
    const fn = guard.slice(guard.indexOf("export async function requireFinancialActorInTx"));
    const body = fn.slice(0, fn.indexOf("\n/**"));

    assert.match(body, /lockUserRowsAscending\(tx, \[/, "the actor's row must be locked, not merely read");
    assert.match(body, /\{ id: actorId, mode: "FOR SHARE" \}/, "FOR SHARE holds off the demote/disable/revoke UPDATE");
    assert.match(body, /checkActorUsable\(row\)/, "the account still has to exist and be ACTIVATED");
    assert.match(body, /canActOnFinancials\(actor\)/, "and the SHARED financial predicate decides, not a local copy");
    assert.match(body, /throw new UserMutationActorInvalidError\(/, "refusal is the branch's typed refusal");
    // The permission set judged is the one read under the lock, never a value
    // handed in by the caller.
    assert.match(body, /permissions: await readActorPermissions\(tx, actorId\)/);
    assert.ok(
        !/hasPermission\(|financialReports/.test(body),
        "no second copy of the permission rule may live here — compose canActOnFinancials"
    );

    // ONE ordered locker for every User row lock in the codebase, so two
    // payroll paths cannot take the same two rows in two different orders.
    const ordered = guard.slice(guard.indexOf("async function lockUserRowsAscending"));
    const orderedBody = ordered.slice(0, ordered.indexOf("\nasync function "));
    assert.match(orderedBody, /\[\.\.\.strongest\.keys\(\)\]\.sort\(\)/, "ascending id order");
    assert.match(orderedBody, /strongest\.get\(request\.id\) === "FOR UPDATE"/, "the strongest mode wins for a repeated row");
    // ...and the actor/target pair goes through it too, rather than keeping its
    // own copy of the ordering.
    assert.match(guard, /async function lockActorAndTarget[\s\S]{0,900}lockUserRowsAscending\(/);
    assert.ok(
        !/actorId < targetId/.test(guard),
        "lockActorAndTarget must not re-implement the ordering it now shares"
    );
});

test("the door check is still there — the in-transaction check is an ADDITION, not a replacement", () => {
    // requirePayrollAccess() gives a caller a good error before any lock is
    // taken, and it is the only check a read-only action needs. Dropping it in
    // favour of the transactional one would make every refusal arrive as a
    // rolled-back transaction.
    const bodies = payrollActions();
    for (const [name, entry] of Object.entries(MANIFEST)) {
        const body = bodies.get(name)!;
        const hasDoorCheck =
            /await requirePayrollAccess\(\)/.test(body) || /user\.role !== "ADMIN"/.test(body);
        assert.ok(hasDoorCheck, `${name} has no authorization check before it opens a transaction`);
        assert.ok(entry.why.length > 30, `${name} needs a real reason, not a shrug`);
    }
});

test("the classification distinguishes — it is neither all-reauth nor all-exempt", () => {
    const kinds = Object.values(MANIFEST).map((entry) => entry.kind);
    assert.ok(kinds.filter((kind) => kind === "reauth").length >= 4, "the four in-transaction writers");
    assert.equal(kinds.filter((kind) => kind === "delegated").length, 1, "the settle loop");
    assert.equal(kinds.filter((kind) => kind === "read-only").length, 1, "the preview");
});
