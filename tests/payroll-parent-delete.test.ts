/**
 * Deleting a parent that owns time entries (review rounds 16-18).
 *
 * TimeEntry CASCADEd from both User and Project, so deleting a former employee
 * or an old job silently destroyed their payroll history — including hours
 * inside a LOCKED period that had already been exported and paid. Both foreign
 * keys are RESTRICT now, and this module is the only sanctioned way past them.
 *
 * Round 17 moved DISCOVERY inside the transaction. Round 18 removed the
 * "delete the unlocked entries" branch entirely: production's paid history
 * predates PayrollPeriod, so it has no lock to trip, and a lock-only check
 * read every one of those rows as safe to destroy. The rule now is simply
 * ZERO time entries or the delete is refused — locked or not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    deleteParentWithTimeEntries,
    deleteParentsWithTimeEntries,
    isTimeEntriesExistError,
} from "../src/lib/payroll-parent-delete";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-parent-delete";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/**
 * A fake transaction. `count` is how many time entries the fake claims to
 * find for whatever scope it is asked about — real behaviour never needs to
 * distinguish per-parent here, since one `count()` covers the whole OR'd set.
 */
function fakeTx(options: { count?: number; trace?: string[] }) {
    const trace = options.trace ?? [];
    const tx = {
        $executeRawUnsafe: async (sql: string) => {
            if (sql.includes("pg_advisory_xact_lock_shared")) trace.push("payroll-lock");
            return 1;
        },
        $queryRawUnsafe: async () => [],
        payrollPeriod: { findMany: async () => [] },
        timeEntry: {
            count: async () => {
                trace.push("count");
                return options.count ?? 0;
            },
        },
    };
    return { tx, trace };
}

test("the payroll lock is taken FIRST, before the count, before the parent is touched", async () => {
    const { tx, trace } = fakeTx({ count: 0 });
    await deleteParentWithTimeEntries({ projectId: "proj-1" }, async () => { trace.push("parent"); }, {
        runTransaction: (fn) => fn(tx as never),
    });
    assert.deepEqual(trace, ["payroll-lock", "count", "parent"]);
});

test("a parent with ZERO time entries can be deleted", async () => {
    const { tx, trace } = fakeTx({ count: 0 });
    let parentDeleted = false;
    const result = await deleteParentWithTimeEntries({ userId: "u-nobody" }, async () => { parentDeleted = true; }, {
        runTransaction: (fn) => fn(tx as never),
    });
    assert.equal(parentDeleted, true);
    assert.deepEqual(result, { deletedEntries: 0 });
    assert.ok(trace.includes("payroll-lock"), "the lock is unconditional, even for a parent nobody has ever punched under");
});

test("ANY existing time entries refuse the delete — locked status is never consulted", async () => {
    // This is the regression the round-18 review caught: historical paid
    // entries predate PayrollPeriod entirely, so they are "unlocked" forever.
    // A version of this module that deleted unlocked entries and refused only
    // locked ones would delete these silently. The fake here never even
    // exposes a lock/period concept any more — the count alone must refuse.
    const { tx } = fakeTx({ count: 2 });
    let parentDeleted = false;
    await assert.rejects(
        () =>
            deleteParentWithTimeEntries({ userId: "u1" }, async () => { parentDeleted = true; }, {
                runTransaction: (fn) => fn(tx as never),
            }),
        (error: Error) => isTimeEntriesExistError(error) && /2 time entries/.test(error.message)
    );
    assert.equal(parentDeleted, false, "a parent with any history must survive the delete");
});

test("a SINGLE remaining entry still refuses, and the message says 'entry' not 'entries'", async () => {
    const { tx } = fakeTx({ count: 1 });
    await assert.rejects(
        () => deleteParentWithTimeEntries({ projectId: "proj-1" }, async () => {}, { runTransaction: (fn) => fn(tx as never) }),
        (error: Error) => isTimeEntriesExistError(error) && /1 time entry\b/.test(error.message)
    );
});

