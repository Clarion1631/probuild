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
import {
    RECEIPT_BUCKET,
    RECEIPT_BUCKET_FILE_SIZE_LIMIT,
    RECEIPT_BUCKET_MIME_TYPES,
    RECEIPT_INTAKE_STATES,
    CONSTRAINT_LOOKUP_SQL,
    columnDefaultMatches,
    ensureReceiptBucket,
    verifyColumnDefaults,
    expectedConstraints,
    foreignKeyDrift,
    maskUrl,
    parseSizeLimit,
    expectedColumns,
    statements,
    targetMatches,
    verifyConstraints,
    chooseTarget,
    hostOf,
    PROD_BASELINE_MIGRATION,
    PROD_ENV_FILE,
    PROD_POOLER_HOST_SUFFIX,
    resolveTargetUrl,
    targetLine,
    verifyProdIdentity,
    looksLikeSupabase,
    projectRefOf,
    PROJECT_REF_ENV,
} from "../scripts/apply-receipt-intake.mjs";
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

/**
 * The CHECK constraint's actual SEMANTICS: the ordered state list, and whether
 * the block converges (replaces a stale definition) or merely creates.
 *
 * Token-presence — "does this file mention 'BOOKED' somewhere" — passed happily
 * while the two files did DIFFERENT things with the constraint they both
 * mention, which is exactly how they drifted.
 */
function checkSemantics(sql: string) {
    const body = sql.slice(sql.indexOf("ReceiptIntake_state_check"));
    return {
        states: Array.from(body.matchAll(/'([A-Z_]{4,})'/g), m => m[1])
            .filter(token => (RECEIPT_INTAKE_STATES as string[]).includes(token)),
        converges: /DROP CONSTRAINT "ReceiptIntake_state_check"/.test(body)
            && /IS DISTINCT FROM wanted_def/.test(body),
        scoped: /conrelid = '"ReceiptIntake"'::regclass/.test(body),
    };
}

test("both files declare the SAME closed state set, and it matches the runtime one", () => {
    // A state the CHECK constraint rejects but the code can produce is a
    // guaranteed 500 on a document nobody can then see.
    assert.deepEqual([...RUNTIME_STATES].sort(), [...RECEIPT_INTAKE_STATES].sort());
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"));
    assert.ok(check, "the script must add the state CHECK constraint");

    const fromScript = checkSemantics(check!);
    const fromMigration = checkSemantics(migrationSql);

    // SEMANTIC PARITY, not "both mention the word".
    assert.deepEqual(fromScript.states, fromMigration.states, "the same states, in the same order");
    assert.deepEqual(
        [...new Set(fromScript.states)].sort(),
        [...RECEIPT_INTAKE_STATES].sort(),
        "and it is the whole closed set",
    );
});

