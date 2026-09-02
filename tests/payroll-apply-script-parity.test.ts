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

test("the script VERIFIES what it wrote, and exits nonzero when it is missing", () => {
    const script = read(SCRIPT);
    // A DDL script that reports success without checking is how the round-16
    // gap would have surfaced only when somebody clicked Discard in production.
    assert.match(script, /discard columns, index and validated CHECK/);
    assert.match(script, /discardBits\.length !== 5\) process\.exit\(1\)/);
    // The pre-existing verifications are still there.
    assert.match(script, /cols\.length !== 9\) process\.exit\(1\)/);
    assert.match(script, /cascading\.length !== 0\) process\.exit\(1\)/);
});

test("the discard DDL is present in the script in full", () => {
    const script = read(SCRIPT);
    for (const column of ["discardedAt", "discardedById", "discardedReason"]) {
        assert.match(script, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`), column);
    }
    assert.match(script, /PayrollPeriod_discardedAt_idx/);
    assert.match(script, /CHECK \("discardedAt" IS NULL OR "lockedAt" IS NULL\)/);
    // Idempotent: DROP ... IF EXISTS before ADD, so a replay does not fail on
    // the constraint already being there.
    assert.match(script, /DROP CONSTRAINT IF EXISTS "PayrollPeriod_discard_unlocked"/);
});

// ── The script guesses nothing, and importing it does nothing (round 19) ────

test("no salaried list means NOBODY is seeded — the script never guesses a pay type", async () => {
    const { classifySalariedEmails } = await import("../scripts/apply-payroll-phase5.mjs");
    // The previous revision defaulted this to two named people. That is the same
    // guess the NULL column exists to prevent, aimed the other way: if either had
    // actually been hourly, the export would have silently dropped their hours.
    assert.deepEqual(classifySalariedEmails(undefined), []);
    assert.deepEqual(classifySalariedEmails(""), []);
    assert.deepEqual(classifySalariedEmails("   "), []);
    assert.deepEqual(classifySalariedEmails(null), []);
    assert.deepEqual(classifySalariedEmails(42), []);
});

test("the list is normalised: trimmed, lower-cased, de-duplicated, sorted", async () => {
    const { classifySalariedEmails } = await import("../scripts/apply-payroll-phase5.mjs");
    assert.deepEqual(
        classifySalariedEmails(" B@x.com , a@x.com ,, A@X.com "),
        ["a@x.com", "b@x.com"],
        "the SQL compares lower(email), so the list has to match that shape"
    );
});

test("no hardcoded person survives anywhere in the script", () => {
    const script = read(SCRIPT);
    assert.doesNotMatch(script, /goldentouchremodeling\.com/, "the script must not name individual employees");
    assert.match(script, /classifySalariedEmails\(process\.env\.PAYROLL_SALARIED_EMAILS\)/);
    // And it says so out loud when the list is empty, rather than seeding silently.
    assert.match(script, /PAYROLL_SALARIED_EMAILS is not set/);
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
    assert.match(gate, /findMissingObjects\(prisma\)/);
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

test("the object list is what both the dry run and the real run verify against", async () => {
    const { EXPECTED_OBJECTS } = await import("../scripts/apply-payroll-phase5.mjs");
    // One list, so "applied" cannot mean two different things.
    assert.ok(EXPECTED_OBJECTS.length >= 30, `expected a full object list, got ${EXPECTED_OBJECTS.length}`);
    const names = EXPECTED_OBJECTS.map((o: { name: string }) => o.name);
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
    // The FK entries assert RESTRICT specifically — present-but-CASCADE is not
    // "applied", it is the bug.
    const fks = EXPECTED_OBJECTS.filter((o: { kind: string }) => o.kind === "fk-restrict");
    assert.equal(fks.length, 2);

    // Every column the migration creates should be in the list, or the dry run
    // under-reports what is missing.
    const sql = read(MIGRATION);
    for (const match of sql.matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"(\w+)"/gi)) {
        assert.ok(names.includes(match[1]), `column ${match[1]} is created but not verified`);
    }
});

test("IMPORTING the script must not load production env or run anything", () => {
    const script = read(SCRIPT);
    // On 2026-09-02 a test imported this module to reach classifySalariedEmails.
    // The module called config({ path: ".env.production.local" }) at top level,
    // so the import loaded PRODUCTION credentials and executed the entire
    // migration against them. Everything with a side effect now lives in main().
    assert.match(script, /const isMainModule = process\.argv\[1\] && fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/);
    assert.match(script, /if \(isMainModule\) \{\s*\n\s*await main\(\);/);

    // The dangerous calls must all be INSIDE main(), never at module scope.
    const beforeMain = script.slice(0, script.indexOf("async function main()"));
    assert.doesNotMatch(beforeMain, /config\(\{ path:/, "env loading at module scope runs on import");
    assert.doesNotMatch(beforeMain, /new PrismaClient\(/, "constructing a client at module scope connects on import");
    assert.doesNotMatch(beforeMain, /\$executeRawUnsafe/, "no statement may run at module scope");
});
