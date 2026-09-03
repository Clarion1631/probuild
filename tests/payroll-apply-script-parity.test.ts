/**
 * The migration and the standalone apply script must describe the SAME schema.
 *
 * They are two hand-maintained copies of one set of DDL, and round 16 proved
 * how that goes: the discard columns, their index and their CHECK constraint
 * shipped in prisma/migrations/.../migration.sql and were simply forgotten in
 * scripts/apply-payroll-phase5.mjs. CI replays the migration, so CI was green —
 * but the script is what gets run against production, and a prod run would have
 * left discardPayrollPeriod writing to columns that did not exist.
 *
 * This test parses both files and asserts that every name the migration
 * introduces appears in the script. It is deliberately name-level rather than
 * SQL-equivalence: an exact comparison of two differently-shaped files would be
 * unmaintainable, whereas a forgotten column is exactly a forgotten NAME.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATION = "prisma/migrations/20260901000000_payroll_phase5/migration.sql";
const SCRIPT = "scripts/apply-payroll-phase5.mjs";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/** Every `ADD COLUMN [IF NOT EXISTS] "x"`, as table -> column. */
function addedColumns(sql: string): Array<{ table: string; column: string }> {
    const found: Array<{ table: string; column: string }> = [];
    const pattern = /ALTER TABLE\s+"(\w+)"\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"(\w+)"/gi;
    for (const match of sql.matchAll(pattern)) found.push({ table: match[1], column: match[2] });
    return found;
}

function createdIndexes(sql: string): string[] {
    return [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+"(\w+)"/gi)].map((m) => m[1]);
}

function addedConstraints(sql: string): string[] {
    return [...sql.matchAll(/ADD CONSTRAINT\s+"(\w+)"/gi)].map((m) => m[1]);
}

function createdTables(sql: string): string[] {
    return [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"(\w+)"/gi)].map((m) => m[1]);
}

test("the migration actually declares something — the parser is not silently matching nothing", () => {
    const sql = read(MIGRATION);
    // A parser that returns [] would make every assertion below vacuously true.
    // This is the control.
    assert.ok(addedColumns(sql).length >= 3, "expected ADD COLUMN statements");
    assert.ok(createdIndexes(sql).length >= 1, "expected CREATE INDEX statements");
    assert.ok(addedConstraints(sql).length >= 1, "expected ADD CONSTRAINT statements");
});

test("every COLUMN the migration adds is also added by the apply script", () => {
    const script = read(SCRIPT);
    const missing = addedColumns(read(MIGRATION)).filter(({ column }) => !script.includes(`"${column}"`));
    assert.deepEqual(
        missing,
        [],
        "these columns ship in the migration but never reach production, because the apply script is what is actually run there"
    );
});

test("every INDEX the migration creates is also created by the apply script", () => {
    const script = read(SCRIPT);
    const missing = createdIndexes(read(MIGRATION)).filter((name) => !script.includes(name));
    assert.deepEqual(missing, []);
});

test("every CONSTRAINT the migration adds is also added by the apply script", () => {
    const script = read(SCRIPT);
    const missing = addedConstraints(read(MIGRATION)).filter((name) => !script.includes(name));
    assert.deepEqual(missing, []);
});

test("every TABLE the migration creates is also created by the apply script", () => {
    const script = read(SCRIPT);
    const missing = createdTables(read(MIGRATION)).filter((name) => !script.includes(name));
    assert.deepEqual(missing, []);
});

test("a CHECK constraint the migration validates is validated by the script too", () => {
    // NOT VALID is not enforcement: an unvalidated constraint lets existing rows
    // stay wrong, so prod would disagree with CI's replay of the same file.
    const sql = read(MIGRATION);
    const script = read(SCRIPT);
    for (const match of sql.matchAll(/VALIDATE CONSTRAINT\s+"(\w+)"/gi)) {
        assert.match(script, new RegExp(`VALIDATE CONSTRAINT[\\s\\S]{0,40}${match[1]}`), match[1]);
    }
});