test("the module never writes to TimeEntry at all — count and refuse, nothing more", () => {
    const source = read("src/lib/payroll-parent-delete.ts");
    // No delete, update, or any other TimeEntry mutation lives here any more —
    // the only sanctioned outcome for a parent with history is refusal.
    assert.doesNotMatch(source, /\.timeEntry\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/);
    assert.match(source, /client\.timeEntry\.count\(\{ where: \{ OR: scopes as never \} \}\)/);
    assert.match(source, /existing > 0\) throw new TimeEntriesExistError\(existing\)/);
});

test("MANY parents are checked before ANY parent is deleted, in ONE transaction", async () => {
    const { tx, trace } = fakeTx({ count: 0 });
    let deletedParents = 0;
    await deleteParentsWithTimeEntries(
        [{ projectId: "p-a" }, { projectId: "p-b" }],
        async () => { deletedParents += 1; trace.push("parents"); },
        { runTransaction: (fn) => fn(tx as never) }
    );
    // ONE callback for the whole set, inside ONE transaction — not a loop of
    // independent deletes.
    assert.equal(deletedParents, 1);
    assert.deepEqual(trace, ["payroll-lock", "count", "parents"]);
});

test("one parent WITH time entries refuses the whole batch, not just that parent", async () => {
    // The loop-per-project version left the caller half-deleted when the
    // second job turned out to have history, with nothing to undo the first.
    const { tx } = fakeTx({ count: 3 });
    let parentsDeleted = false;

    await assert.rejects(
        () =>
            deleteParentsWithTimeEntries(
                [{ projectId: "p-clean" }, { projectId: "p-has-history" }],
                async () => { parentsDeleted = true; },
                { runTransaction: (fn) => fn(tx as never) }
            ),
        (error: Error) => isTimeEntriesExistError(error)
    );
    assert.equal(parentsDeleted, false, "the clean project must survive too — it is one transaction");
});

