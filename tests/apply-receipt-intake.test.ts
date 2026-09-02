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
            /ALTER TABLE .* ADD COLUMN IF NOT EXISTS/.test(sql) ||
            // Re-enabling RLS on a table that already has it is a no-op.
            /ENABLE ROW LEVEL SECURITY/.test(sql) ||
            /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/.test(sql) ||
            // The state CHECK is convergent rather than skip-if-present: it
            // compares pg_get_constraintdef and only rewrites on a difference,
            // so a second run is a no-op just the same.
            (/pg_get_constraintdef/.test(sql) && /IS DISTINCT FROM/.test(sql));
        assert.ok(guarded, `not idempotent: ${sql.slice(0, 80)}`);
    }
});

test("the target guard needs BOTH the database name and the host, EXACTLY", () => {
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.5"), true);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.9" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches({ db: "staging", host: "10.0.0.5" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches(null, "postgres", "10.0.0.5"), false);

    // A substring match (which apply-bank-image.mjs uses) gets LOOSER the
    // shorter the operator's input is: "1" would satisfy `host.includes`
    // against 10.0.0.5, 172.16.1.1 and almost anything else. A guard whose
    // whole job is to stop DDL landing on the wrong server must not have a
    // degenerate case.
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "1"), false);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.55"), false);
    assert.equal(targetMatches({ db: "postgres", host: "" }, "postgres", "10.0.0.5"), false);
});

test("the partial-index verification checks UNIQUE and the exact predicate", () => {
    // Existence alone is not enough: a NON-unique index of the same name claims
    // nothing, so every duplicate would sail through while the script reported
    // success.
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-receipt-intake.mjs"), "utf8");
    assert.match(source, /CREATE UNIQUE INDEX/, "the verifier asserts uniqueness");
    assert.match(source, /indpred IS NOT NULL/, "the verifier asserts the index is PARTIAL");
    assert.ok(
        source.includes(`WHERE \\(\\("dedupStrongKey" IS NOT NULL\\) AND \\(state <> ALL \\(ARRAY\\['DUPLICATE'::text, 'VOID'::text\\]\\)\\)\\)`),
        "the verifier asserts the exact predicate, not merely that one exists",
    );
});

test("the state CHECK guard is scoped to the ReceiptIntake table", () => {
    // pg_constraint names are not globally unique — conname alone would let an
    // identically-named constraint on ANOTHER table satisfy the guard, and the
    // CHECK would silently never be created.
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"));
    assert.match(check!, /conrelid = '"ReceiptIntake"'::regclass/);
    assert.match(migrationSql, /conrelid = '"ReceiptIntake"'::regclass/);
});

test("the busyPasses column is ALSO added by an ALTER, so an earlier table upgrades", () => {
    // CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so
    // a column added only to the CREATE would never reach a database where the
    // rollout script had already run once. This is the whole reason the script
    // is re-runnable.
    const alter = statements.find((s: string) => /ADD COLUMN IF NOT EXISTS "busyPasses"/.test(s));
    assert.ok(alter, "the apply script must ALTER as well as CREATE");
    assert.match(migrationSql, /ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "busyPasses"/);
});

test("STAGING is in the state set, and is the column DEFAULT", () => {
    // A row is born STAGING: it exists, but its object is not in the bucket
    // yet, so the worker's claim predicate must not be able to see it.
    assert.ok(RECEIPT_INTAKE_STATES.includes("STAGING"));
    const create = statements.find((s: string) => s.includes('CREATE TABLE IF NOT EXISTS "ReceiptIntake"'));
    assert.match(create!, /"state"\s+TEXT NOT NULL DEFAULT 'STAGING'/);
    assert.match(migrationSql, /"state" TEXT NOT NULL DEFAULT 'STAGING'/);
});