test("the script VERIFIES what it wrote, and exits nonzero when it drifted", () => {
    const script = read(SCRIPT);
    // A DDL script that reports success without checking is how the round-16
    // gap would have surfaced only when somebody clicked Discard in production.
    assert.match(script, /const drift = await findSchemaDrift\(prisma\)/);
    assert.match(script, /drift\.length > 0/);
    assert.match(script, /process\.exit\(1\)/);
    assert.match(script, /objects present and matching their expected definitions/);
    // The old count-only checks are gone: they asked whether things EXISTED,
    // which an index on the wrong columns or a weakened CHECK passes.
    assert.doesNotMatch(script, /discardBits\.length !== 5/);
    assert.doesNotMatch(script, /cols\.length !== 9/);
    // The FK conversion check stays.
    assert.match(script, /cascading\.length !== 0\) process\.exit\(1\)/);
});

test("--dry-run is read-only for the WHOLE script, not just the seed", async () => {
    const { isDryRun } = await import("../scripts/apply-payroll-phase5.mjs");
    assert.equal(isDryRun(["node", "s.mjs", "--dry-run"]), true);
    assert.equal(isDryRun(["node", "s.mjs"]), false);

    const script = read(SCRIPT);
    // It is the verification step for a deploy now, so it has to be safe to
    // point at production. An earlier revision gated only the payType seed on
    // this flag and executed every DDL statement regardless — which made
    // "--dry-run" a lie in the one place it mattered most.
    const main = script.slice(script.indexOf("async function main()"));
    const gate = main.slice(main.indexOf("if (dryRun) {"), main.indexOf("no statement was executed"));
    assert.match(gate, /findSchemaDrift\(prisma\)/);
    assert.match(gate, /nothing to do/);
    assert.doesNotMatch(gate, /\$executeRawUnsafe/, "a dry run that writes is not a dry run");

    // It RETURNS before the statement loop — the gate is not merely a branch
    // inside it.
    assert.ok(
        main.indexOf("no statement was executed") < main.indexOf("for (const sql of STATEMENTS)"),
        "the dry-run gate must precede the DDL"
    );

    // And the seed's own dry-run branch is gone, rather than left unreachable.
    const seed = main.slice(main.indexOf("const salaried = classifySalariedEmails"));
    const body = seed.slice(0, seed.indexOf("const unconfirmed"));
    assert.doesNotMatch(body, /dryRun/, "dead branches rot into false assurance");
    assert.match(body, /UPDATE "User" SET "payType" = 'SALARY'/);
});