test("BOTH paths converge on the wanted definition; neither only creates-if-absent", () => {
    // A database that already carried an older state list kept it forever under
    // "create only when absent", while the apply script corrected it in
    // production — the same repo describing two different tables depending on
    // which path built them.
    const check = statements.find((s: string) => s.includes("ReceiptIntake_state_check"))!;
    for (const [label, semantics] of [
        ["apply script", checkSemantics(check)],
        ["migration.sql", checkSemantics(migrationSql)],
    ] as const) {
        assert.equal(semantics.converges, true, `${label} replaces a stale definition`);
        assert.equal(semantics.scoped, true, `${label} scopes the lookup to this table`);
    }
    // And they agree on WHAT the wanted definition is, character for character:
    // this string is compared against pg_get_constraintdef, so a single
    // character of difference means one path replaces the constraint on every
    // run while the other leaves it alone.
    const wanted = (sql: string) => /wanted_def\s+TEXT\s*:=\s*('(?:[^']|'')*')/.exec(sql)?.[1] ?? null;
    assert.ok(wanted(check), "the apply script declares a wanted definition");
    assert.equal(wanted(check), wanted(migrationSql));
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
            // SET DEFAULT is idempotent by nature: setting a default that is
            // already in place is a no-op, and there is no IF NOT EXISTS form
            // of it to write. It repairs a table an earlier revision created
            // with the wrong one.
            /ALTER TABLE .* ALTER COLUMN .* SET DEFAULT/.test(sql) ||
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

test("uploadLeaseNonce is created, ALTERed, and verified in all three places", () => {
    // The adoption generation /start's discard CAS pins. A column that reached
    // only the CREATE would never land on a database where the rollout script
    // had already run once, and the CAS would then fence on a column that does
    // not exist.
    const createTable = statements.find((x: string) => x.includes('CREATE TABLE IF NOT EXISTS "ReceiptIntake"'));
    assert.match(createTable!, /"uploadLeaseNonce"\s+TEXT/);
    assert.ok(
        statements.some((x: string) => /ADD COLUMN IF NOT EXISTS "uploadLeaseNonce" TEXT/.test(x)),
        'the apply script must ALTER as well as CREATE',
    );
    assert.match(migrationSql, /ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadLeaseNonce" TEXT/);
    // NULLABLE on purpose: rows written before this column existed carry null,
    // and /start stamps a value on every lease it issues from here on.
    assert.ok(!/"uploadLeaseNonce"[^,]*NOT NULL/.test(createTable!));
    assert.ok(expectedColumns.ReceiptIntake.includes('uploadLeaseNonce'), 'and verification must look for it');
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
    assert.match(CONSTRAINT_LOOKUP_SQL, /pg_get_constraintdef\(oid\) AS def/, "verify reads the definition");
    const source = readFileSync(path.join(__dirname, "..", "scripts", "apply-receipt-intake.mjs"), "utf8");
    assert.match(source, /does not allow/, "and fails loudly naming what is missing");
});

// ── A NAME IS NOT A CONSTRAINT (round-33 item 5) ───────────────────────────

/**
 * A `pg_constraint` catalog that honours the scope in the SQL it is handed.
 *
 * `pg_constraint` is database-wide, so a lookup by `conname` alone is satisfied
 * by a constraint of that name on ANY relation. This fake answers for a row on
 * another table UNLESS the query actually scopes itself — which is how the
 * scoping can be tested without a database.
 */
function catalog(rows: { name: string; table: string; def: string }[]) {
    return async (sql: string, name: string) => {
        const scoped = /conrelid = '"ReceiptIntake"'::regclass/.test(sql);
        return rows
            .filter(r => r.name === name && (!scoped || r.table === "ReceiptIntake"))
            .map(r => ({ def: r.def }));
    };
}

type ExpectedFk = {
    name: string; kind: string; table: string; column: string;
    references: string; referencedColumn: string; onDelete: string; onUpdate: string;
};

const expectedFks = (expectedConstraints as unknown as ExpectedFk[]).filter(c => c.kind === "fk");

/** What a CORRECT production database renders back, in pg's own shape. */
const LIVE_CONSTRAINTS = [
    {
        name: "ReceiptIntake_state_check",
        table: "ReceiptIntake",
        def: `CHECK ((state = ANY (ARRAY[${
            RECEIPT_INTAKE_STATES.map((s: string) => `'${s}'::text`).join(", ")
        }])))`,
    },
    ...expectedFks.map(c => ({
        name: c.name,
        table: "ReceiptIntake",
        def: `FOREIGN KEY ("${c.column}") REFERENCES "${c.references}"(${c.referencedColumn})`
            + ` ON UPDATE ${c.onUpdate} ON DELETE ${c.onDelete}`,
    })),
];

test("the control: a correct database verifies clean", async () => {
    const { problems, notes } = await verifyConstraints(catalog(LIVE_CONSTRAINTS));
    assert.deepEqual(problems, []);
    assert.equal(notes.length, expectedConstraints.length, "every constraint reported");
});

test("a same-named constraint on ANOTHER table is drift, not a pass", async () => {
    // The exact hole: pg_constraint is database-wide, so `WHERE conname = $1`
    // was satisfied by a constraint of that name on any relation at all — and a
    // database where ReceiptIntake never got its foreign keys still reported
    // "verified 5 constraints".
    const elsewhere = LIVE_CONSTRAINTS.map(c =>
        c.name === "ReceiptIntake_projectId_fkey" ? { ...c, table: "SomeOtherTable" } : c);
    const { problems } = await verifyConstraints(catalog(elsewhere));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ReceiptIntake_projectId_fkey missing on ReceiptIntake/);
});

test("a stale FK target is drift — the RIGHT name pointing at the WRONG parent", async () => {
    const stale = LIVE_CONSTRAINTS.map(c =>
        c.name === "ReceiptIntake_costCodeId_fkey"
            ? { ...c, def: 'FOREIGN KEY ("costCodeId") REFERENCES "Phase"(id) ON UPDATE CASCADE ON DELETE SET NULL' }
            : c);
    const { problems } = await verifyConstraints(catalog(stale));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /referenced table is Phase, want CostCode/);
});

test("ON DELETE CASCADE where SET NULL was written is drift", () => {
    // The difference between "losing a project nulls a column" and "losing a
    // project DELETES the audit trail of a booked receipt".
    const expected = expectedFks.find(c => c.name === "ReceiptIntake_projectId_fkey")!;
    const drift = foreignKeyDrift(
        expected,
        'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE CASCADE',
    );
    assert.match(drift!, /ON DELETE is CASCADE, want SET NULL/);
});

test("an FK with NO action clause reads as NO ACTION, never as 'unspecified'", () => {
    // Postgres renders nothing at all for the SQL default, and NO ACTION is
    // exactly the value that would BLOCK a project delete instead of nulling
    // the column. Treating an absent clause as "fine" would wave that through.
    const expected = expectedFks.find(c => c.name === "ReceiptIntake_expenseId_fkey")!;
    const drift = foreignKeyDrift(expected, 'FOREIGN KEY ("expenseId") REFERENCES "Expense"(id)');
    assert.match(drift!, /ON DELETE is NO ACTION, want SET NULL/);
    assert.match(drift!, /ON UPDATE is NO ACTION, want CASCADE/);
});

