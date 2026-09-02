/**
 * Deleting a parent that owns time entries (review rounds 16-17).
 *
 * TimeEntry CASCADEd from both User and Project, so deleting a former employee
 * or an old job silently destroyed their payroll history — including hours
 * inside a LOCKED period that had already been exported and paid. Both foreign
 * keys are RESTRICT now, and this module is the only sanctioned way past them.
 *
 * Round 17 moved DISCOVERY inside the transaction. Reading first and locking
 * second left two holes: a parent with no entries took no payroll lock at all
 * (the lock target was empty, so the guard returned early), and a row created
 * between the read and the write was deleted without ever being checked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    deleteParentWithTimeEntries,
    deleteParentsWithTimeEntries,
    isConcurrentTimeEntryError,
} from "../src/lib/payroll-parent-delete";
import { PeriodLockedError } from "../src/lib/payroll-period";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-parent-delete";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const ENTRIES = [
    { id: "e1", userId: "u1", startTime: new Date("2026-08-24T15:00:00Z") },
    { id: "e2", userId: "u1", startTime: new Date("2026-08-25T15:00:00Z") },
];

const LOCKED_PERIOD = {
    id: "p1",
    periodStart: new Date("2026-08-24T07:00:00Z"),
    periodEnd: new Date("2026-09-07T07:00:00Z"),
    lockedAt: new Date("2026-09-08T00:00:00Z"),
    timeZone: "America/Los_Angeles",
};

/**
 * A fake transaction. `rows` is the table; `onFind` can mutate it to simulate a
 * writer landing at a specific point.
 */
function fakeTx(options: {
    rows?: typeof ENTRIES;
    leftover?: number;
    onGuard?: () => void;
    trace?: string[];
}) {
    const trace = options.trace ?? [];
    let guardTarget: { entryIds: string[]; dayKeys: string[] } | null = null;
    const tx = {
        $executeRawUnsafe: async (sql: string) => {
            if (sql.includes("pg_advisory_xact_lock_shared")) trace.push("payroll-lock");
            else if (sql.includes("pg_advisory_xact_lock")) trace.push("day-lock");
            return 1;
        },
        $queryRawUnsafe: async (sql: string, ids: string[]) => {
            if (sql.includes("FOR UPDATE")) {
                trace.push("row-lock");
                guardTarget = { entryIds: ids, dayKeys: [] };
                return (options.rows ?? ENTRIES).filter((r) => ids.includes(r.id)).map((r) => ({ startTime: r.startTime }));
            }
            return [];
        },
        payrollPeriod: { findMany: async () => [] },
        timeEntry: {
            findMany: async () => {
                trace.push("discover");
                options.onGuard?.();
                return options.rows ?? ENTRIES;
            },
            deleteMany: async () => {
                trace.push("delete-entries");
                return { count: (options.rows ?? ENTRIES).length };
            },
            count: async () => options.leftover ?? 0,
        },
    };
    return { tx, trace, guard: () => guardTarget };
}

test("the payroll lock is taken FIRST, and BEFORE anything is discovered", async () => {
    const { tx, trace } = fakeTx({});
    await deleteParentWithTimeEntries({ projectId: "proj-1" }, async () => { trace.push("parent"); }, {
        runTransaction: (fn) => fn(tx as never),
    });
    assert.equal(trace[0], "payroll-lock", "deferring the lock to the guard left a window before discovery");
    assert.ok(trace.indexOf("payroll-lock") < trace.indexOf("discover"));
    // The guard re-takes the payroll lock when it runs; pg_advisory_xact_lock is
    // re-entrant within a transaction, so that is a no-op rather than a second
    // acquisition. What matters is the ORDER, and that the first one precedes
    // discovery.
    assert.deepEqual(trace.filter((s) => s !== "day-lock" && s !== "payroll-lock"), [
        "discover",
        "row-lock",
        "delete-entries",
        "parent",
    ]);
});

test("a parent with NO entries still takes the payroll lock", async () => {
    // This is the hole: an empty lock target made the guard return early, so
    // nothing serialized this delete against a clock-in landing mid-flight.
    const { tx, trace } = fakeTx({ rows: [] });
    await deleteParentWithTimeEntries({ userId: "u-nobody" }, async () => { trace.push("parent"); }, {
        runTransaction: (fn) => fn(tx as never),
    });
    assert.ok(trace.includes("payroll-lock"), "the lock is unconditional");
    assert.equal(trace[0], "payroll-lock");
});

