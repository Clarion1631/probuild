/**
 * Deleting a parent that owns time entries (review round 16, item 2).
 *
 * TimeEntry CASCADEd from both User and Project, so deleting a former employee
 * or an old job silently destroyed their payroll history — including hours
 * inside a LOCKED period that had already been exported and paid. Both foreign
 * keys are RESTRICT now, and this module is the only sanctioned way past them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deleteParentWithTimeEntries } from "../src/lib/payroll-parent-delete";
import { PeriodLockedError } from "../src/lib/payroll-period";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-parent-delete";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

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

test("the UNLOCKED branch: entries go first, then the parent, in ONE transaction", async () => {
    const order: string[] = [];
    let target: unknown = null;

    const result = await deleteParentWithTimeEntries(
        { projectId: "proj-1" },
        async () => {
            order.push("parent");
        },
        {
            readEntries: async () => ENTRIES,
            runWrite: (async (t: any, write: any) => {
                target = t;
                const tx = {
                    timeEntry: {
                        deleteMany: async () => {
                            order.push("entries");
                            return { count: 2 };
                        },
                    },
                };
                return write(tx);
            }) as never,
        }
    );

    assert.deepEqual(order, ["entries", "parent"], "the parent cannot go first — the FK is RESTRICT now");
    assert.equal(result.deletedEntries, 2);

    // Every row is locked, and the DAY keys are the qualified form settlement
    // uses. A bare "2026-08-24" hashes to a different advisory lock, which would
    // leave this delete and a concurrent settlement believing they were
    // serialized against each other when they were not.
    const t = target as { entryIds: string[]; dayKeys: string[] };
    assert.deepEqual(t.entryIds, ["e1", "e2"]);
    for (const key of t.dayKeys) assert.match(key, /^wa-breaks:u1:\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(t.dayKeys, [...t.dayKeys].sort(), "sorted, so two deletes cannot deadlock on each other");
});

test("the LOCKED branch: nothing is deleted and the parent survives", async () => {
    let parentDeleted = false;

    await assert.rejects(
        () =>
            deleteParentWithTimeEntries(
                { userId: "u1" },
                async () => {
                    parentDeleted = true;
                },
                {
                    readEntries: async () => ENTRIES,
                    // What withPayrollWriteTx really does when a row is frozen:
                    // it throws before the write callback ever runs.
                    runWrite: (async () => {
                        throw new PeriodLockedError(LOCKED_PERIOD);
                    }) as never,
                }
            ),
        (error: Error) => error.name === "PeriodLockedError"
    );

    assert.equal(parentDeleted, false, "a locked period must leave the parent standing");
});

test("the delete is scoped by the PARENT, not by the id list read beforehand", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/payroll-parent-delete.ts"), "utf8");
    // An entry created between the read and the transaction would otherwise
    // survive and block the parent delete with a bare foreign-key error.
    assert.match(source, /deleteMany\(\{ where \}\)/);
});

test("both foreign keys are RESTRICT in the schema", () => {
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model TimeEntry {"));
    const body = model.slice(0, model.indexOf("\n}"));
    assert.match(body, /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Restrict\)/);
    assert.match(body, /project\s+Project\s+@relation\(fields: \[projectId\], references: \[id\], onDelete: Restrict\)/);
    assert.doesNotMatch(body, /onDelete: Cascade/);
});

test("User and Project are the ONLY parents that cascaded into TimeEntry", () => {
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
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
    const sql = readFileSync(
        path.join(process.cwd(), "prisma/migrations/20260901000000_payroll_phase5/migration.sql"),
        "utf8"
    );
    // 'c' is CASCADE. A second run finds 'r' and does nothing.
    assert.match(sql, /confdeltype = 'c'/);
    assert.match(sql, /ON DELETE RESTRICT ON UPDATE CASCADE/);
    assert.match(sql, /TimeEntry_userId_fkey/);
    assert.match(sql, /TimeEntry_projectId_fkey/);

    // The standalone apply script has to carry the SAME conversion, or a prod
    // run of the script leaves the cascade in place.
    const script = readFileSync(path.join(process.cwd(), "scripts/apply-payroll-phase5.mjs"), "utf8");
    assert.match(script, /confdeltype = 'c'/);
    assert.match(script, /ON DELETE RESTRICT ON UPDATE CASCADE/);
    assert.match(script, /still cascading/);
});

test("both delete paths go through the helper, and the API one answers 423", () => {
    const users = readFileSync(path.join(process.cwd(), "src/app/api/users/[id]/route.ts"), "utf8");
    assert.match(users, /deleteParentWithTimeEntries\(\{ userId: id \}/);
    assert.match(users, /isPeriodLockedError\(error\)\) return periodLockedResponse\(error\.period\)/);
    // Ordered before the generic 500 handler, or a locked period reads as a crash.
    assert.ok(users.indexOf("isPeriodLockedError") < users.indexOf("Internal server error"));

    const actions = readFileSync(path.join(process.cwd(), "src/lib/actions.ts"), "utf8");
    const del = actions.slice(actions.indexOf("export async function deleteProjects"));
    const body = del.slice(0, del.indexOf("\nexport "));
    assert.match(body, /deleteParentWithTimeEntries\(\{ projectId \}/);
    // One project at a time: a single deleteMany cascaded every punch on every
    // job in the list and reported success.
    assert.doesNotMatch(body, /project\.deleteMany/);
});