test("the object list carries DEFINITIONS, not just names", async () => {
    const { EXPECTED_OBJECTS, EXPECTED_SCHEMA } = await import("../scripts/apply-payroll-phase5.mjs");
    assert.equal(EXPECTED_SCHEMA, "public");
    assert.ok(EXPECTED_OBJECTS.length >= 35, `expected a full object list, got ${EXPECTED_OBJECTS.length}`);
    const names = EXPECTED_OBJECTS.map((o: { name?: string; table?: string }) => o.name ?? o.table);

    for (const required of [
        "payType",
        "lastRateSyncAt",
        "discardedAt",
        "PayrollPeriod_discard_unlocked",
        "TimeEntry_userId_fkey",
        "TimeEntry_projectId_fkey",
        "HelpSubmissionQuota",
    ]) {
        assert.ok(names.includes(required), `${required} missing from EXPECTED_OBJECTS`);
    }

    // Presence is not correctness — every kind has to say what "correct" is.
    const indexes = EXPECTED_OBJECTS.filter((o: { kind: string }) => o.kind === "index");
    assert.ok(indexes.length >= 8);
    for (const index of indexes) {
        assert.ok(Array.isArray(index.columns) && index.columns.length > 0, `${index.name} has no expected columns`);
        assert.equal(typeof index.unique, "boolean", `${index.name} does not say whether it is unique`);
        assert.ok(index.table, `${index.name} does not say which table it is on`);
    }

    const columns = EXPECTED_OBJECTS.filter((o: { kind: string }) => o.kind === "column");
    for (const column of columns) {
        assert.ok(column.type, `${column.table}.${column.name} has no expected type`);
        assert.equal(typeof column.nullable, "boolean", `${column.table}.${column.name} has no expected nullability`);
    }

    // The CHECK constraints carry the expressions they must still contain.
    const checks = EXPECTED_OBJECTS.filter((o: { kind: string; def?: unknown }) => o.kind === "constraint" && o.def);
    assert.ok(checks.length >= 4, "the CHECK expressions must be pinned, not just their names");

    // FKs assert ON DELETE specifically — present-but-CASCADE is the bug.
    const fks = EXPECTED_OBJECTS.filter((o: { kind: string }) => o.kind === "fk");
    assert.equal(fks.length, 2);
    for (const fk of fks) assert.equal(fk.onDelete, "r");

    // All five protected tables, RLS on, zero policies (that IS the deny-all).
    // TimeEntry and HelpRequest were the adversarial-review finding: RLS shipped
    // for PayrollPeriod/User/HelpSubmissionQuota but not for these two, leaving
    // raw payroll hours and crew help reports reachable by a leaked
    // anon/authenticated Supabase key through PostgREST.
    const rls = EXPECTED_OBJECTS.filter((o: { kind: string }) => o.kind === "rls");
    assert.deepEqual(
        rls.map((o: { table?: string }) => o.table).sort(),
        ["HelpRequest", "HelpSubmissionQuota", "PayrollPeriod", "TimeEntry", "User"]
    );
    for (const table of rls) assert.equal(table.policies, 0);

    // Every column the migration creates should be in the list, or the dry run
    // under-reports what is missing.
    const sql = read(MIGRATION);
    for (const match of sql.matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"(\w+)"/gi)) {
        assert.ok(names.includes(match[1]), `column ${match[1]} is created but not verified`);
    }
});

test("every catalog lookup is SCHEMA-QUALIFIED", async () => {
    const script = read(SCRIPT);
    const fn = script.slice(script.indexOf("export async function findSchemaDrift"));
    const body = fn.slice(0, fn.indexOf("export async function findMissingObjects"));
    // to_regclass and a bare table_name both resolve through search_path, so an
    // object of the same name in another schema would answer for the real one —
    // the drift check would report healthy while describing the wrong object.
    assert.match(body, /table_schema = \$1/);
    assert.match(body, /schemaname = \$1/);
    assert.match(body, /n\.nspname = \$1/);
    assert.doesNotMatch(body, /to_regclass/, "to_regclass resolves through search_path");
    // The RLS and constraint lookups join pg_namespace rather than trusting the
    // regclass cast.
    assert.match(body, /JOIN pg_namespace n ON n\.oid = t\.relnamespace/);
    assert.match(body, /JOIN pg_namespace n ON n\.oid = c\.relnamespace/);
});

test("IMPORTING the script must not load production env or run anything", () => {
    const script = read(SCRIPT);
    // On 2026-09-02 a test imported this module to reach classifySalariedEmails.
    // The module called config({ path: ".env.production.local" }) at top level,
    // so the import loaded PRODUCTION credentials and executed the entire
    // migration against them. Everything with a side effect now lives in main().
    // Guard spelling matches the one #446 applied across every scripts/apply-*.mjs
    // (and enforced repo-wide by tests/apply-scripts-inert-on-import.test.ts).
    assert.match(script, /const isMainModule = process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    assert.match(script, /if \(isMainModule\) \{\s*\n\s*await main\(\);/);

    // The dangerous calls must all be INSIDE main(), never at module scope.
    const beforeMain = script.slice(0, script.indexOf("async function main()"));
    assert.doesNotMatch(beforeMain, /config\(\{ path:/, "env loading at module scope runs on import");
    assert.doesNotMatch(beforeMain, /new PrismaClient\(/, "constructing a client at module scope connects on import");
    assert.doesNotMatch(beforeMain, /\$executeRawUnsafe/, "no statement may run at module scope");
});
