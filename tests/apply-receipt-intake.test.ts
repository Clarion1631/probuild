/**
 * The rollout script and the committed migration must describe the SAME table.
 *
 * They are written twice on purpose — the script is what PRODUCTION gets
 * (before the deploy that selects these columns), the migration is what a fresh
 * CI/dev database gets — and nothing else in the repo notices when the two
 * drift. CI's `migrations` job would eventually catch a difference by diffing
 * against production, but only AFTER the script has been run there, which is
 * exactly the wrong time to find out.
 *
 * Importing the script must NOT open a connection or read DATABASE_URL: all of
 * that sits behind the isMainModule guard, the same shape apply-bank-ledger has.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RECEIPT_INTAKE_STATES, statements, targetMatches } from "../scripts/apply-receipt-intake.mjs";
import { RECEIPT_INTAKE_STATES as RUNTIME_STATES } from "../src/lib/receipt-intake/route-state";

const migrationSql = readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20260901000000_receipt_intake", "migration.sql"),
    "utf8",
);

/** Compare SQL by meaning, not by indentation: collapse whitespace, drop comments. */
function normalize(sql: string): string {
    return sql
        .split(/\r?\n/)
        .filter(line => !/^\s*--/.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/\s*([(),])\s*/g, "$1")
        .trim()
        .toLowerCase();
}

test("every column the apply script creates is in the committed migration", () => {
    const createTable = statements.find((s: string) => s.includes('CREATE TABLE IF NOT EXISTS "ReceiptIntake"'));
    assert.ok(createTable, "the script must create the table");
    const columns = Array.from(createTable.matchAll(/"([a-zA-Z0-9]+)"\s+(TEXT|BOOLEAN|INTEGER|DOUBLE PRECISION|DATE|TIMESTAMP\(3\))/g))
        .map(m => m[1]);
    assert.ok(columns.length >= 36, `expected the full column list, found ${columns.length}`);
    const migration = normalize(migrationSql);
    for (const column of columns) {
        assert.ok(migration.includes(`"${column.toLowerCase()}"`), `migration.sql is missing "${column}"`);
    }
});

test("the partial unique index is identical in both, predicate included", () => {
    // This index IS the strong-dedup claim. A version of it without the
    // predicate would reject legitimate re-reads of a quarantined row; a
    // version with a different predicate would quarantine the wrong things.
    const fromScript = statements.find((s: string) => s.includes("ReceiptIntake_dedupStrongKey_active_key"));
    assert.ok(fromScript);
    const expected = normalize(fromScript);
    const fromMigration = migrationSql
        .split(";")
        .map(normalize)
        .find(s => s.includes("receiptintake_dedupstrongkey_active_key"));
    assert.equal(fromMigration, expected);
    assert.ok(expected.includes(`where "dedupstrongkey" is not null and "state" not in('duplicate','void')`));
});

test("both files declare the SAME closed state set, and it matches the runtime one", () => {
    // A state the CHECK constraint rejects but the code can produce is a
    // guaranteed 500 on a document nobody can then see.
    assert.deepEqual([...RUNTIME_STATES].sort(), [...RECEIPT_INTAKE_STATES].sort());
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"));
    assert.ok(check, "the script must add the state CHECK constraint");
    for (const state of RECEIPT_INTAKE_STATES) {
        assert.ok(check.includes(`'${state}'`), `apply script CHECK is missing ${state}`);
        assert.ok(migrationSql.includes(`'${state}'`), `migration.sql CHECK is missing ${state}`);
    }
});

test("every FK and index in the script also exists in the migration", () => {
    const names = statements.flatMap((sql: string) =>
        Array.from(sql.matchAll(/(?:INDEX IF NOT EXISTS|CONSTRAINT) "([^"]+)"/g), m => m[1]),
    );
    assert.ok(names.length >= 9, `expected the full object list, found ${names.length}`);
    for (const name of new Set(names)) {
        assert.ok(migrationSql.includes(`"${name}"`), `migration.sql is missing ${name}`);
        // PostgreSQL silently truncates past 63 bytes, which would make
        // "IF NOT EXISTS" match a different object than the one intended.
        assert.ok(Buffer.byteLength(name, "utf8") <= 63, `identifier "${name}" is too long`);
    }
});

test("every statement is idempotent — the script is safe to re-run", () => {
    for (const sql of statements) {
        const guarded =
            /CREATE TABLE IF NOT EXISTS/.test(sql) ||
            /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/.test(sql) ||
            /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/.test(sql);
        assert.ok(guarded, `not idempotent: ${sql.slice(0, 80)}`);
    }
});

test("the target guard needs BOTH the database name and the host", () => {
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.5"), true);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.9" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches({ db: "staging", host: "10.0.0.5" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches(null, "postgres", "10.0.0.5"), false);
});