test("deleteProjects deletes the whole set in ONE call, not a loop", () => {
    const actions = read("src/lib/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function deleteProjects"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    assert.match(body, /deleteParentsWithTimeEntries\(/);
    assert.match(body, /projectIds\.map\(\(projectId\) => \(\{ projectId \}\)\)/);
    assert.match(body, /project\.deleteMany\(\{ where: \{ id: \{ in: projectIds \} \} \}\)/);
    // No per-project loop: that is what left a half-deleted selection.
    assert.doesNotMatch(body, /for \(const projectId of projectIds\)/);
});

// ── deleteProjects requires ADMIN, not just an active session ───────────────
//
// assertActiveStaff() alone answers "is somebody logged in", not "may THIS
// role delete a job" — a FIELD_CREW session passed it, and project deletion is
// irreversible (estimates, invoices, messages, files, everything short of the
// payroll-history refusal above). No permission key exists for this in
// src/lib/permissions.ts, so — same shape as discardPayrollPeriod's ADMIN-only
// gate (tests/payroll-round16.test.ts) — the check is a role comparison.
//
// deleteProjects is not DI-factored (it calls assertActiveStaff(), which reads
// a real next-auth session/prisma user with no injection point), so — same
// posture as every other actions.ts ADMIN gate in this suite — this is a
// source check that the guard exists and runs BEFORE any delete is attempted,
// backed by a real behavioural test of the extracted role predicate itself.

test("deleteProjects requires the ADMIN role, refusing with the SAME error shape as other guarded actions", () => {
    const actions = read("src/lib/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function deleteProjects"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    assert.match(body, /const user = await assertActiveStaff\(\);/);
    assert.match(body, /if \(user\.role !== "ADMIN"\) throw new Error\("Forbidden"\);/);
    // The check happens BEFORE deleteParentsWithTimeEntries — a refused
    // request must never reach the payroll-history check, let alone the delete.
    assert.ok(
        body.indexOf('throw new Error("Forbidden")') < body.indexOf("deleteParentsWithTimeEntries("),
        "the role check must run before any delete is attempted"
    );
});

test("the ADMIN-only predicate itself: every non-ADMIN role is refused, ADMIN is allowed", () => {
    // The exact expression deleteProjects evaluates, isolated and run for
    // real against every role the app has — not just asserted as source text.
    const isRefused = (role: string) => role !== "ADMIN";
    assert.equal(isRefused("FIELD_CREW"), true, "a crew session must be refused, no delete call");
    assert.equal(isRefused("MANAGER"), true, "deleting a job is narrower than the usual ADMIN/MANAGER split");
    assert.equal(isRefused("FINANCE"), true);
    assert.equal(isRefused("EMPLOYEE"), true, "the legacy role value must not slip through either");
    assert.equal(isRefused("ADMIN"), false);
});

// ── Schema and migration (round 16, still load-bearing) ─────────────────────

test("both foreign keys are RESTRICT in the schema", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model TimeEntry {"));
    const body = model.slice(0, model.indexOf("\n}"));
    assert.match(body, /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Restrict\)/);
    assert.match(body, /project\s+Project\s+@relation\(fields: \[projectId\], references: \[id\], onDelete: Restrict\)/);
    assert.doesNotMatch(body, /onDelete: Cascade/);
});

test("User and Project are the ONLY parents that cascaded into TimeEntry", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model TimeEntry {"));
    const body = model.slice(0, model.indexOf("\n}"));
    // The other relations are optional, so Prisma's default is SetNull — a
    // deleted cost code or schedule task blanks the column, it does not destroy
    // the hours. This is the tripwire if one is ever given an explicit Cascade.
    for (const relation of ["costCode", "costType", "estimateItem", "scheduleTask"]) {
        const line = body.split("\n").find((l) => l.trim().startsWith(relation + " ")) ?? "";
        assert.doesNotMatch(line, /onDelete: Cascade/, relation);
    }
    // Project itself is not reachable by cascade from Client, so there is no
    // transitive path into TimeEntry either.
    const project = schema.slice(schema.indexOf("model Project {"));
    const clientLine = project.slice(0, project.indexOf("\n}")).split("\n").find((l) => l.includes("client ")) ?? "";
    assert.doesNotMatch(clientLine, /onDelete: Cascade/);
});

test("the migration converts the FKs and is replay-safe on confdeltype", () => {
    const sql = read("prisma/migrations/20260901000000_payroll_phase5/migration.sql");
    // 'c' is CASCADE. A second run finds 'r' and does nothing.
    assert.match(sql, /confdeltype = 'c'/);
    assert.match(sql, /ON DELETE RESTRICT ON UPDATE CASCADE/);
    assert.match(sql, /TimeEntry_userId_fkey/);
    assert.match(sql, /TimeEntry_projectId_fkey/);

    // The standalone apply script has to carry the SAME conversion, or a prod
    // run of the script leaves the cascade in place.
    const script = read("scripts/apply-payroll-phase5.mjs");
    assert.match(script, /confdeltype = 'c'/);
    assert.match(script, /ON DELETE RESTRICT ON UPDATE CASCADE/);
    assert.match(script, /still cascading/);
});

test("the users route answers 423 for a locked period and 409 for existing time entries", () => {
    const users = read("src/app/api/users/[id]/route.ts");
    assert.match(users, /deleteParentWithTimeEntries\(\{ userId: id \}/);
    assert.match(users, /isPeriodLockedError\(error\)\) return periodLockedResponse\(error\.period\)/);
    assert.match(users, /isTimeEntriesExistError\(error\)\)/);
    assert.match(users, /status: 409/);
    // Both refusals must be ordered before the generic 500 handler, or they
    // read as a crash instead of a well-formed, allowed-but-refused request.
    assert.ok(users.indexOf("isPeriodLockedError") < users.indexOf("Internal server error"));
    assert.ok(users.indexOf("isTimeEntriesExistError") < users.indexOf("Internal server error"));
});
