/**
 * Drive scripts/apply-phase2-receipt-queue.mjs end to end against a throwaway
 * database, the way production will run it (Codex cross-PR addendum, round 46).
 *
 * CI-only. `main()` is the one part of that script no other test executes — the
 * unit tests read its statement list and its guards as text — so a statement
 * that a real Postgres rejects, or one that runs in the wrong order, would ship
 * green. This builds a PRE-PHASE-2 database, seeds the two shapes whose
 * behaviour depends on existing rows, runs the script twice, and asserts the
 * result matches the committed migration.
 *
 * The seeds are the point. An empty database exercises the CREATEs and nothing
 * else; the memo quarantine (round-36 gate, finding 3) and the delivery
 * backfill (round-45 gate, finding 5) are both statements ABOUT EXISTING DATA,
 * and both would report "ok" against an empty table while doing nothing.
 */
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { renameSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = process.env.APPLY_E2E_SERVER_URL;
const DB = process.env.APPLY_E2E_DB ?? "probuild_apply_phase2";
if (!SERVER) {
    console.error("APPLY_E2E_SERVER_URL is required (a URL on the throwaway server).");
    process.exit(1);
}
if (/supabase\.(co|com)/i.test(SERVER)) {
    console.error("REFUSING: APPLY_E2E_SERVER_URL looks like production.");
    process.exit(1);
}

const target = new URL(SERVER);
target.pathname = `/${DB}`;
const targetUrl = target.toString();

const admin = new URL(SERVER);
admin.pathname = "/postgres";

const run = (cmd, args, env) =>
    execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });

const adminClient = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
try {
    await adminClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}"`);
    await adminClient.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);
} finally {
    await adminClient.$disconnect();
}

// A genuine from-scratch apply: build the schema WITHOUT the phase-2 migration,
// so the script has to create the whole shape itself — exactly what it will
// face on production, where that migration has never run.
const phase2 = path.join("prisma", "migrations", "20260901120000_phase2_receipt_queue");
const parked = path.join(mkdtempSync(path.join(tmpdir(), "p2mig-")), "20260901120000_phase2_receipt_queue");
renameSync(phase2, parked);
try {
    run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: targetUrl, DIRECT_URL: targetUrl });
} finally {
    renameSync(parked, phase2);
}

const client = new PrismaClient({ datasources: { db: { url: targetUrl } } });
let host;
try {
    const [row] = await client.$queryRawUnsafe(`SELECT COALESCE(host(inet_server_addr()), '') AS host`);
    host = row.host;

    /**
     * SEED THE SHAPES THE DATA-DEPENDENT STATEMENTS NEED.
     *
     * Without these the run proves only that the CREATEs parse. With them, the
     * memo quarantine has a `memo-signed` issue to find and the delivery
     * backfill has a claim to copy — and the verifier's counts have something
     * to be wrong about.
     */
    const now = new Date().toISOString();

    /**
     * TWO ISSUES CLAIMING THE SAME MEMO. The resolution and the pdfId live
     * INSIDE `displayDetails` — there is no `resolution` column — which is what
     * the quarantine statement parses out. The older one wins the artifact; the
     * younger keeps a `memo-signed` claim with no evidence, and is exactly the
     * row the repair has to reopen.
     */
    const details = pdfId => JSON.stringify({ resolution: "memo-signed", pdfId, owner: "CJ" });
    await client.$executeRawUnsafe(`
        INSERT INTO "ReviewIssue" ("id", "targetType", "targetKey", "reasonCodes", "reasonHash",
                                   "acknowledgedCodes", "displayDetails", "clearedAt",
                                   "firstObservedAt", "updatedAt")
        VALUES ('ci-issue-1', 'bank-line', 'ci-line-1', '["MISSING_RECEIPT"]', 'ci-hash-1',
                '[]', $1, $3, '2026-08-01T00:00:00Z', $3),
               ('ci-issue-2', 'bank-line', 'ci-line-2', '["MISSING_RECEIPT"]', 'ci-hash-2',
                '[]', $2, $3, '2026-08-02T00:00:00Z', $3)
        ON CONFLICT ("id") DO NOTHING`,
        details("ci-shared-pdf"), details("ci-shared-pdf"), now);

    /**
     * And two legacy cards carrying a delivery claim, plus one without — so the
     * backfill has to produce exactly two rows and the unique index has to
     * accept two different days for the same owner.
     */
    await client.$executeRawUnsafe(`
        INSERT INTO "ReceiptRequestCard" ("id", "owner", "pacificDate", "itemsJson", "overflow",
                                          "overflowExact", "status", "postedAt", "deliveredOn",
                                          "attempts", "createdAt", "updatedAt")
        VALUES ('ci-card-1', 'CJ', '2026-08-01', '[]', 0, true, 'POSTED', $1, '2026-08-01', 1, $1, $1),
               ('ci-card-2', 'CJ', '2026-08-02', '[]', 0, true, 'POSTED', $1, '2026-08-02', 1, $1, $1),
               ('ci-card-3', 'Richard', '2026-08-01', '[]', 0, true, 'PENDING', NULL, NULL, 0, $1, $1)
        ON CONFLICT ("id") DO NOTHING`, now);
} finally {
    await client.$disconnect();
}
console.log(`resolved server host: ${host || "(local socket)"}`);

