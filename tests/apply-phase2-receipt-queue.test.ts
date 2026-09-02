/**
 * The rollout script and the committed migration must describe the SAME schema.
 *
 * They are written twice on purpose — the script is what PRODUCTION gets
 * (before the deploy that selects these columns), the migration is what a fresh
 * CI/dev database gets — and nothing else in the repo notices when the two
 * drift. CI's `migrations` job would eventually catch a difference by diffing
 * against production, but only AFTER the script has been run there, which is
 * exactly the wrong time to find out.
 *
 * Importing the script must NOT open a connection or read DATABASE_URL: all of
 * that sits behind the isMainModule guard.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BANK_LINE_SOURCES_OF_RECORD, statements, targetMatches } from "../scripts/apply-phase2-receipt-queue.mjs";

const migrationSql = readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20260901120000_phase2_receipt_queue", "migration.sql"),
    "utf8",
);
const schemaPrisma = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

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

test("every statement the apply script runs is present in the committed migration", () => {
    for (const statement of statements as string[]) {
        const normalized = normalize(statement).replace(/;$/, "");
        assert.ok(
            normalizedMigration.includes(normalized),
            `migration is missing:\n  ${normalized.slice(0, 160)}`,
        );
    }
});

test("both are additive and idempotent — a re-run must change nothing", () => {
    for (const statement of statements as string[]) {
        const s = statement.trim();
        const guarded =
            /^ALTER TABLE .* ADD COLUMN IF NOT EXISTS/i.test(s)
            || /^CREATE TABLE IF NOT EXISTS/i.test(s)
            || /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/i.test(s)
            || /^DO \$\$ BEGIN\s+IF NOT EXISTS/i.test(s);
        assert.ok(guarded, `not idempotent:\n  ${s.slice(0, 120)}`);
        // Nothing here may destroy or rewrite existing data.
        assert.doesNotMatch(s, /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b|\bUPDATE\b/i);
    }
});

test("the new column carries a DEFAULT, so existing rows need no backfill UPDATE", () => {
    const addColumn = (statements as string[]).find(s => s.includes('"sourceOfRecord"'));
    assert.ok(addColumn);
    assert.match(addColumn, /NOT NULL DEFAULT 'STATEMENT'/);
    // Every BankLine that exists today WAS minted from a statement, so this
    // default is a true statement about them, not a convenient guess.
});

test("sourceOfRecord is a closed set, enforced by a CHECK Prisma cannot express", () => {
    assert.deepEqual(BANK_LINE_SOURCES_OF_RECORD, ["STATEMENT", "QBO"]);
    const check = (statements as string[]).find(s => s.includes("BankLine_sourceOfRecord_check"));
    assert.ok(check, "the CHECK must be created by the script, not left to the generator");
    for (const value of BANK_LINE_SOURCES_OF_RECORD) {
        assert.ok(check.includes(`'${value}'`), `CHECK is missing ${value}`);
    }
    assert.ok(normalizedMigration.includes("bankline_sourceofrecord_check"));
});

test("the per-day card claim is a UNIQUE index — a plain index would permit the double-post", () => {
    const claim = (statements as string[]).find(s => s.includes("ReceiptRequestCard_owner_pacificDate_key"));
    assert.ok(claim);
    assert.match(claim, /CREATE UNIQUE INDEX IF NOT EXISTS/);
    assert.match(claim, /\("owner", "pacificDate"\)/);
});

test("schema.prisma describes both additions, so the generated client matches the DDL", () => {
    assert.match(schemaPrisma, /sourceOfRecord\s+String\s+@default\("STATEMENT"\)/);
    assert.match(schemaPrisma, /model ReceiptRequestCard \{/);
    assert.match(schemaPrisma, /@@unique\(\[owner, pacificDate\]\)/);
});

test("the target guard is exact on BOTH db and host — no degenerate substring case", () => {
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.5"), true);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "10.0.0.50"), false);
    assert.equal(targetMatches({ db: "postgres", host: "10.0.0.5" }, "postgres", "1"), false);
    assert.equal(targetMatches({ db: "other", host: "10.0.0.5" }, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches(null, "postgres", "10.0.0.5"), false);
    assert.equal(targetMatches({ db: "postgres" }, "postgres", ""), true);
});

test("column verification checks type, nullability and default — not just names", () => {
    // A name-only check passes against a column of the wrong type, and against
    // a NOT NULL column added to a populated table with no default (where the
    // DDL succeeds and every later INSERT fails at runtime instead).
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-phase2-receipt-queue.mjs"), "utf8");
    assert.match(source, /data_type, is_nullable, column_default/);
    assert.match(source, /actual\.data_type !== column\.type/);
    assert.match(source, /is_nullable === "YES"/);
    assert.match(source, /column_default/);
});

test("the round-2 columns are in the script, the migration AND schema.prisma", async t => {
    const cases: Array<[string, string, RegExp]> = [
        ["ReceiptRequestCard.claimedAt", '"claimedAt" TIMESTAMP(3)', /claimedAt\s+DateTime\?/],
        ["ReceiptRequestCard.claimToken", '"claimToken" TEXT', /claimToken\s+String\?/],
        ["ReceiptIntake.postVoidQbPurchaseId", '"postVoidQbPurchaseId" TEXT', /postVoidQbPurchaseId\s+String\?/],
    ];
    for (const [label, ddl, prismaField] of cases) {
        await t.test(label, () => {
            assert.ok((statements as string[]).some(s => s.includes(ddl)), `apply script missing ${ddl}`);
            assert.ok(normalize(migrationSql).includes(normalize(ddl)), `migration missing ${ddl}`);
            assert.match(schemaPrisma, prismaField, `schema.prisma missing ${label}`);
        });
    }
});

test("the three-column BankLine index exists in all three places", () => {
    // Declared in schema.prisma too, or `prisma migrate diff` proposes creating
    // it on every future run and the committed migrations stop being TRUE.
    assert.ok((statements as string[]).some(s => s.includes("BankLine_account_postedDate_amountCents_idx")));
    assert.ok(normalizedMigration.includes("bankline_account_posteddate_amountcents_idx"));
    assert.match(schemaPrisma, /@@index\(\[account, postedDate, amountCents\]\)/);
});
