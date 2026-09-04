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
import {
    BANK_LINE_SOURCES_OF_RECORD,
    PROD_BASELINE_MIGRATION,
    PROD_ENV_FILE,
    PROJECT_REF_ENV,
    expectedColumns,
    isProductionPoolerHost,
    projectRefFromUrl,
    redactTarget,
    resolveDatabaseUrl,
    resolveProdDatabaseUrl,
    statements,
    targetHostMatches,
    targetMatches,
} from "../scripts/apply-phase2-receipt-queue.mjs";

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
            || (/^INSERT INTO /i.test(s) && /ON CONFLICT (?:\([^)]*\) )?DO NOTHING$/i.test(s) && /md5\(/i.test(s))
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

/**
 * THE HOST CHECK COMPARED AN ADDRESS TO A NAME, SO IT COULD NEVER PASS.
 *
 * `host(inet_server_addr())` answers with the server's own IP — through the
 * Supabase pooler an IPv6 literal — while --expect-host is the hostname out of
 * DATABASE_URL. The sibling apply script printed exactly that refusal against
 * production. Every case below injects its resolver, so no test touches DNS.
 */
const POOLER_HOST = "aws-0-us-west-2.pooler.supabase.com";
const POOLER_V6 = "2600:1f13:838:6e45:7ee0:268:15b9:d263";
const neverResolves = async () => {
    throw new Error("the resolver must not be called for this case");
};

test("pre-fix control: the exact comparison refuses the production pooler outright", () => {
    // This IS the bug, asserted directly, and it is deliberately still true:
    // targetMatches stays exact, and the fix is a second DNS-aware check rather
    // than a loosening of this one.
    assert.equal(targetMatches({ db: "postgres", host: POOLER_V6 }, "postgres", POOLER_HOST), false);
});

test("the host check resolves --expect-host and requires the connected address to be in that set", async t => {
    const resolvesTo = (...addresses: string[]) => async (hostname: string) => {
        assert.equal(hostname, POOLER_HOST);
        return addresses;
    };

    await t.test("a hostname that resolves to the connected IPv6 is accepted", async () => {
        assert.equal(await targetHostMatches(POOLER_V6, POOLER_HOST, resolvesTo("52.32.178.7", POOLER_V6)), "dns");
    });

    await t.test("an IPv4-mapped answer is the same address written differently", async () => {
        assert.equal(await targetHostMatches("::ffff:52.32.178.7", POOLER_HOST, resolvesTo("52.32.178.7")), "dns");
    });

    await t.test("an address outside the resolved set is REFUSED", async () => {
        assert.equal(await targetHostMatches("203.0.113.9", POOLER_HOST, resolvesTo("52.32.178.7", POOLER_V6)), null);
    });

    await t.test("an expected literal address needs no lookup at all", async () => {
        assert.equal(await targetHostMatches(POOLER_V6, POOLER_V6, neverResolves), "exact");
        assert.equal(await targetHostMatches("127.0.0.1", "127.0.0.1", neverResolves), "exact");
    });

    await t.test("localhost is loopback by definition — the CI driver's case", async () => {
        assert.equal(await targetHostMatches("127.0.0.1", "localhost", neverResolves), "loopback");
        assert.equal(await targetHostMatches("::1", "localhost", neverResolves), "loopback");
        assert.equal(await targetHostMatches("10.0.0.5", "localhost", neverResolves), null);
    });

    await t.test("no address at all (Unix socket) falls back to the URL's own hostname", async () => {
        assert.equal(await targetHostMatches("", POOLER_HOST, neverResolves, POOLER_HOST), "unix-socket");
        // ...and that fallback may never rescue a host the URL disagrees with,
        // nor a connection that DID report an address.
        assert.equal(await targetHostMatches("", POOLER_HOST, neverResolves, "db.example.com"), null);
        assert.equal(await targetHostMatches("", POOLER_HOST, neverResolves), null);
    });

    await t.test("an empty --expect-host matches nothing", async () => {
        assert.equal(await targetHostMatches("10.0.0.5", "", neverResolves), null);
        assert.equal(await targetHostMatches("", "", neverResolves, ""), null);
    });
});

