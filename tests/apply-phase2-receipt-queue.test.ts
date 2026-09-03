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
import { BANK_LINE_SOURCES_OF_RECORD, expectedColumns, statements, targetMatches } from "../scripts/apply-phase2-receipt-queue.mjs";

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

/**
 * The ONE row rewrite this script is allowed to carry, recognised by shape.
 *
 * A repair UPDATE is idempotent when its WHERE clause is the very thing the
 * update removes: this one selects `memo-signed` issues with no artifact of their
 * own and rewrites that resolution to `memo-conflict`, so a second run's WHERE
 * matches nothing. Both halves are required — the selecting predicate and the
 * rewrite that extinguishes it — because either one alone is a statement that
 * would run forever.
 */
function memoQuarantine(s: string): boolean {
    return /^UPDATE "ReviewIssue"/i.test(s.trim())
        && /= 'memo-signed'/.test(s)
        && /NOT EXISTS/i.test(s)
        && /"resolution":"memo-conflict"/.test(s);
}

test("both are additive and idempotent — a re-run must change nothing", () => {
    for (const statement of statements as string[]) {
        const s = statement.trim();
        const guarded =
            /^ALTER TABLE .* ADD COLUMN IF NOT EXISTS/i.test(s)
            || /^CREATE TABLE IF NOT EXISTS/i.test(s)
            || /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/i.test(s)
            || /^DO \$\$ BEGIN\s+IF NOT EXISTS/i.test(s)
            // The CONSTRAINT CONVERGENCE shape: read the current definition,
            // add it when absent, replace it when it differs. Idempotent by
            // COMPARISON rather than by name — which is the point, because a
            // by-name guard lets a stale definition survive every re-run while
            // reporting "ok".
            || /^DO \$\$\s+DECLARE current_def text;\s+BEGIN\s+SELECT pg_get_constraintdef/i.test(s)
            // ENABLE ROW LEVEL SECURITY is idempotent by definition: enabling
            // it twice is the same as enabling it once, and it touches no row.
            || /^ALTER TABLE .* ENABLE ROW LEVEL SECURITY$/i.test(s)
            // A BACKFILL is idempotent when its primary key is DERIVED from the
            // data it reads and the insert is ON CONFLICT DO NOTHING: a re-run
            // computes the same ids and writes nothing. A backfill keyed on a
            // fresh cuid would insert a duplicate on every run while reporting
            // "ok", which is the same silent-drift failure the constraint
            // convergence above exists to avoid.
            || (/^INSERT INTO /i.test(s) && /ON CONFLICT DO NOTHING$/i.test(s) && /md5\(/i.test(s))
            // A REPAIR UPDATE is idempotent when its WHERE clause is the very
            // thing the update removes. The memo quarantine (round-36 gate,
            // finding 3) selects `memo-signed` issues with no artifact of their
            // own and rewrites that resolution to `memo-conflict`, so the second
            // run's WHERE matches nothing. Asserted as a SHAPE — the selecting
            // predicate AND the rewrite that extinguishes it — because either
            // one alone is a statement that would run forever.
            || memoQuarantine(s);
        assert.ok(guarded, `not idempotent:\n  ${s.slice(0, 120)}`);
        // NOTHING HERE MAY DESTROY DATA. A constraint is not data: dropping one
        // to re-add it with the right definition changes no row, and is the only
        // way to converge a stale check.
        assert.doesNotMatch(s, /\bDROP\s+(?:TABLE|COLUMN|INDEX|SCHEMA|DATABASE)\b/i);
        assert.doesNotMatch(s, /\bTRUNCATE\b|\bDELETE FROM\b/i);
        // AND EXACTLY ONE REWRITE IS ALLOWED: the memo quarantine (round-36
        // gate, finding 3), which repairs rows the script's own backfill could
        // not bind. It is carved out by SHAPE and then held to the four columns
        // that repair needs — a carve-out for "UPDATE" as a keyword would let
        // the next migration rewrite anything it liked.
        if (/\bUPDATE\s+"/i.test(s)) {
            assert.ok(memoQuarantine(s), "the memo quarantine is the ONLY row rewrite this script may carry");
            const columns = [...s.matchAll(/^\s*(?:SET\s+)?"([A-Za-z]+)"\s*=/gm)].map(m => m[1]).sort();
            assert.deepEqual(
                columns,
                ["clearedAt", "displayDetails", "updatedAt", "version"],
                "the repair may touch the resolution, the reopen, the audit stamp and the version — nothing else",
            );
        }
        if (/\bDROP CONSTRAINT\b/i.test(s)) {
            const name = /DROP CONSTRAINT "([^"]+)"/.exec(s)?.[1];
            assert.ok(name, "a constraint drop must name the constraint");
            assert.match(
                s,
                new RegExp(`ADD CONSTRAINT "${name}"`),
                "a constraint may only be dropped as part of replacing it",
            );
        }
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

test("BankLineObservation.clearedStatus is in the script, the migration AND schema.prisma", () => {
    // Codex PR #443 gate, finding 1: the mint gate reads this column, so the
    // apply script (prod) and the migration (CI's replayed database) must agree
    // — a drift here is green CI over a production the client cannot query.
    const ddl = 'ALTER TABLE "BankLineObservation" ADD COLUMN IF NOT EXISTS "clearedStatus" TEXT';
    assert.ok((statements as string[]).some(s => normalize(s) === normalize(ddl)), "the apply script");
    assert.ok(normalizedMigration.includes(normalize(ddl)), "and the committed migration");
    assert.match(schemaPrisma, /clearedStatus String\?/, "and schema.prisma");
});

test("clearedStatus is verified NULLABLE and DEFAULTLESS, because NULL means 'never asked'", () => {
    // The script does not just run DDL — it reads information_schema back. A
    // DEFAULT of 'Uncleared' would be a claim QuickBooks never made, and a NOT
    // NULL would force one onto every row written before the column existed.
    const table = (expectedColumns as Record<string, Array<{ name: string; type: string; nullable: boolean; default: string | null }>>).BankLineObservation;
    const column = table?.find(c => c.name === "clearedStatus");
    assert.ok(column, "clearedStatus must be verified, not just created");
    assert.equal(column.type, "text");
    assert.equal(column.nullable, true, "NULL is 'nobody has asked', which is not 'uncleared'");
    assert.equal(column.default, null, "there is no truthful backfill for a question never put");
});

test("the three-column BankLine index exists in all three places", () => {
    // Declared in schema.prisma too, or `prisma migrate diff` proposes creating
    // it on every future run and the committed migrations stop being TRUE.
    assert.ok((statements as string[]).some(s => s.includes("BankLine_account_postedDate_amountCents_idx")));
    assert.ok(normalizedMigration.includes("bankline_account_posteddate_amountcents_idx"));
    assert.match(schemaPrisma, /@@index\(\[account, postedDate, amountCents\]\)/);
});

test("overflowExact ships with a TRUE default, so old cards keep their meaning", () => {
    // Every card written before the column existed came from a completed scan,
    // so `true` is the truthful backfill — and a DEFAULT means no UPDATE pass.
    const wanted = normalize(
        `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "overflowExact" BOOLEAN NOT NULL DEFAULT true`,
    );
    assert.ok(statements.some(s => normalize(s) === wanted), "the apply script adds it");
    assert.ok(normalizedMigration.includes(wanted), "and so does the committed migration");
    // Prisma has to agree, or the client selects a column the DB may not have.
    assert.match(schemaPrisma, /overflowExact Boolean @default\(true\)/);
});

test("the verifier checks overflowExact's type, nullability AND default", () => {
    // The script does not just run DDL — it reads information_schema back and
    // refuses if the shape is wrong. A column missing from that list is applied
    // and then never checked, which is how a NULLABLE or defaultless variant
    // could reach production and read as verified.
    const card = (expectedColumns as Record<string, Array<{ name: string; type: string; nullable: boolean; default: string | null }>>).ReceiptRequestCard;
    const column = card.find(c => c.name === "overflowExact");
    assert.ok(column, "overflowExact must be verified, not just created");
    assert.equal(column.type, "boolean");
    assert.equal(column.nullable, false, "a third state would be one nothing knows how to render");
    assert.equal(column.default, "true", "old cards came from a completed scan, so true is the truthful backfill");

    // And the DDL that creates it says exactly the same thing, in both paths.
    const wanted = normalize(
        `ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "overflowExact" BOOLEAN NOT NULL DEFAULT true`,
    );
    assert.ok(statements.some(s => normalize(s) === wanted), "the apply script");
    assert.ok(normalizedMigration.includes(wanted), "and the committed migration");

    // Every column the script CREATES on this table is verified — no gaps.
    const created = [...new Set(
        statements
            .filter(s => /ALTER TABLE "ReceiptRequestCard" ADD COLUMN/.test(s))
            .map(s => /ADD COLUMN IF NOT EXISTS "([^"]+)"/.exec(s)?.[1])
            .filter((name): name is string => !!name),
    )];
    for (const name of created) {
        assert.ok(card.some(c => c.name === name), `${name} is created but never verified`);
    }
});

// ── The memo-artifact table (Codex PR #443 gate round 34, finding 1) ─────────

test("the memo binding's two invariants are UNIQUE indexes, in both paths", () => {
    // Neither is an optimisation. `pdfId` unique means one signed affidavit
    // answers ONE charge; (targetType, targetKey) unique means a charge is bound
    // to ONE memo, immutably. A non-unique index for either would leave the
    // route's own in-transaction checks as the only thing between a replayed
    // memo and a second silently-closed chase — which is exactly the state that
    // shipped, because the record it checked was a rewritable TEXT blob.
    for (const ddl of [
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_pdfId_key" ON "ReceiptMemoArtifact"("pdfId")`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_targetType_targetKey_key" ON "ReceiptMemoArtifact"("targetType", "targetKey")`,
    ]) {
        const wanted = normalize(ddl);
        assert.ok(statements.some(s => normalize(s) === wanted), `the apply script is missing ${wanted.slice(0, 60)}`);
        assert.ok(normalizedMigration.includes(wanted), `the committed migration is missing ${wanted.slice(0, 60)}`);
    }
    // And Prisma declares the same two, so a fresh client cannot query a shape
    // the database does not enforce.
    const model = schemaPrisma.slice(schemaPrisma.indexOf("model ReceiptMemoArtifact"));
    const body = model.slice(0, model.indexOf("\n}"));
    assert.match(body, /pdfId\s+String\s+@unique/);
    assert.match(body, /@@unique\(\[targetType, targetKey\]\)/);
});

test("the backfill records bindings that predate the table, and re-runs to nothing", () => {
    // Without it, every memo signed before this table existed reads as UNBOUND:
    // the first replay of one would find an empty table and close a second
    // charge — the exact bug, reintroduced by the fix for it.
    const backfill = (statements as string[]).find(s => /INSERT INTO "ReceiptMemoArtifact"/.test(s));
    assert.ok(backfill, "the migration must carry the evidence that already exists forward");
    assert.match(backfill, /ON CONFLICT DO NOTHING/, "a re-run must write nothing");
    assert.match(backfill, /'rma_' \|\| md5\(parsed\."pdfId"\)/, "the id is DERIVED, so the re-run computes the same row");
    // Read by REGEX, not by a jsonb cast: displayDetails is TEXT and one
    // malformed row would abort the whole script.
    assert.match(backfill, /substring\(i\."displayDetails" from/);
    assert.doesNotMatch(backfill, /::jsonb/, "a jsonb cast would take the rollout down on a single bad row");
    assert.match(backfill, /parsed\."resolution" = 'memo-signed'/, "only a memo resolution is a memo binding");
    assert.match(backfill, /ORDER BY/, "deterministic residue where the pre-fix bug already duplicated a pdfId");
    assert.ok(normalizedMigration.includes(normalize(backfill)), "and the committed migration does the same");
});

test("the losing side of a duplicated memo is REOPENED, not left closed on evidence it does not have", () => {
    // The backfill binds the oldest claimant and `ON CONFLICT DO NOTHING` walks
    // away from the rest — so without this the loser keeps a `memo-signed`
    // resolution with no artifact, and `hasResolution` alone holds that chase
    // closed forever on a memo that answered a different charge.
    const repair = (statements as string[]).find(s => /^UPDATE "ReviewIssue"/i.test(s.trim()));
    assert.ok(repair, "the migration must reopen the issues its own backfill could not bind");
    assert.match(repair, /NOT EXISTS[\s\S]*"ReceiptMemoArtifact"[\s\S]*a\."issueId" = i\."id"/,
        "the binding has to be THIS issue's — an artifact for another charge is what caused this");
    assert.match(repair, /a\."pdfId" IS NOT DISTINCT FROM/,
        "and THIS pdfId, so a stale binding cannot vouch for a different memo");
    assert.match(repair, /"clearedAt" = NULL/, "reopened, or nobody is ever asked again");
    assert.match(repair, /"version" = i\."version" \+ 1/, "so an in-flight optimistic write loses instead of clobbering the repair");
    assert.match(repair, /"resolution":"memo-conflict"/, "quarantined under a resolution hasResolution does not honour");
    assert.doesNotMatch(repair, /::jsonb/, "a jsonb cast would take the rollout down on a single bad row");
    assert.ok(normalizedMigration.includes(normalize(repair)), "and the committed migration does the same");
});

test("the artifact table is verified by shape and carries RLS, like every other sensitive table here", () => {
    const columns = (expectedColumns as Record<string, Array<{ name: string; nullable: boolean }>>).ReceiptMemoArtifact;
    assert.ok(columns, "a table the script creates and never verifies is a table nobody checked");
    for (const column of columns) {
        assert.equal(column.nullable, false, `${column.name} must be NOT NULL — a half-written binding enforces nothing`);
    }
    assert.deepEqual(
        columns.map(c => c.name).sort(),
        ["createdAt", "id", "issueId", "pdfId", "targetKey", "targetType"],
    );
    const rls = `ALTER TABLE "ReceiptMemoArtifact" ENABLE ROW LEVEL SECURITY`;
    assert.ok(statements.some(s => normalize(s) === normalize(rls)));
    assert.ok(normalizedMigration.includes(normalize(rls)));
});