test("a missing constraint is still a failure, and names the table", async () => {
    const without = LIVE_CONSTRAINTS.filter(c => c.name !== "ReceiptIntake_expenseId_fkey");
    const { problems } = await verifyConstraints(catalog(without));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ReceiptIntake_expenseId_fkey missing on ReceiptIntake/);
});

test("the state CHECK is still verified by CONTENT, through the same path", async () => {
    const narrowed = LIVE_CONSTRAINTS.map(c =>
        c.name === "ReceiptIntake_state_check"
            ? { ...c, def: "CHECK ((state = ANY (ARRAY['RECEIVED'::text])))" }
            : c);
    const { problems } = await verifyConstraints(catalog(narrowed));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /does not allow: STAGING/);
});

test("every lookup is scoped to ReceiptIntake, and every expectation names it", () => {
    assert.match(CONSTRAINT_LOOKUP_SQL, /conrelid = '"ReceiptIntake"'::regclass/);
    assert.match(CONSTRAINT_LOOKUP_SQL, /conname = \$1/, "the NAME is the parameter, the table is not");
    for (const c of expectedConstraints) {
        assert.equal(c.table, "ReceiptIntake", `${c.name} is scoped by the literal in the SQL`);
    }
});

test("each expected FK matches the ALTER TABLE the script and the migration apply", () => {
    // The expectation is only worth anything if it describes what is actually
    // written. Both files are checked, so the verifier cannot drift away from
    // either the production path or the CI one.
    for (const fk of expectedFks) {
        const shape = normalize(
            `ADD CONSTRAINT "${fk.name}" FOREIGN KEY ("${fk.column}")`
            + ` REFERENCES "${fk.references}"("${fk.referencedColumn}")`
            + ` ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`,
        );
        const statement = statements.find((s: string) => s.includes(`ADD CONSTRAINT "${fk.name}"`));
        assert.ok(statement, `${fk.name} is not in the script`);
        assert.ok(normalize(statement!).includes(shape), `${fk.name}: script SQL disagrees with the expectation`);
        assert.ok(normalize(migrationSql).includes(shape), `${fk.name}: migration.sql disagrees with the expectation`);
    }
});

// ── The receipts bucket is provisioned, not assumed (round-13 item 3) ───────

test("the bucket policy in the script matches the one the code writes through", async () => {
    // Two places name the same limits: the provisioner and the runtime module.
    // If they drift, the runtime happily writes objects the bucket refuses (or,
    // worse, accepts objects the runtime thinks are impossible).
    const { RECEIPT_BUCKET_POLICY } = await import("../src/lib/receipt-intake/bucket");
    assert.equal(RECEIPT_BUCKET, RECEIPT_BUCKET_POLICY.name);
    assert.equal(RECEIPT_BUCKET_FILE_SIZE_LIMIT, RECEIPT_BUCKET_POLICY.fileSizeLimit);
    assert.deepEqual(
        [...RECEIPT_BUCKET_MIME_TYPES].sort(),
        [...RECEIPT_BUCKET_POLICY.allowedMimeTypes].sort(),
        "the accepted formats and the bucket's allow-list are the same list",
    );
    assert.equal(RECEIPT_BUCKET_POLICY.public, false);

    // ONE CEILING, and it is QuickBooks': a bucket that accepts more than QBO
    // will attach stores receipts that are guaranteed to strand — the Purchase
    // is created, the file is not on it, and the books look complete. The
    // intake door, the bucket, the object check and the booking preflight are
    // all the same number.
    const { QBO_ATTACHMENT_MAX_BYTES, MAX_STORED_BYTES } =
        await import("../src/lib/receipt-intake/intake-core");
    const { attachmentBlocker } = await import("../src/lib/receipt-intake/book");
    assert.equal(RECEIPT_BUCKET_FILE_SIZE_LIMIT, 8 * 1024 * 1024);
    assert.equal(QBO_ATTACHMENT_MAX_BYTES, RECEIPT_BUCKET_FILE_SIZE_LIMIT);
    assert.equal(MAX_STORED_BYTES, RECEIPT_BUCKET_FILE_SIZE_LIMIT);
    // The booking preflight agrees at the boundary, in both directions.
    assert.equal(attachmentBlocker("image/png", MAX_STORED_BYTES), null);
    assert.equal(attachmentBlocker("image/png", MAX_STORED_BYTES + 1), `size:${MAX_STORED_BYTES + 1}`);
});