test("RLS is enabled on ReceiptIntake, in both files, and WITHOUT force", () => {
    // Same shape as every other sensitive table here (apply-bank-ledger,
    // apply-automation-events, apply-deposit-ingest-schema): ENABLE with no
    // policies. The app connects as the owner/service role, which BYPASSES RLS,
    // so reads and writes are unaffected — while anon and authenticated roles
    // (a leaked anon key, a Supabase client someone wires up later) get nothing.
    //
    // FORCE is the trap: it applies RLS to the owner too, and with zero policies
    // that denies everything. It would take the pipeline down silently, as
    // empty result sets rather than errors.
    assert.ok(statements.some((s: string) => /ALTER TABLE "ReceiptIntake" ENABLE ROW LEVEL SECURITY/.test(s)));
    assert.match(migrationSql, /ALTER TABLE "ReceiptIntake" ENABLE ROW LEVEL SECURITY;/);
    assert.ok(!statements.some((s: string) => /FORCE ROW LEVEL SECURITY/.test(s)), "never FORCE");
    assert.ok(!/FORCE ROW LEVEL SECURITY/.test(migrationSql), "never FORCE");

    // And it must be recorded in the snapshot CI compares against production.
    const snapshot = JSON.parse(
        readFileSync(path.join(__dirname, "..", "prisma", "prisma-blind-spots.json"), "utf8"),
    );
    const entry = snapshot.rlsTables.find((r: { name: string }) => r.name === "ReceiptIntake");
    assert.ok(entry, "ReceiptIntake missing from prisma-blind-spots.json rlsTables");
    assert.equal(entry.forced, false);
});

test("SHADOW_DONE is a real state everywhere, so the cutover write cannot fail", () => {
    // The cutover UPDATE writes this value on every shadow-week row in one
    // statement. If the CHECK constraint did not know it, the entire cutover
    // would abort — inside the claim transaction, on the first live run.
    assert.ok(RECEIPT_INTAKE_STATES.includes("SHADOW_DONE"));
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"));
    assert.match(check!, /'SHADOW_DONE'/);
    assert.match(migrationSql, /'SHADOW_DONE'/);
    const snapshot = JSON.parse(
        readFileSync(path.join(__dirname, "..", "prisma", "prisma-blind-spots.json"), "utf8"),
    );
    const entry = snapshot.checkConstraints.find((r: { name: string }) => r.name === "ReceiptIntake_state_check");
    assert.match(entry.def, /'SHADOW_DONE'::text/);
});

test("SHADOW_DONE stays in the strong-key active set", () => {
    // A shadow-week row WAS booked (by v1), so its dedup key must keep
    // quarantining a post-cutover resend of the same receipt. Only DUPLICATE and
    // VOID — rows that represent nothing — drop out of the index.
    const index = statements.find((s: string) => s.includes("ReceiptIntake_dedupStrongKey_active_key"));
    assert.match(index!, /NOT IN \('DUPLICATE', 'VOID'\)/);
    assert.ok(!/SHADOW_DONE/.test(index!), "SHADOW_DONE must NOT be excluded");
});

test("the state CHECK is REPLACED when its definition drifts, not skipped", () => {
    // `IF NOT EXISTS` alone is wrong for a set that GROWS: a database carrying
    // the constraint from an earlier run keeps the OLD state list, so the first
    // write of a newly-added state (SHADOW_DONE, at cutover, inside the claim
    // transaction) fails and takes the whole cutover with it — while the script
    // that exists to prevent exactly that reported "ok".
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"));
    assert.ok(check);
    assert.match(check!, /pg_get_constraintdef/, "it compares the DEFINITION");
    assert.match(check!, /IS DISTINCT FROM/, "and reacts to a difference");
    assert.match(check!, /DROP CONSTRAINT "ReceiptIntake_state_check"/);
    assert.match(check!, /ADD CONSTRAINT "ReceiptIntake_state_check"/);
    // The wanted definition must name every state the code can produce, in
    // pg_get_constraintdef's own rendering.
    for (const state of RECEIPT_INTAKE_STATES) {
        assert.ok(check!.includes(`''${state}''::text`), `wanted_def is missing ${state}`);
    }
});

test("the wanted definition matches the snapshot CI compares against production", () => {
    // Two renderings of the same constraint that disagree would make the
    // apply script drop and re-add it on EVERY run.
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"))!;
    // [\s\S] rather than the /s flag — the tsconfig target predates it.
    const wanted = check.match(/wanted_def\s+TEXT\s*:=\s*'([\s\S]+?)';/)![1].replace(/''/g, "'");
    const snapshot = JSON.parse(
        readFileSync(path.join(__dirname, "..", "prisma", "prisma-blind-spots.json"), "utf8"),
    );
    const recorded = snapshot.checkConstraints.find(
        (r: { name: string }) => r.name === "ReceiptIntake_state_check",
    );
    assert.equal(wanted, recorded.def);
});

test("verification asserts the CHECK ALLOWS every state, not just that it exists", () => {
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-receipt-intake.mjs"), "utf8");
    assert.match(source, /pg_get_constraintdef\(oid\) AS def FROM pg_constraint/, "verify reads the definition");
    assert.match(source, /does not allow/, "and fails loudly naming what is missing");
});
