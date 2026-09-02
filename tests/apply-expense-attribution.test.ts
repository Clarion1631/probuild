/**
 * The rollout script and the committed migration must describe the SAME
 * columns.
 *
 * They are written twice on purpose — the script is what PRODUCTION gets
 * (before the deploy that selects these columns), the migration is what a fresh
 * CI/dev database gets — and nothing else in the repo notices when the two
 * drift. CI's `migrations` job would eventually catch a difference by diffing
 * against production, but only AFTER the script has been run there, which is
 * exactly the wrong time to find out.
 *
 * Importing the script must NOT open a connection or read DATABASE_URL: all of
 * that sits behind the isMainModule guard, the same shape apply-receipt-intake
 * has.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    expectedCheckConstraints,
    expectedColumns,
    expectedConstraints,
    expectedIndexes,
    reanchorSql,
    statements,
    targetMatches,
} from "../scripts/apply-expense-attribution.mjs";

const migrationSql = readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20260901120000_expense_attribution", "migration.sql"),
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

const normalizedMigration = normalize(migrationSql);

test("every statement the apply script runs is in the committed migration", () => {
    for (const statement of statements as string[]) {
        const wanted = normalize(statement).replace(/;$/, "");
        assert.ok(
            normalizedMigration.includes(wanted),
            `migration.sql is missing:\n  ${wanted}`,
        );
    }
});

test("the migration adds no Expense column the apply script does not", () => {
    // The reverse direction: a column added ONLY to the migration would exist
    // on a fresh CI database and be absent from production, which is the
    // failure mode P2022 shows up as.
    const migrationColumns = [...migrationSql.matchAll(/ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "(\w+)"/g)]
        .map(m => m[1])
        .sort();
    const scriptColumns = (statements as string[])
        .flatMap(s => [...s.matchAll(/ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "(\w+)"/g)].map(m => m[1]))
        .sort();
    assert.deepEqual(migrationColumns, scriptColumns);
    assert.deepEqual(scriptColumns, [...expectedColumns.Expense].sort());
});

test("the ReceiptIntake columns are behind a to_regclass guard in both files", () => {
    // Phase 1 and Phase 3 can land in either order. Without the guard, running
    // this against a database that has not seen Phase 1 yet aborts partway and
    // leaves the Expense half applied.
    const guarded = (statements as string[]).find(s => s.includes("ReceiptIntake"));
    assert.ok(guarded, "the script must touch ReceiptIntake");
    assert.match(guarded!, /to_regclass\('"ReceiptIntake"'\) IS NOT NULL/);
    assert.match(migrationSql, /to_regclass\('"ReceiptIntake"'\) IS NOT NULL/);
    for (const column of ["taxAtSource", "installedAtCustomer"]) {
        assert.ok(guarded!.includes(`"${column}"`), `script guard is missing ${column}`);
        assert.ok(migrationSql.includes(`"${column}"`), `migration is missing ${column}`);
    }
});

test("the backfill UPDATE only ever touches rows whose projectId is still NULL", () => {
    // This is the whole of its idempotency. A re-run must report 0 rows, and a
    // manual re-attribution must survive it.
    // Selected by what it WRITES, not by "the first UPDATE" — the script now
    // carries a second one (the updatedAt backfill), and a positional match
    // would have silently started asserting about the wrong statement.
    const update = (statements as string[]).find(
        s => s.trimStart().startsWith("UPDATE") && s.includes('SET "projectId"'),
    );
    assert.ok(update, "the script must carry the backfill UPDATE");
    assert.match(update!, /e\."projectId" IS NULL/);
    assert.match(update!, /est\."projectId" IS NOT NULL/);
    assert.ok(!/SET "projectId" = est\."projectId"[\s\S]*WHERE(?![\s\S]*projectId" IS NULL)/.test(update!));
});

test("the FK is SET NULL, named the way Prisma would name it, and guarded on its DEFINITION", () => {
    // A name-only `IF NOT EXISTS` would silently accept a pre-existing
    // Expense_projectId_fkey that points at another table or carries ON DELETE
    // CASCADE — exactly the thing SET NULL is here to prevent. Existing-and-
    // wrong must RAISE, not be skipped.
    const fk = (statements as string[]).find(s => s.includes("Expense_projectId_fkey"));
    assert.ok(fk);
    assert.match(fk!, /pg_get_constraintdef\(oid\)/);
    assert.match(fk!, /ON DELETE SET NULL ON UPDATE CASCADE/);
    // The in-database guard must check the SAME four properties the post-run
    // verifier does, or the two can disagree about what "correct" means.
    assert.match(fk!, /NOT LIKE '%FOREIGN KEY \("projectId"\)%'/);
    assert.match(fk!, /NOT LIKE '%REFERENCES "Project"\(id\)%'/);
    assert.match(fk!, /NOT LIKE '%ON DELETE SET NULL%'/);
    assert.match(fk!, /NOT LIKE '%ON UPDATE CASCADE%'/);
    assert.match(fk!, /RAISE EXCEPTION/);
    assert.ok(
        !/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/.test(fk!),
        "the name-only guard must be gone, not merely accompanied",
    );

    // ...and the post-run verification asserts the same thing against the live
    // catalog, rather than only asserting the constraint's NAME exists.
    assert.equal(expectedConstraints.length, 1);
    const [constraint] = expectedConstraints as { name: string; table: string; mustMatch: RegExp[] }[];
    assert.equal(constraint.name, "Expense_projectId_fkey");
    assert.equal(constraint.table, "Expense");
    const rendered = 'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE SET NULL';
    for (const pattern of constraint.mustMatch) {
        assert.match(rendered, pattern, `pg_get_constraintdef output must satisfy ${pattern}`);
    }
    // Both halves check the same four things — the SQL guard by LIKE, the
    // verifier by regex — so a constraint either guard accepts, the other does.
    for (const property of ['FOREIGN KEY ("projectId")', 'REFERENCES "Project"(id)', "ON DELETE SET NULL", "ON UPDATE CASCADE"]) {
        assert.ok(fk!.includes(`NOT LIKE '%${property}%'`), `SQL guard does not check ${property}`);
        assert.ok(
            constraint.mustMatch.some(pattern => pattern.test(property)),
            `verifier does not check ${property}`,
        );
    }
    // A CASCADE wearing the right name must fail every one of those checks.
    const cascade = 'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE CASCADE';
    assert.ok(
        constraint.mustMatch.some(pattern => !pattern.test(cascade)),
        "an ON DELETE CASCADE constraint of the same name must be rejected",
    );

    assert.deepEqual(expectedIndexes, [{ name: "Expense_projectId_idx", table: "Expense" }]);
});

test("every statement is additive — nothing drops, renames, or rewrites data", () => {
    for (const statement of statements as string[]) {
        // ONE exception, and it is not data: the tax CHECK is dropped and
        // re-added by name so a database carrying the OLD definition (which
        // refused every refund) is corrected rather than skipped. Nothing else
        // may drop anything, and nothing may drop a table, column or index.
        const isConstraintReplace =
            /DROP CONSTRAINT IF EXISTS "Expense_(taxAmount|taxDeductibleBase)_check"/.test(statement);
        assert.ok(
            isConstraintReplace || !/\bDROP\b/i.test(statement),
            `destructive statement: ${statement}`,
        );
        assert.ok(!/DROP (TABLE|COLUMN|INDEX)/i.test(statement), `destructive: ${statement}`);
        assert.ok(!/\bDELETE FROM\b/i.test(statement), `destructive statement: ${statement}`);
        assert.ok(!/\bTRUNCATE\b/i.test(statement), `destructive statement: ${statement}`);
    }
});

test("the target guard compares database AND host, both exactly", () => {
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.5"), true);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.50"), false);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10"), false);
    assert.equal(targetMatches({ db: "other", host: "10.0.0.5" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches(null, "postgres", "10.0.0.5"), false);
});

// ── the legacy date re-anchor (Codex round 6, item 1) ──────────────────────

test("the re-anchor only touches rows sitting at exactly 00:00 UTC", () => {
    // Rows written by time-expense-core have always used the shared parser and
    // sit at local noon; re-anchoring those would move them a second time.
    const sql = reanchorSql("America/Los_Angeles");
    assert.match(sql, /WHERE "date" IS NOT NULL/);
    assert.match(sql, /"date"::time = TIME '00:00:00'/);
    // ...and the predicate is what makes it once-only: after the update the
    // time-of-day is no longer midnight UTC, so a second run matches nothing.
    assert.match(sql, /AT TIME ZONE 'America\/Los_Angeles'/);
    assert.match(sql, /AT TIME ZONE 'UTC'/);
});

test("the re-anchor refuses a time zone it cannot safely interpolate", () => {
    // The zone reaches the database unparameterized, so it has to be an IANA
    // name and nothing else.
    for (const bad of ["x'; DROP TABLE \"Expense\"; --", "America/Los Angeles", "'", ""]) {
        assert.throws(() => reanchorSql(bad), /suspicious time zone/, JSON.stringify(bad));
    }
    for (const good of ["UTC", "America/Los_Angeles", "Europe/Isle_of_Man", "Etc/GMT+7"]) {
        assert.ok(reanchorSql(good).includes(`'${good}'`), good);
    }
});

test("the tax-vs-gross CHECK is in both DDL paths and in the verifier", () => {
    const guard = (statements as string[]).find(
        s => s.includes("Expense_taxAmount_check") && s.includes("ADD CONSTRAINT"),
    );
    assert.ok(guard, "the script must carry it");
    // Signed: the tax points the same way as the money and is never bigger.
    assert.match(guard!, /sign\("taxAmount"\) = sign\("amount"\)/);
    assert.match(guard!, /abs\("taxAmount"\) <= abs\("amount"\)/);
    // ...and the old definition, which refused every refund, is REPLACED rather
    // than left in place on a database that already has it.
    const drop = (statements as string[]).find(
        s => /DROP CONSTRAINT IF EXISTS "Expense_taxAmount_check"/.test(s),
    );
    assert.ok(drop, "the old definition is dropped first");
    assert.ok(
        (statements as string[]).indexOf(drop!) < (statements as string[]).indexOf(guard!),
        "drop before add",
    );
    assert.ok(
        normalizedMigration.includes(normalize(guard!).replace(/;$/, "")),
        "and the migration must carry the same statement",
    );
    const verified = (expectedCheckConstraints as { name: string }[]).some(
        c => c.name === "Expense_taxAmount_check",
    );
    assert.ok(verified, "and the post-run verification must assert it");
});

// ── updatedAt must survive the PRE-DEPLOY window (round 10, item 1) ────────

test("updatedAt is added WITH its default, then repaired, THEN made NOT NULL", () => {
    // Order is the whole point, and round 13 moved it. The script runs against
    // production BEFORE the build that knows about the column, so the OLD app
    // is still inserting Expenses without it. If the column arrives bare, every
    // one of those inserts lands NULL — including ones that land AFTER the
    // backfill has run — and `SET NOT NULL` then aborts. Arriving with the
    // default means no insert can produce a NULL at all.
    const sql = (statements as string[]).filter(s => s.includes('"updatedAt"'));
    assert.equal(sql.length, 4, "add-with-default, repair default, repair nulls, not-null");
    assert.match(sql[0], /ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP\(3\) DEFAULT now\(\)$/);
    assert.ok(!/NOT NULL/.test(sql[0]), "still nullable, so a repair backfill can run");
    // Repair for a database left in the OLD half-applied shape: column present
    // with no default, and NULLs from the window that shape allowed.
    assert.match(sql[1], /ALTER COLUMN "updatedAt" SET DEFAULT now\(\)/);
    assert.match(sql[2], /^UPDATE [\s\S]*SET "updatedAt" = COALESCE\("createdAt"/);
    assert.match(sql[3], /SET NOT NULL/);
    // Both repairs must precede NOT NULL, or the old-shape database still fails.
    const idx = (needle: string) => (statements as string[]).indexOf(needle);
    assert.ok(idx(sql[1]) < idx(sql[3]) && idx(sql[2]) < idx(sql[3]), "repair before NOT NULL");
});

test("every updatedAt statement is re-runnable, and matches the migration", () => {
    const sql = (statements as string[]).filter(s => s.includes('"updatedAt"'));
    // IF NOT EXISTS; two idempotent ALTERs; a predicate-bound UPDATE.
    assert.match(sql[0], /IF NOT EXISTS/);
    assert.match(sql[2], /WHERE "updatedAt" IS NULL/);
    for (const statement of sql) {
        assert.ok(
            normalizedMigration.includes(normalize(statement).replace(/;$/, "")),
            `migration.sql is missing:
  ${statement}`,
        );
    }
});

test("the DDL runs inside ONE transaction", () => {
    // A blip between the backfill and SET NOT NULL used to leave production
    // half-migrated. Postgres is transactional for DDL; there is no reason to
    // allow a partial apply.
    const script = readFileSync(
        path.join(__dirname, "..", "scripts", "apply-expense-attribution.mjs"),
        "utf8",
    );
    const run = script.slice(script.indexOf("for (const sql of [...statements"));
    assert.match(script, /await prisma\.\$transaction\(async tx =>/);
    assert.match(run, /await tx\.\$executeRawUnsafe\(sql\)/, "inside the transaction, not outside it");
    assert.ok(
        script.indexOf("$transaction(async tx =>") < script.indexOf("for (const sql of [...statements"),
        "the loop is INSIDE the transaction",
    );
});

test("taxSource is declared everywhere the other tax columns are", () => {
    // Codex round 13, item 5. A column that exists only in the migration is a
    // P2022 on production; one that exists only in the script is a fresh CI
    // database that cannot reproduce prod.
    assert.ok((statements as string[]).some(s => /ADD COLUMN IF NOT EXISTS "taxSource" TEXT/.test(s)));
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS "taxSource" TEXT/);
    assert.ok(expectedColumns.Expense.includes("taxSource"), "and it is verified after the run");
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    assert.match(schema, /taxSource\s+String\?/);
});

test("Prisma declares the same default, so the migration check sees them agree", () => {
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    assert.match(schema, /updatedAt DateTime @default\(now\(\)\) @updatedAt/);
});