test("a missing bucket is CREATED private, with both limits", async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const outcome = await ensureReceiptBucket("https://x.supabase.co", "key", async (_u: string, _k: string, path: string, init: any = {}) => {
        calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === "GET") return { status: 404, ok: false, body: { error: "not found" } };
        return { status: 200, ok: true, body: { name: RECEIPT_BUCKET } };
    });
    assert.equal(outcome, "created");
    assert.equal(calls[0].method, "GET", "it looks before it creates");
    assert.equal(calls[1].body.public, false);
    assert.equal(calls[1].body.file_size_limit, RECEIPT_BUCKET_FILE_SIZE_LIMIT);
    assert.deepEqual(calls[1].body.allowed_mime_types, RECEIPT_BUCKET_MIME_TYPES);
});

test("an existing bucket with the right policy is VERIFIED, and nothing is written", async () => {
    let writes = 0;
    const outcome = await ensureReceiptBucket("https://x.supabase.co", "key", async (_u: string, _k: string, _p: string, init: any = {}) => {
        if (init.method !== "GET") { writes++; return { status: 200, ok: true, body: {} }; }
        return {
            status: 200, ok: true,
            body: {
                name: RECEIPT_BUCKET, public: false,
                file_size_limit: RECEIPT_BUCKET_FILE_SIZE_LIMIT,
                allowed_mime_types: RECEIPT_BUCKET_MIME_TYPES,
            },
        };
    });
    assert.equal(outcome, "verified");
    assert.equal(writes, 0, "re-running provisions nothing");
});

test("a DIFFERENT limit is a hard failure, never a silent correction", async () => {
    // Overwriting a limit somebody set deliberately is how a 400 MB upload
    // becomes possible again next quarter. The operator has to see it.
    const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ file_size_limit: 50 * 1024 * 1024 }, /file_size_limit/],
        [{ file_size_limit: "50MB" }, /file_size_limit/],
        [{ public: true }, /PUBLIC/],
        [{ allowed_mime_types: null }, /allowed_mime_types is unset/],
        [{ allowed_mime_types: ["image/png"] }, /missing/],
        [{ allowed_mime_types: [...RECEIPT_BUCKET_MIME_TYPES, "application/zip"] }, /unexpected/],
    ];
    for (const [override, expected] of cases) {
        const body = {
            name: RECEIPT_BUCKET, public: false,
            file_size_limit: RECEIPT_BUCKET_FILE_SIZE_LIMIT,
            allowed_mime_types: RECEIPT_BUCKET_MIME_TYPES,
            ...override,
        };
        await assert.rejects(
            () => ensureReceiptBucket("https://x.supabase.co", "key", async () => ({ status: 200, ok: true, body })),
            expected,
            JSON.stringify(override),
        );
    }
});

test("Supabase's file_size_limit is read in either shape", () => {
    // It comes back as a byte count from some API versions and as "15MB" from
    // others; reading only one of those would fail a correct bucket.
    assert.equal(parseSizeLimit(15728640), 15728640);
    assert.equal(parseSizeLimit("15728640"), 15728640);
    assert.equal(parseSizeLimit("15MB"), 15728640);
    assert.equal(parseSizeLimit("15 mb"), 15728640);
    assert.equal(parseSizeLimit(null), null);
    assert.equal(parseSizeLimit("enormous"), null);
});

test("a storage read failure stops the run rather than assuming the bucket is fine", async () => {
    await assert.rejects(
        () => ensureReceiptBucket("https://x.supabase.co", "key", async () => ({
            status: 500, ok: false, body: { error: "boom" },
        })),
        /could not read bucket/,
    );
});

// ── The DATABASE_URL redactor (Codex round-17 item 2) ─────────────────────
//
// `maskUrl` is printed by the apply script's own preflight, so whatever it
// returns ends up in terminal scrollback and in the tickets operators paste
// it into. The regex it replaces — `/:[^:@]*@/` -> `:****@` — matched only the
// LAST colon-delimited run before the `@`, so a password containing a literal
// colon had its first half printed in clear.

test("a password containing a colon is FULLY redacted", () => {
    // The exact leak: `pa:ss` printed as `pa:****`, exposing `pa`.
    const masked = maskUrl("postgresql://appuser:pa:ss@db.example.com:5432/probuild");
    assert.ok(!masked.includes("pa:ss"), masked);
    assert.ok(!masked.includes(":pa"), `no fragment of the password survives: ${masked}`);
    assert.ok(!masked.includes("ss@"), masked);
    // Still useful: the host, port and database are what the operator is
    // checking against --expect-db / --expect-host.
    assert.ok(masked.includes("db.example.com"), masked);
    assert.ok(masked.includes("5432"), masked);
    assert.ok(masked.includes("probuild"), masked);

    // PRE-FIX CONTROL: the old regex leaks on this exact input, so this test
    // cannot pass for the implementation it replaced.
    const oldRegex = "postgresql://appuser:pa:ss@db.example.com:5432/probuild"
        .replace(/:[^:@]*@/, ":****@");
    assert.ok(oldRegex.includes(":pa"), "the old redactor printed the first half");
});

