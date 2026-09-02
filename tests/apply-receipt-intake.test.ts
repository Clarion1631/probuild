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
    ensureReceiptBucket,
    parseSizeLimit,
    statements,
    targetMatches,
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