test("the live path uses the DNS-aware check and keeps the db name exact", () => {
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-phase2-receipt-queue.mjs"), "utf8");
    assert.match(source, /await targetHostMatches\(actual\.host, expectHost, lookupAddresses, urlHostname\)/);
    assert.match(source, /String\(actual\.db \?\? ""\) !== String\(expectDb \?\? ""\)/);
    // A falsy return is the refusal — the exit must not be conditional on a label.
    assert.match(source, /if \(!hostMatch\) \{[\s\S]{0,400}?process\.exit\(1\);/);
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

// ── The script must PROVE which database it targets ────────────────────────

test("the production URL comes from the production file, never the environment", () => {
    /**
     * Codex cross-PR finding (found on P5). Reading `process.env.DATABASE_URL`
     * first let a developer with a local database exported in their shell run
     * this script, watch every statement report "ok", and merge believing
     * production had been migrated. The output was identical either way, which
     * is what made it silent.
     */
    const files: Record<string, string> = {
        [PROD_ENV_FILE]: 'DATABASE_URL="postgresql://u:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true"\n',
    };
    const resolved = resolveProdDatabaseUrl(
        (path: string) => files[path],
        (path: string) => path in files,
    );
    assert.equal(resolved.from, PROD_ENV_FILE);
    assert.match(resolved.url, /pooler\.supabase\.com/);

    // PRE-FIX CONTROL: the old resolver prefers whatever is in the environment,
    // which is exactly the local database the finding is about.
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/probuild_dev";
    try {
        assert.equal(resolveDatabaseUrl().from, "process.env.DATABASE_URL",
            "the old path would have connected to localhost and reported success");
    } finally {
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
    }
});

test("a missing production env file refuses, and says how to get one", () => {
    assert.throws(
        () => resolveProdDatabaseUrl(() => "", () => false),
        /vercel env pull .*--environment=production/,
    );
});

test("the target line carries NO credentials", () => {
    const line = redactTarget("postgresql://someuser:sup3rsecret@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true");
    assert.equal(line, "host=aws-0-us-west-2.pooler.supabase.com port=6543 db=postgres");
    // Not "masked" — absent. `maskUrl` still prints the username and the whole
    // query string, either of which can carry a credential.
    for (const secret of ["someuser", "sup3rsecret", "pgbouncer"]) {
        assert.equal(line.includes(secret), false, `${secret} must not reach the terminal`);
    }
    assert.doesNotThrow(() => redactTarget("not a url"));
    assert.match(redactTarget("not a url"), /unparseable/);
});

test("only the production pooler host is accepted", () => {
    assert.equal(isProductionPoolerHost("aws-0-us-west-2.pooler.supabase.com"), true);
    assert.equal(isProductionPoolerHost("localhost"), false);
    assert.equal(isProductionPoolerHost("db.ghzdbzdnwjxazvmcefbh.supabase.co"), false, "the direct host is not the pooler");
    // A host that merely CONTAINS the pooler name must not pass.
    assert.equal(isProductionPoolerHost("pooler.supabase.com.evil.test"), false);
    assert.equal(isProductionPoolerHost(""), false);
    assert.equal(isProductionPoolerHost(undefined), false);
});

test("the script refuses before any DDL when the target is not named", () => {
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-phase2-receipt-queue.mjs"), "utf8");

    // `--target prod` is checked FIRST, before --yes and before anything opens
    // a connection — a refusal that happens after the first statement is not a
    // refusal.
    const targetAt = source.indexOf('if (target !== "prod" && target !== "ci") {');
    const clientAt = source.indexOf("new PrismaClient(");
    const firstStatementAt = source.indexOf("for (const sql of statements) {");
    assert.ok(targetAt > 0 && clientAt > targetAt && firstStatementAt > clientAt,
        "target check, then connect, then write");

    // Flags are read inside main(), so importing the module still does nothing
    // (CLAUDE.md: importing an apply script once executed it against prod).
    const mainAt = source.indexOf("async function main() {");
    assert.ok(mainAt > 0 && source.indexOf('readFlagValue("--target")') > mainAt);

    // The ambient variable is ignored, and the run says so rather than
    // silently preferring one or the other.
    assert.match(source, /an ambient DATABASE_URL is set and is being IGNORED/);
    assert.match(source, /: resolveProdDatabaseUrl\(\);/,
        "the production path takes the file, and only CI takes the ambient URL");
    assert.doesNotMatch(source, /const \{ url, from \} = resolveDatabaseUrl\(\);/);

    // And the database must itself agree it is production.
    assert.match(source, /PROD_BASELINE_MIGRATION/);
    assert.equal(PROD_BASELINE_MIGRATION, "20260814000000_baseline_production");
    const baselineAt = source.indexOf('FROM "_prisma_migrations" WHERE "migration_name" = $1');
    assert.ok(baselineAt > clientAt && baselineAt < firstStatementAt,
        "the baseline check runs after connecting and before the first write");
});

test("the project ref, not the host, is what identifies production", () => {
    /**
     * Codex cross-PR addendum. Supabase pooler hosts are shared regionally, so
     * `aws-0-us-west-2.pooler.supabase.com` + `current_database() = "postgres"`
     * + a baseline migration row describes production AND every migrated
     * staging clone in the same region equally well. The project ref lives in
     * the URL username.
     */
    const prod = "postgresql://postgres.ghzdbzdnwjxazvmcefbh:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
    const staging = "postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres";

    assert.equal(projectRefFromUrl(prod), "ghzdbzdnwjxazvmcefbh");
    assert.equal(projectRefFromUrl(staging), "abcdefghijklmnop");
    assert.notEqual(projectRefFromUrl(prod), projectRefFromUrl(staging),
        "same host, same database name, same baseline — different project");

    // A username that is not `postgres.<ref>` refuses rather than guessing.
    assert.equal(projectRefFromUrl("postgresql://postgres:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres"), null);
    assert.equal(projectRefFromUrl("postgresql://someoneelse:pw@host:5432/postgres"), null);
    assert.equal(projectRefFromUrl("not a url"), null);
});

test("an unset expected project ref is a refusal, not a default", () => {
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-phase2-receipt-queue.mjs"), "utf8");

    // Exactly this env name, so all five apply scripts share one setting.
    assert.equal(PROJECT_REF_ENV, "APPLY_EXPECT_PROJECT_REF");
    assert.match(source, /const expectedRef = ciMode \? null : process\.env\[PROJECT_REF_ENV\];/);
    assert.match(source, /if \(!ciMode && !expectedRef\) \{[\s\S]{0,400}?process\.exit\(1\);/,
        "unset must refuse — defaulting to whatever we connected to is the bug");
    assert.match(source, /if \(!ciMode && projectRef !== expectedRef\) \{/);

    // `--target ci` exists so main() is actually exercised, and it is fenced
    // off from production rather than trusted: it refuses a Supabase host
    // outright, so the production guard cannot be satisfied by that path.
    assert.match(source, /const ciMode = target === "ci";/);
    // The CONDITION, not just the message: a message string survives having
    // its `if` neutered, and that mutation is how CI mode would silently
    // become a second unguarded route to production.
    assert.match(source, /if \(\/supabase\\.\(co\|com\)\/i\.test\(url\)\) \{/);
    assert.match(source, /REFUSING: --target ci must never point at Supabase\./);
    assert.match(source, /REFUSING: --target ci needs DATABASE_URL set to the throwaway database\./);

    // The ref is printed, so a human reading the log can see which project.
    assert.match(source, /console\.log\(`TARGET project ref: \$\{projectRef \?\? "\(unparseable\)"\}`\);/);

    // And it is checked BEFORE the first statement, like every other refusal.
    const refCheckAt = source.indexOf("if (!ciMode && projectRef !== expectedRef) {");
    const firstStatementAt = source.indexOf("for (const sql of statements) {");
    assert.ok(refCheckAt > 0 && firstStatementAt > refCheckAt);
});

test("the REAL production pooler URL passes the host guard, port and all", () => {
    /**
     * Codex found this on P0: `new URL(url).host` INCLUDES the port, so a
     * `/pooler\.supabase\.com$/` test against `host` can never match the real
     * transaction-pooler URL — the guard rejects production itself, and
     * `--target prod` is never exercised. This script uses `hostname`; the
     * assertion below is what keeps it that way.
     */
    const PROD = "postgresql://postgres.ghzdbzdnwjxazvmcefbh:s3cret@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true";

    assert.equal(new URL(PROD).host, "aws-0-us-west-2.pooler.supabase.com:6543", "host carries the port");
    assert.equal(isProductionPoolerHost(new URL(PROD).host), false,
        "which is exactly why `host` cannot be the thing checked");
    assert.equal(isProductionPoolerHost(new URL(PROD).hostname), true, "hostname is");

    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-phase2-receipt-queue.mjs"), "utf8");
    assert.match(source, /isProductionPoolerHost\(new URL\(url\)\.hostname\)/);
    assert.doesNotMatch(source, /isProductionPoolerHost\(new URL\(url\)\.host\)/);

    // And the whole identity check agrees for the real URL: right ref passes,
    // wrong ref refuses.
    assert.equal(projectRefFromUrl(PROD), "ghzdbzdnwjxazvmcefbh");
    const matches = (expected: string) =>
        isProductionPoolerHost(new URL(PROD).hostname) && projectRefFromUrl(PROD) === expected;
    assert.equal(matches("ghzdbzdnwjxazvmcefbh"), true, "the real production URL is accepted");
    assert.equal(matches("someotherprojectref00"), false, "a different project is refused");
});

test("the index verifier reads the CATALOG, not the rendered definition", () => {
    /**
     * `pg_get_indexdef` quotes an identifier only when it HAS to, so the real
     * rendering is `(owner, "pacificDate")` — and every regex that pinned the
     * quoted form could never match. The verifier refused a perfectly correct
     * index, and no unit test could see it: they read the statement list as
     * text. The end-to-end CI driver caught it on its first real run against
     * Postgres (run 33793141835).
     *
     * The fix is not a better regex. It is to stop comparing text at all.
     */
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-phase2-receipt-queue.mjs"), "utf8");

    assert.doesNotMatch(source, /mustMatch/, "no pattern matching over indexdef survives");
    assert.doesNotMatch(source, /pg_indexes/, "nor the view that renders it");

    // The catalog, and the three properties that carry the invariant.
    assert.match(source, /i\.indisunique AS "unique"/);
    assert.match(source, /\(i\.indpred IS NOT NULL\) AS "partial"/);
    assert.match(source, /unnest\(i\.indkey\) WITH ORDINALITY/);
    assert.match(source, /ORDER BY k\.ord/, "column ORDER is part of the identity");

    // AND THE COMPARISON ACTUALLY COMPARES. Reading the catalog is worthless if
    // the check then ignores what came back — each of these survived being
    // replaced with `true` until it was pinned here.
    assert.match(source, /&& actual\.unique === expected\.unique/);
    assert.match(source, /&& actual\.partial === expected\.partial/);
    assert.match(source, /const same = actual\.table === expected\.table/);
    assert.match(source, /&& actual\.columns\.length === expected\.columns\.length/);
    assert.match(source, /&& actual\.columns\.every\(\(column, at\) => column === expected\.columns\[at\]\);/);

    // Every index it verifies declares its table, its ordered columns, and
    // whether it may be partial.
    const entries = [...source.matchAll(/name: "([A-Za-z_]+_key)",[\s]*table: "(\w+)",[\s]*columns: \[([^\]]*)\],[\s]*partial: (true|false),/g)];
    assert.equal(entries.length, 5, "five unique indexes are verified");
    const byName = Object.fromEntries(entries.map(m => [m[1], { table: m[2], columns: m[3], partial: m[4] }]));

    assert.deepEqual(byName.ReceiptRequestCard_owner_pacificDate_key,
        { table: "ReceiptRequestCard", columns: '"owner", "pacificDate"', partial: "false" });
    assert.deepEqual(byName.ReceiptRequestCard_owner_deliveredOn_key,
        { table: "ReceiptRequestCard", columns: '"owner", "deliveredOn"', partial: "false" });
    assert.deepEqual(byName.ReceiptRequestCardDelivery_owner_deliveryDay_key,
        { table: "ReceiptRequestCardDelivery", columns: '"owner", "deliveryDay"', partial: "false" });
    assert.deepEqual(byName.ReceiptMemoArtifact_pdfId_key,
        { table: "ReceiptMemoArtifact", columns: '"pdfId"', partial: "false" });
    assert.deepEqual(byName.ReceiptMemoArtifact_targetType_targetKey_key,
        { table: "ReceiptMemoArtifact", columns: '"targetType", "targetKey"', partial: "false" });

    // PRE-FIX CONTROL: the pattern that used to be checked cannot match what
    // Postgres actually renders, which is exactly how that CI run failed.
    const rendered = 'CREATE UNIQUE INDEX "ReceiptRequestCard_owner_pacificDate_key" '
        + 'ON public."ReceiptRequestCard" USING btree (owner, "pacificDate")';
    assert.equal(/\("owner", "pacificDate"\)/.test(rendered), false);
});