test("a percent-encoded @ in the password does not end the userinfo early", () => {
    // `@` is legal inside a password when encoded, and a regex anchored on the
    // first or last `@` gets the boundary wrong either way.
    const masked = maskUrl("postgresql://appuser:p%40ss%3Aword@db.example.com:6543/probuild");
    assert.ok(!masked.includes("p%40ss"), masked);
    assert.ok(!masked.includes("word"), masked);
    assert.ok(masked.includes("db.example.com"), masked);
});

test("the USERNAME goes too — an account name is a credential", () => {
    const masked = maskUrl("postgresql://postgres.abcdefgh:secret@aws-0-us-west-2.pooler.supabase.com:6543/postgres");
    assert.ok(!masked.includes("secret"), masked);
    assert.ok(!masked.includes("postgres.abcdefgh"), masked);
    assert.ok(masked.includes("pooler.supabase.com"), masked);
});

test("an UNPARSEABLE url is never echoed, not even in part", () => {
    // There is nothing safe to show: any substring of a malformed string could
    // be the password, so a redactor that prints "the bit I could not parse"
    // leaks the thing it exists to hide.
    for (const bad of ["not a url at all", "://user:pw@host", "", "postgres:/missing-slash@host"]) {
        const masked = maskUrl(bad);
        assert.equal(masked, "<unparseable DATABASE_URL, redacted>", bad);
    }
    // `postgresql://` and `postgres:/x@y` both PARSE — WHATWG accepts a bare
    // scheme, and the second as an opaque path whose `@` is not a userinfo
    // boundary at all. Neither has a host, which is how the redactor knows it
    // could not locate the credentials, so both take the placeholder rather
    // than being echoed on the guess that their `@` is harmless.
    assert.equal(maskUrl("postgresql://"), "<unparseable DATABASE_URL, redacted>");
});

test("a url with no credentials is passed through readably", () => {
    // The control: redaction must not mangle a URL that has nothing to hide,
    // or the preflight line stops being useful for its actual purpose.
    const masked = maskUrl("postgresql://db.example.com:5432/probuild?sslmode=require");
    assert.ok(masked.includes("db.example.com"), masked);
    assert.ok(masked.includes("sslmode=require"), masked);
    assert.ok(!masked.includes("***"), masked);
});

// ── The upgrade path repairs the state default (round-18 item 4) ──────────
//
// `CREATE TABLE IF NOT EXISTS` carries DEFAULT 'STAGING' and is a no-op on an
// existing table, so a ReceiptIntake created by an earlier Phase-1 revision
// keeps DEFAULT 'RECEIVED'. Adding columns cannot fix that. Every row inserted
// without an explicit state then skipped STAGING and became claimable by the
// worker before its object existed — precisely what the two-step upload exists
// to prevent — and the verify reported clean, because it read column NAMES and
// the column was present either way.

test("the upgrade path SETS the default, in both the script and the migration", () => {
    const repair = `ALTER TABLE "ReceiptIntake" ALTER COLUMN "state" SET DEFAULT 'STAGING'`;
    assert.ok(
        statements.some(s => s.includes(repair)),
        "the apply script repairs it",
    );
    const migration = readFileSync(
        path.join(__dirname, "..", "prisma/migrations/20260901000000_receipt_intake/migration.sql"),
        "utf8",
    );
    assert.ok(migration.includes(`${repair};`), "and so does the migration's upgrade section");
    // It must live in the UPGRADE section — after the CREATE TABLE, which is
    // the statement that is a no-op on an existing table.
    assert.ok(
        migration.indexOf(repair) > migration.indexOf("CREATE TABLE IF NOT EXISTS \"ReceiptIntake\""),
        "after the create, where the upgrade statements are",
    );
});

test("the verify reads DEFAULTS, and reports drift", async () => {
    // A name check cannot see this, which is why it reported clean while the
    // default was wrong.
    const wrong = await verifyColumnDefaults(async () => [{ column_default: "'RECEIVED'::text" }]);
    assert.equal(wrong.problems.length, 1);
    assert.match(wrong.problems[0], /ReceiptIntake\.state default is 'RECEIVED'::text, expected 'STAGING'/);

    // PRE-FIX CONTROL: the old verify only asked for column NAMES, and
    // `state` is present in both shapes — so it passed.
    assert.ok(expectedColumns.ReceiptIntake.includes("state"), "the column is there either way");

    const right = await verifyColumnDefaults(async () => [{ column_default: "'STAGING'::text" }]);
    assert.deepEqual(right.problems, []);
    assert.equal(right.notes.length, 1);

    // A column with NO default at all is drift too, not an absence to shrug at.
    // THE TABLE AND COLUMN ARE BOUND PARAMETERS, not SQL text. This is not
    // pedantry: the DB-gated probe in receipt-intake-claim-db.test.ts pointed
    // itself at a stand-in table by rewriting the SQL string, which substituted
    // nothing, so the check silently ran against the REAL table and reported
    // clean. Anything redirecting this query must rewrite the ARGS.
    const calls: { sql: string; args: unknown[] }[] = [];
    await verifyColumnDefaults(async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        return [{ column_default: "'STAGING'::text" }];
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["ReceiptIntake", "state"], "passed as $1 and $2");
    assert.ok(!calls[0].sql.includes("ReceiptIntake"), "and NOT interpolated into the SQL");

    const none = await verifyColumnDefaults(async () => [{ column_default: null }]);
    assert.equal(none.problems.length, 1);
    assert.match(none.problems[0], /default is \(none\)/);
});