test("an entry created AFTER discovery aborts the whole delete", async () => {
    // The new row has never been checked against a locked period, so deleting it
    // anyway is exactly the silent destruction this module exists to prevent.
    const { tx, trace } = fakeTx({ leftover: 1 });
    let parentDeleted = false;

    await assert.rejects(
        () =>
            deleteParentWithTimeEntries({ projectId: "proj-1" }, async () => { parentDeleted = true; }, {
                runTransaction: (fn) => fn(tx as never),
            }),
        (error: Error) => isConcurrentTimeEntryError(error) && /try again/.test(error.message)
    );
    assert.equal(parentDeleted, false, "the parent must survive an aborted delete");
    assert.ok(trace.includes("delete-entries"), "the abort happens after the checked set is removed, and rolls it back");
});

test("only the CHECKED id set is deleted, never everything under the parent", () => {
    const source = read("src/lib/payroll-parent-delete.ts");
    // Scoping the delete by the parent would sweep up any row that appeared
    // since discovery — a row no locked-period check has ever seen.
    assert.match(source, /deleteMany\(\{ where: \{ id: \{ in: entryIds \} \} \}\)/);
    assert.doesNotMatch(source, /deleteMany\(\{ where \}\)/);
    // And the leftover count is what turns that narrower delete into a refusal
    // rather than a silent orphan.
    assert.match(source, /count\(\{ where: \{ OR: scopes as never \} \}\)/);
    assert.match(source, /leftover > 0\) throw new ConcurrentTimeEntryError/);
});

test("the LOCKED branch: nothing is deleted and the parent survives", async () => {
    let parentDeleted = false;
    const { tx } = fakeTx({});

    await assert.rejects(
        () =>
            deleteParentWithTimeEntries({ userId: "u1" }, async () => { parentDeleted = true; }, {
                runTransaction: async (fn) => {
                    // What assertEntriesUnlockedInTx really does when a row is
                    // frozen: it throws before the delete can run.
                    (tx as any).$queryRawUnsafe = async (sql: string) => {
                        if (sql.includes("FOR UPDATE")) throw new PeriodLockedError(LOCKED_PERIOD);
                        return [];
                    };
                    return fn(tx as never);
                },
            }),
        (error: Error) => error.name === "PeriodLockedError"
    );
    assert.equal(parentDeleted, false, "a locked period must leave the parent standing");
});

test("the day locks are the qualified wa-breaks key, sorted", () => {
    const source = read("src/lib/payroll-parent-delete.ts");
    assert.match(source, /dayLockKey\(entry\.userId, toCompanyDayKey\(entry\.startTime\)\)/);
    assert.match(source, /\]\.sort\(\)/);
});

// ── Item 4: the whole selection, or none of it ──────────────────────────────

test("MANY parents are checked before ANY parent is deleted", async () => {
    const { tx, trace } = fakeTx({});
    let deletedParents = 0;
    await deleteParentsWithTimeEntries(
        [{ projectId: "p-unlocked" }, { projectId: "p-other" }],
        async () => { deletedParents += 1; trace.push("parents"); },
        { runTransaction: (fn) => fn(tx as never) }
    );
    // ONE callback for the whole set, inside ONE transaction — not a loop of
    // independent deletes.
    assert.equal(deletedParents, 1);
    assert.ok(trace.indexOf("delete-entries") < trace.indexOf("parents"));
});

test("one unlocked + one LOCKED project: nothing is deleted at all", async () => {
    // The loop-per-project version left the caller half-deleted when the second
    // job turned out to be locked, with nothing to undo the first.
    let parentsDeleted = false;
    const { tx } = fakeTx({});
    (tx as any).$queryRawUnsafe = async (sql: string) => {
        // The guard sees BOTH projects' rows at once, so the locked one aborts
        // the batch before any project row is touched.
        if (sql.includes("FOR UPDATE")) throw new PeriodLockedError(LOCKED_PERIOD);
        return [];
    };

    await assert.rejects(
        () =>
            deleteParentsWithTimeEntries(
                [{ projectId: "p-unlocked" }, { projectId: "p-locked" }],
                async () => { parentsDeleted = true; },
                { runTransaction: (fn) => fn(tx as never) }
            ),
        (error: Error) => error.name === "PeriodLockedError"
    );
    assert.equal(parentsDeleted, false, "the unlocked project must survive too — it is one transaction");
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

test("the users route answers 423 for a locked period", () => {
    const users = read("src/app/api/users/[id]/route.ts");
    assert.match(users, /deleteParentWithTimeEntries\(\{ userId: id \}/);
    assert.match(users, /isPeriodLockedError\(error\)\) return periodLockedResponse\(error\.period\)/);
    // Ordered before the generic 500 handler, or a locked period reads as a crash.
    assert.ok(users.indexOf("isPeriodLockedError") < users.indexOf("Internal server error"));
});
