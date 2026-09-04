/**
 * Drive scripts/apply-payroll-phase5.mjs end to end against a throwaway
 * database, the way production will run it.
 *
 * CI-ONLY. Nothing else in the suite executes that script's `main()`: the
 * parity test reads it as text, the drift tests import its pure helpers, and
 * the idempotency test runs it only against a database `prisma migrate deploy`
 * has ALREADY brought to the final shape — which is the one state where the
 * whole DDL body is a no-op. So the statements that actually create things had
 * never been executed by anything but production itself.
 *
 * This builds the two states production has really been in and runs the real
 * script over them:
 *
 *   1. PRE-PHASE-5 — every committed migration except 20260901000000. The
 *      script has to create the whole shape itself.
 *   2. THE 2026-09-02 SHAPE — that, plus the phase-5 migration, minus the two
 *      objects the accidental import never applied: `User.payrollRevision` and
 *      the `PayrollPeriod_locked_snapshot_complete` CHECK. This is what
 *      production is PRESUMED to look like right now, and it is the state the
 *      documented deploy command will meet.
 *
 * Over each: apply, then `--dry-run` must exit 0 with zero drift, then apply
 * again for idempotency. Finally the result is compared against the committed
 * migration, so "the script created something" also means "it created the same
 * thing the migration does".
 *
 * `--target ci` takes the ambient DATABASE_URL, skips the production baseline
 * and project-ref checks, and REFUSES any Supabase host — so this driver cannot
 * reach a hosted database even by accident.
 */
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = process.env.APPLY_E2E_SERVER_URL;
const DB = process.env.APPLY_E2E_DB ?? "probuild_apply_payroll";
if (!SERVER) {
    console.error("APPLY_E2E_SERVER_URL is required (a URL on the throwaway server).");
    process.exit(1);
}
if (/supabase\.(co|com)/i.test(SERVER)) {
    console.error("REFUSING: APPLY_E2E_SERVER_URL looks like production.");
    process.exit(1);
}

const PHASE5 = path.join("prisma", "migrations", "20260901000000_payroll_phase5");
const SCRIPT = path.join("scripts", "apply-payroll-phase5.mjs");
const GUARD = ["--target", "ci"];

const target = new URL(SERVER);
target.pathname = `/${DB}`;
const targetUrl = target.toString();
const adminUrl = new URL(SERVER);
adminUrl.pathname = "/postgres";

const run = (cmd, args, env) =>
    execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });

async function withClient(url, fn) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        return await fn(client);
    } finally {
        await client.$disconnect();
    }
}

async function recreateDatabase() {
    await withClient(adminUrl.toString(), async (client) => {
        await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
        await client.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);
    });
}

/** `prisma migrate deploy` with the phase-5 migration directory moved aside. */
function deployWithoutPhase5() {
    const parked = path.join(mkdtempSync(path.join(tmpdir(), "p5mig-")), "20260901000000_payroll_phase5");
    renameSync(PHASE5, parked);
    try {
        run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: targetUrl, DIRECT_URL: targetUrl });
    } finally {
        renameSync(parked, PHASE5);
    }
}

/**
 * Everything the phase-5 migration declares, MINUS the two objects the
 * accidental 2026-09-02 import never applied. Reproducing that state is the
 * point: it is what the documented deploy command will actually meet, and it is
 * the one shape no other test covers.
 */
async function stripToSeptember2Shape() {
    await withClient(targetUrl, async (client) => {
        await client.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "PayrollPeriod_locked_snapshot_complete"`
        );
        // DROP COLUMN takes every constraint over that column with it — which is
        // exactly how production came to be missing both at once.
        await client.$executeRawUnsafe(`ALTER TABLE "User" DROP COLUMN IF EXISTS "payrollRevision"`);
    });
}

async function assertMissing(what, sql) {
    const [row] = await withClient(targetUrl, (client) => client.$queryRawUnsafe(sql));
    if (Number(row.n) !== 0) {
        console.error(`precondition failed: ${what} is present, so this pass proves nothing`);
        process.exit(1);
    }
}

const COLUMN_SQL = `SELECT count(*)::int AS n FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'payrollRevision'`;
const CHECK_SQL = `SELECT count(*)::int AS n FROM pg_constraint
                    WHERE conname = 'PayrollPeriod_locked_snapshot_complete'`;

/** Apply, verify clean, apply again. The script's own drift verifier is the gate. */
function applyDryRunApply(label) {
    console.log(`\n=== ${label}: apply ===`);
    run("node", [SCRIPT, ...GUARD], { DATABASE_URL: targetUrl });
    // Exits nonzero on drift, so this line failing IS the assertion.
    console.log(`\n=== ${label}: --dry-run must be clean ===`);
    run("node", [SCRIPT, ...GUARD, "--dry-run"], { DATABASE_URL: targetUrl });
    console.log(`\n=== ${label}: apply again (idempotency) ===`);
    run("node", [SCRIPT, ...GUARD], { DATABASE_URL: targetUrl });
}

// ---------------------------------------------------------------------------
// 1. From a PRE-PHASE-5 schema: the script builds the whole shape itself.
// ---------------------------------------------------------------------------
await recreateDatabase();
deployWithoutPhase5();
await assertMissing("User.payrollRevision", COLUMN_SQL);
await assertMissing("the locked-snapshot CHECK", CHECK_SQL);
applyDryRunApply("pre-phase-5");

// ---------------------------------------------------------------------------
// 2. From the 2026-09-02 shape: everything except the two late objects.
// ---------------------------------------------------------------------------
await recreateDatabase();
run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: targetUrl, DIRECT_URL: targetUrl });
await stripToSeptember2Shape();
await assertMissing("User.payrollRevision", COLUMN_SQL);
await assertMissing("the locked-snapshot CHECK", CHECK_SQL);
applyDryRunApply("2026-09-02 shape");

// ---------------------------------------------------------------------------
// 3. ...and the shape it built is the one the committed migration declares.
//
// That equivalence is established, not skipped. The clean `--dry-run` above is
// the script's OWN drift verifier over its whole EXPECTED_OBJECTS list — every
// column with its type and nullability, every index with its columns and
// uniqueness, every CHECK with its normalized definition — and
// tests/payroll-apply-script-parity.test.ts asserts that list covers everything
// the migration declares. So "dry-run is clean" over a database the SCRIPT
// built means the script built what the migration builds.
//
// Deliberately NOT scripts/check-migrations-match.mjs here: that compares the
// whole database to schema.prisma including functions and triggers this script
// does not manage, and the `migrations` job already runs it directly after
// `migrate deploy`, which is where it belongs.
// ---------------------------------------------------------------------------

console.log("\napply script end-to-end: OK");