test("the default comparison ignores how Postgres echoes the cast", () => {
    // `information_schema` renders a text literal as `'STAGING'::text`; the
    // bare literal is the same default. Comparing raw strings would make the
    // check fail on a correct database, which is worse than not checking.
    assert.equal(columnDefaultMatches("'STAGING'::text", "'STAGING'::text"), true);
    assert.equal(columnDefaultMatches("'STAGING'", "'STAGING'::text"), true);
    assert.equal(columnDefaultMatches("'STAGING'::character varying", "'STAGING'::text"), true);
    assert.equal(columnDefaultMatches("'RECEIVED'::text", "'STAGING'::text"), false);
    assert.equal(columnDefaultMatches(null, "'STAGING'::text"), false);
    assert.equal(columnDefaultMatches(undefined, "'STAGING'::text"), false);
});

// ── THE SCRIPT HAS TO PROVE WHICH DATABASE IT IS TALKING TO ───────────────
//
// It used to resolve its URL from `process.env.DATABASE_URL` FIRST. A
// developer with a local one exported in their shell could run this, watch
// every statement report ok against their own Postgres, and merge believing
// production had been migrated -- there was no line in the output that said
// otherwise. `--target prod` is now required, it reads .env.production.local
// and nothing else, and the run prints a redacted target line before the
// first statement.

test("an ambient DATABASE_URL is NOT a target: no flag, no run", () => {
    // The exact shape of the accident: a local URL in the environment and an
    // otherwise complete command line.
    const argv = [
        "node", "scripts/apply-receipt-intake.mjs",
        "--yes", "--expect-db", "postgres", "--expect-host", "10.0.0.5",
    ];
    const refused = chooseTarget(argv);
    assert.equal(refused.ok, false);
    assert.match(String((refused as { reason?: string }).reason), /--target prod/);
    assert.match(String((refused as { reason?: string }).reason), /ambient DATABASE_URL is NOT a target/);

    // A wrong target is refused too, rather than silently meaning prod.
    const staging = chooseTarget(["node", "s.mjs", "--target", "staging", "--yes"]);
    assert.equal(staging.ok, false);
    assert.match(String((staging as { reason?: string }).reason), /Targets are prod and ci/);

    // ...and a bare `--target` with nothing after it.
    assert.equal(chooseTarget(["node", "s.mjs", "--target"]).ok, false);

    // CONTROL: the real invocation is accepted.
    assert.deepEqual(chooseTarget(["node", "s.mjs", "--target", "prod", "--yes"]), {
        ok: true,
        target: "prod",
    });
    // ...and so is the CI one, which is a different database entirely.
    assert.deepEqual(chooseTarget(["node", "s.mjs", "--target", "ci", "--yes"]), {
        ok: true,
        target: "ci",
    });
});