const script = path.join("scripts", "apply-phase2-receipt-queue.mjs");
/**
 * `--target ci`: ambient DATABASE_URL, no production baseline row, no project
 * ref — and the script refuses outright if that URL looks like Supabase. The
 * production guard therefore cannot be satisfied by this path even by accident.
 */
const guard = ["--target", "ci", "--yes", "--expect-db", DB, "--expect-host", host];
const env = { DATABASE_URL: targetUrl };

console.log("\n=== apply ===");
run("node", [script, ...guard], env);
// Idempotency is the property the whole deploy story rests on: the script is
// run before merge, may be re-run after, and a crash part way has to be safe to
// resume from the top.
console.log("\n=== apply, again (idempotency) ===");
run("node", [script, ...guard], env);

/**
 * AND THE RESULT HAS TO MATCH THE COMMITTED MIGRATION.
 *
 * The apply script and the migration are two descriptions of one schema, and
 * they have drifted before while both were green. This is the assertion that
 * they agree in the only place it matters: a real database built by each.
 */
console.log("\n=== the applied shape matches the migration ===");
const MIGRATED_DB = `${DB}_migrated`;
const migrated = new URL(SERVER);
migrated.pathname = `/${MIGRATED_DB}`;

const admin2 = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
try {
    await admin2.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${MIGRATED_DB}"`);
    await admin2.$executeRawUnsafe(`CREATE DATABASE "${MIGRATED_DB}"`);
} finally {
    await admin2.$disconnect();
}
run("npx", ["prisma", "migrate", "deploy"], {
    DATABASE_URL: migrated.toString(),
    DIRECT_URL: migrated.toString(),
});

/** Columns, indexes and RLS for the tables this migration owns. */
const SHAPE_SQL = `
    SELECT 'column' AS kind, table_name AS a, column_name AS b, data_type || ':' || is_nullable AS c
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('ReceiptRequestCard', 'ReceiptRequestCardDelivery', 'ReceiptMemoArtifact', 'BankLineObservation')
    UNION ALL
    SELECT 'index', tablename, indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename IN ('ReceiptRequestCard', 'ReceiptRequestCardDelivery', 'ReceiptMemoArtifact', 'BankLineObservation')
    UNION ALL
    SELECT 'rls', c.relname, 'enabled', c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('ReceiptRequestCard', 'ReceiptRequestCardDelivery', 'ReceiptMemoArtifact', 'BankLineObservation')
    UNION ALL
    SELECT 'policy', tablename, policyname, COALESCE(qual, '') || '|' || COALESCE(with_check, '')
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('ReceiptRequestCard', 'ReceiptRequestCardDelivery', 'ReceiptMemoArtifact', 'BankLineObservation')
    ORDER BY 1, 2, 3, 4`;

const shapeOf = async url => {
    const c = new PrismaClient({ datasources: { db: { url } } });
    try {
        const rows = await c.$queryRawUnsafe(SHAPE_SQL);
        return rows.map(r => `${r.kind}\t${r.a}\t${r.b}\t${r.c}`);
    } finally {
        await c.$disconnect();
    }
};

const applied = await shapeOf(targetUrl);
const expected = await shapeOf(migrated.toString());
const onlyApplied = applied.filter(row => !expected.includes(row));
const onlyExpected = expected.filter(row => !applied.includes(row));
if (onlyApplied.length || onlyExpected.length) {
    console.error("✖ the apply script and the migration produced DIFFERENT shapes.");
    for (const row of onlyApplied) console.error(`  only from the apply script: ${row}`);
    for (const row of onlyExpected) console.error(`  only from the migration:    ${row}`);
    process.exit(1);
}
console.log(`shapes agree across ${applied.length} objects (columns, indexes, RLS, policies)`);

/** And the data-dependent statements actually did something. */
const verify = new PrismaClient({ datasources: { db: { url: targetUrl } } });
try {
    const [deliveries] = await verify.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "ReceiptRequestCardDelivery"`);
    if (deliveries.n < 2) {
        console.error(`✖ the delivery backfill copied ${deliveries.n} rows; the seed had 2 claims.`);
        process.exit(1);
    }
    const [artifacts] = await verify.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "ReceiptMemoArtifact"`);
    const [quarantined] = await verify.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "ReviewIssue" WHERE "displayDetails" LIKE '%memo-conflict%'`);
    console.log(`delivery rows: ${deliveries.n}; memo artifacts: ${artifacts.n}; quarantined: ${quarantined.n}`);
    // The two seeded issues claimed the SAME pdfId: one binds the artifact, the
    // other must be reopened as memo-conflict. Both halves, or the repair did
    // nothing and the "ok" line meant nothing.
    if (artifacts.n !== 1) {
        console.error(`✖ expected exactly one memo artifact from two issues sharing a pdfId; got ${artifacts.n}.`);
        process.exit(1);
    }
    if (quarantined.n !== 1) {
        console.error(`✖ the losing memo-signed claim was not quarantined; got ${quarantined.n}.`);
        process.exit(1);
    }
} finally {
    await verify.$disconnect();
}

console.log("\napply script end-to-end: OK");