test("--target ci takes the ambient URL, and REFUSES a Supabase one", () => {
    // The CI driver builds a throwaway database and runs the real script
    // against it, so this target has to read the ambient URL -- and it must
    // never be able to reach a real project through that door.
    const before = process.env.DATABASE_URL;
    try {
        process.env.DATABASE_URL = "postgresql://probuild:probuild@localhost:5432/probuild_apply";
        const ci = resolveTargetUrl("ci");
        assert.match(ci.url, /localhost/);
        assert.match(ci.from, /--target ci/);

        // A pooler URL, a direct URL -- both refused.
        for (const url of [
            "postgresql://postgres.abc:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres",
            "postgresql://postgres:pw@db.ghzdbzdnwjxazvmcefbh.supabase.co:5432/postgres",
        ]) {
            process.env.DATABASE_URL = url;
            assert.throws(() => resolveTargetUrl("ci"), /REFUSING/, url);
            assert.equal(looksLikeSupabase(url), true);
        }

        delete process.env.DATABASE_URL;
        assert.throws(() => resolveTargetUrl("ci"), /DATABASE_URL is required/);
    } finally {
        if (before === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = before;
    }

    // And a local URL is NOT mistaken for Supabase.
    assert.equal(looksLikeSupabase("postgresql://u:p@localhost:5432/db"), false);
});

test("the ci identity check proves the target is NOT production", async () => {
    const query = async () => [{ db: "probuild_apply", host: "" }] as unknown[];

    const ok = await verifyProdIdentity(
        query,
        "localhost",
        "",
        undefined,
        "ci",
    );
    assert.deepEqual(
        ok.problems,
        [],
        "no baseline row and no project ref are required of a throwaway database",
    );
    assert.match(ok.line, /project=\(ci\)/);
    assert.match(ok.line, /database=probuild_apply/);

    // Pointed at Supabase it refuses, even though every other fact checks out.
    const wrong = await verifyProdIdentity(
        query,
        "aws-0-us-west-2.pooler.supabase.com",
        "",
        undefined,
        "ci",
    );
    assert.equal(wrong.problems.length, 1);
    assert.match(wrong.problems[0], /REFUSING: --target ci was pointed at/);
});

test("--target prod reads .env.production.local, and IGNORES the environment", () => {
    // The override is the point: preferring an ambient value is what let a
    // local database be mistaken for production.
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://dev:dev@localhost:5432/probuild_dev";
    try {
        const resolved = resolveTargetUrl(
            "prod",
            () => 'DATABASE_URL="postgresql://u:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true"\nOTHER=1\n',
            () => true,
        );
        assert.equal(resolved.from, PROD_ENV_FILE);
        assert.match(resolved.url, /pooler\.supabase\.com/);
        assert.ok(!resolved.url.includes("localhost"), "the ambient URL never wins");
    } finally {
        if (before === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = before;
    }

    // A missing file is a refusal with a remedy, never a fallback.
    assert.throws(
        () => resolveTargetUrl("prod", () => "", () => false),
        /not found/,
    );
    // A file with no DATABASE_URL is a refusal too.
    assert.throws(
        () => resolveTargetUrl("prod", () => "NEXTAUTH_SECRET=x\n", () => true),
        /DATABASE_URL not found/,
    );
});

test("the identity check needs the POOLER host, the PROJECT and the BASELINE", async () => {
    const PROD = "ghzdbzdnwjxazvmcefbh";
    const rows = {
        identity: [{ db: "postgres", host: "10.0.0.5" }],
        baseline: [{ migration_name: PROD_BASELINE_MIGRATION }],
    };
    const query = async (sql: string) =>
        (/current_database/.test(sql) ? rows.identity : rows.baseline) as unknown[];
    const host = `aws-0-us-west-2${PROD_POOLER_HOST_SUFFIX}`;

    const good = await verifyProdIdentity(query, host, PROD, PROD);
    assert.deepEqual(good.problems, [], "right host, right project, baseline present");
    assert.match(good.line, new RegExp(`project=${PROD}`));

    // THE CASE HOST + DATABASE + BASELINE CANNOT SEE. Supabase's pooler
    // hostnames are shared regionally and every Supabase database is called
    // `postgres`, so a staging clone migrated off the same baseline presents
    // an IDENTICAL host, name and migration row. Only the project ref differs.
    const clone = await verifyProdIdentity(query, host, "stagingclone123456ab", PROD);
    assert.equal(clone.problems.length, 1);
    assert.match(clone.problems[0], /is not ghzdbzdnwjxazvmcefbh: same pooler host, different project/);

    // An UNSET variable is a refusal, not a skip: a check that turns itself
    // off when its input is missing is the check not existing.
    const unset = await verifyProdIdentity(query, host, PROD, undefined);
    assert.equal(unset.problems.length, 1);
    assert.match(unset.problems[0], new RegExp(`${PROJECT_REF_ENV} is not set`));

    // A URL whose username carries no ref cannot satisfy it either.
    const noRef = await verifyProdIdentity(query, host, "", PROD);
    assert.equal(noRef.problems.length, 1);
    assert.match(noRef.problems[0], /no project ref/);

    // A local host is refused even when the database is called `postgres`.
    const local = await verifyProdIdentity(query, "localhost", PROD, PROD);
    assert.equal(local.problems.length, 1);
    assert.match(local.problems[0], /not a \.pooler\.supabase\.com pooler host/);

    // And a pooler host WITHOUT the baseline row is refused: migration history
    // is the fact a look-alike database cannot fake.
    rows.baseline = [];
    const noBaseline = await verifyProdIdentity(query, host, PROD, PROD);
    assert.equal(noBaseline.problems.length, 1);
    assert.match(noBaseline.problems[0], /no 20260814000000_baseline_production row/);

    // A _prisma_migrations table that does not exist at all is the same answer,
    // not a crash.
    const noTable = await verifyProdIdentity(
        async (sql: string) => {
            if (/current_database/.test(sql)) return rows.identity as unknown[];
            throw new Error('relation "_prisma_migrations" does not exist');
        },
        host,
        PROD,
        PROD,
    );
    assert.equal(noTable.problems.length, 1);
    assert.match(noTable.problems[0], /this is not production/);
});

test("the project ref comes out of the URL USERNAME, which is where it lives", () => {
    assert.equal(
        projectRefOf("postgresql://postgres.ghzdbzdnwjxazvmcefbh:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres"),
        "ghzdbzdnwjxazvmcefbh",
    );
    // Percent-encoding in the userinfo is normal and must not hide the ref.
    assert.equal(
        projectRefOf("postgresql://postgres.abc123:p%40ss%3Aword@aws-0-us-west-2.pooler.supabase.com:6543/postgres"),
        "abc123",
    );
    // A direct (non-pooler) URL has a bare username and so carries no ref.
    assert.equal(projectRefOf("postgresql://postgres:pw@db.example.supabase.co:5432/postgres"), "");
    // Nothing parseable, nothing claimed.
    assert.equal(projectRefOf("not a url"), "");
    assert.equal(projectRefOf(""), "");
});

test("the TARGET LINE names host, database and baseline -- and no credentials", async () => {
    const line = targetLine({
        host: "aws-0-us-west-2.pooler.supabase.com",
        database: "postgres",
        projectRef: "ghzdbzdnwjxazvmcefbh",
        baseline: true,
    });
    assert.equal(
        line,
        "TARGET host=aws-0-us-west-2.pooler.supabase.com project=ghzdbzdnwjxazvmcefbh"
        + " database=postgres baseline=present",
    );
    // It is built from a PARSED hostname and the name the SERVER reported, so
    // there is no path by which a password reaches it. (The URL log line's own
    // redaction is covered by the maskUrl tests above.)
    const secretish = "postgresql://postgres.abc123:pa:ss@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
    assert.equal(hostOf(secretish), "aws-0-us-west-2.pooler.supabase.com");
    const built = targetLine({
        host: hostOf(secretish),
        database: "postgres",
        projectRef: projectRefOf(secretish),
        baseline: false,
    });
    assert.ok(!built.includes("pa:ss"), "no credential can ride in on the host");
    // The PROJECT REF is published on purpose -- it is a public identifier,
    // the same one that appears in the Supabase URL -- but the password half
    // of the userinfo never is.
    assert.match(built, /project=abc123/);
    assert.ok(!built.includes("postgres.abc123:"), "the username is not echoed verbatim");
    assert.match(built, /baseline=MISSING/);
    assert.equal(hostOf("not a url at all"), "", "an unparseable URL yields no host, never a fragment");
});

test("main() refuses BEFORE it builds a client, and prints the target BEFORE any DDL", () => {
    // Order is the property, and it is asserted on the shipped source: a check
    // that runs after the first ALTER has already changed the wrong database.
    const script = readFileSync(path.join(__dirname, "..", "scripts", "apply-receipt-intake.mjs"), "utf8");
    const main = script.slice(script.indexOf("async function main()"));
    const chooseAt = main.indexOf("chooseTarget(process.argv)");
    const clientAt = main.indexOf("new PrismaClient(");
    const identityAt = main.indexOf("await verifyProdIdentity(");
    const printAt = main.indexOf("console.log(identity.line)");
    const ddlAt = main.indexOf("await prisma.$executeRawUnsafe(sql)");

    assert.ok(chooseAt > 0, "main asks for a target");
    assert.ok(chooseAt < clientAt, "and refuses before a client is even built");
    assert.ok(clientAt < identityAt && identityAt < ddlAt, "identity is proven before any DDL");
    assert.ok(printAt > 0 && printAt < ddlAt, "and the target line is printed before it too");

    // --dry-run reports the same target line and runs nothing.
    assert.match(main, /if \(dryRun\) \{/);
    const dryAt = main.indexOf("if (dryRun) {");
    assert.ok(printAt < dryAt && dryAt < ddlAt, "a dry run has already printed the target, and returns before the DDL");

    // The old ambient resolver is GONE, not merely unused.
    assert.ok(!script.includes("resolveDatabaseUrl"), "no ambient-first resolver survives");
    // A CALL, not a mention: the doc comments name the ambient variable they
    // stopped reading, so comment lines are stripped first.
    const code = script
        .split(/\r?\n/)
        .filter(line => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .join("\n");
    // EXACTLY ONE reader, and it is inside the `--target ci` branch -- a
    // throwaway database the caller had to name, on a URL that is refused if
    // it looks like Supabase. The prod path reads .env.production.local and
    // nothing else.
    const ambient = code.split("process.env.DATABASE_URL").length - 1;
    assert.equal(ambient, 1, "one ambient read, in the ci branch");
    const ciBranch = code.slice(
        code.indexOf('if (target === "ci")'),
        code.indexOf('if (target !== "prod")'),
    );
    assert.match(ciBranch, /const url = process\.env\.DATABASE_URL;/);
    assert.match(ciBranch, /looksLikeSupabase\(url\)/, "and it refuses a Supabase URL");
});
