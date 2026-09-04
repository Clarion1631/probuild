/**
 * Drive scripts/apply-receipt-intake.mjs end to end against a throwaway
 * database, the way production will run it.
 *
 * CI-only. `main()` is the one part of that script no other test executes: the
 * unit tests exercise its exported helpers, and the DB-gated tests replay the
 * `statements` array by hand. Neither of them proves the SCRIPT runs — that the
 * flags parse, that the identity gate passes on a database it should pass on,
 * that every statement executes in order against a real server, or that a
 * second run is genuinely a no-op.
 *
 * Two shapes are built and upgraded, because they fail differently:
 *
 *   1. PRE-PHASE-1 — every committed migration except this feature's. The
 *      script has to create the whole table itself.
 *   2. THE OLD PHASE-1 SHAPE — a ReceiptIntake created by an EARLIER revision
 *      of this script, with `state` defaulting to 'RECEIVED' and the later
 *      columns missing. `CREATE TABLE IF NOT EXISTS` is a no-op on it, so this
 *      is the only shape that exercises the additive upgrade section and the
 *      `ALTER COLUMN "state" SET DEFAULT 'STAGING'` repair.
 *
 * Both are then asserted to match what the committed migration produces.
 */
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = process.env.APPLY_E2E_SERVER_URL;
if (!SERVER) {
    console.error("APPLY_E2E_SERVER_URL is required (a URL on the throwaway server).");
    process.exit(1);
}
if (/supabase\.(co|com)/i.test(SERVER)) {
    console.error("REFUSING: APPLY_E2E_SERVER_URL looks like production.");
    process.exit(1);
}

const PHASE1_MIGRATION = "20260901000000_receipt_intake";
/**
 * Migrations that BUILD ON Phase 1's table, and therefore cannot be replayed
 * while it is parked — `ALTER TABLE "ReceiptIntake"` against a database that
 * has no such table is a hard 42P01, which takes `migrate deploy` down with
 * it. They are parked for the WHOLE run, not just the pre-Phase-1 deploys: the
 * reference database is the yardstick this script's output is compared to, and
 * a later feature's column on ReceiptIntake would read as a shape the Phase 1
 * apply script had failed to produce.
 */
const PHASE1_DEPENDENT_MIGRATIONS = [
    // Phase 3 adds `taxAtSource`, `installedAtCustomer` and `costCodeSource`
    // to ReceiptIntake. Unparked, the reference database gets 50 columns while
    // the Phase 1 apply script builds 47 — which reads as a shape the script
    // failed to produce, which is precisely the misreading this list exists
    // to prevent.
    "20260901120000_expense_attribution",
    "20260901120000_phase2_receipt_queue",
];

/** Move a migration directory aside, and put it back however this process ends. */
function parkForTheRun(name) {
    const dir = path.join("prisma", "migrations", name);
    const parked = path.join(mkdtempSync(path.join(tmpdir(), "depmig-")), name);
    renameSync(dir, parked);
    process.on("exit", () => {
        try {
            renameSync(parked, dir);
        } catch {
            // Best effort: this is a throwaway CI checkout either way.
        }
    });
}
for (const name of PHASE1_DEPENDENT_MIGRATIONS) parkForTheRun(name);
const FRESH_DB = process.env.APPLY_E2E_DB ?? "probuild_apply_fresh";
const UPGRADE_DB = `${FRESH_DB}_upgrade`;
const REFERENCE_DB = `${FRESH_DB}_reference`;

const urlFor = db => {
    const target = new URL(SERVER);
    target.pathname = `/${db}`;
    return target.toString();
};
const ADMIN = (() => {
    const admin = new URL(SERVER);
    admin.pathname = "/postgres";
    return admin.toString();
})();

const run = (cmd, args, env) =>
    execFileSync(cmd, args, {
        stdio: "inherit",
        env: { ...process.env, ...env },
        shell: process.platform === "win32",
    });

async function withClient(url, body) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        return await body(client);
    } finally {
        await client.$disconnect();
    }
}

async function recreate(...names) {
    await withClient(ADMIN, async admin => {
        for (const name of names) {
            await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
            await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
        }
    });
}

/** Deploy every committed migration EXCEPT this feature's. */
function deployWithoutPhase1(url) {
    const dir = path.join("prisma", "migrations", PHASE1_MIGRATION);
    const parked = path.join(mkdtempSync(path.join(tmpdir(), "p1mig-")), PHASE1_MIGRATION);
    renameSync(dir, parked);
    try {
        run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: url, DIRECT_URL: url });
    } finally {
        renameSync(parked, dir);
    }
}

/**
 * The table as an EARLIER revision of this script left it: the old default, and
 * without the columns later rounds added. Deliberately NOT generated from the
 * committed statements — the point is a shape they have to upgrade.
 */
const OLD_PHASE1_TABLE = `CREATE TABLE "ReceiptIntake" (
    "id"                  TEXT NOT NULL,
    "source"              TEXT NOT NULL,
    "sourceRef"           TEXT NOT NULL,
    "state"               TEXT NOT NULL DEFAULT 'RECEIVED',
    "dryRun"              BOOLEAN NOT NULL DEFAULT true,
    "stateReason"         TEXT,
    "projectId"           TEXT,
    "costCodeId"          TEXT,
    "suggestedCostCodeId" TEXT,
    "suggestedConfidence" DOUBLE PRECISION,
    "createdById"         TEXT,
    "storagePath"         TEXT NOT NULL,
    "fileName"            TEXT,
    "mimeType"            TEXT NOT NULL,
    "fileSize"            INTEGER NOT NULL,
    "fileSha256"          TEXT NOT NULL,
    "vendor"              TEXT,
    "txnDate"             DATE,
    "totalCents"          INTEGER,
    "taxCents"            INTEGER,
    "docType"             TEXT,
    "refNumber"           TEXT,
    "memo"                TEXT,
    "readJson"            TEXT,
    "readAt"              TIMESTAMP(3),
    "dedupStrongKey"      TEXT,
    "dedupWeakKey"        TEXT,
    "duplicateOfId"       TEXT,
    "qbPurchaseId"        TEXT,
    "expenseId"           TEXT,
    "archiveDriveFileId"  TEXT,
    "attempts"            INTEGER NOT NULL DEFAULT 0,
    "lastError"           TEXT,
    "nextRetryAt"         TIMESTAMP(3),
    "bookedAt"            TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptIntake_pkey" PRIMARY KEY ("id")
)`;

const SCRIPT = path.join("scripts", "apply-receipt-intake.mjs");

/** Run the real script against `db`, twice, and prove the second run is a no-op. */
async function applyTwice(db, label) {
    const url = urlFor(db);
    const host = await withClient(url, async client => {
        const [row] = await client.$queryRawUnsafe(
            `SELECT COALESCE(host(inet_server_addr()), '') AS host`,
        );
        return row.host;
    });
    // `--target ci`: the ambient URL, no production baseline row and no project
    // ref, and the script REFUSES outright if that URL looks like Supabase. The
    // production guard cannot be satisfied through this path even by accident.
    const guard = ["--target", "ci", "--yes", "--expect-db", db, "--expect-host", host];
    console.log(`\n=== ${label}: apply ===`);
    run("node", [SCRIPT, ...guard], { DATABASE_URL: url });
    // Idempotency is the property the deploy note rests on: it is safe to run
    // again after a partial failure, or twice by mistake.
    console.log(`\n=== ${label}: apply again (idempotency) ===`);
    run("node", [SCRIPT, ...guard], { DATABASE_URL: url });
}

/**
 * The shape, as facts a comparison can fail on: columns with their types and
 * defaults, plus index and constraint names.
 */
async function shapeOf(db) {
    return withClient(urlFor(db), async client => {
        const columns = await client.$queryRawUnsafe(
            `SELECT column_name, data_type, is_nullable, column_default
               FROM information_schema.columns
              WHERE table_schema='public' AND table_name='ReceiptIntake'
              ORDER BY column_name`,
        );
        const indexes = await client.$queryRawUnsafe(
            `SELECT indexname, indexdef FROM pg_indexes
              WHERE schemaname='public' AND tablename='ReceiptIntake'
              ORDER BY indexname`,
        );
        const constraints = await client.$queryRawUnsafe(
            `SELECT conname, pg_get_constraintdef(oid) AS def
               FROM pg_constraint
              WHERE conrelid = '"ReceiptIntake"'::regclass
              ORDER BY conname`,
        );
        return { columns, indexes, constraints };
    });
}

function assertSame(label, actual, expected) {
    const a = JSON.stringify(actual, null, 1);
    const b = JSON.stringify(expected, null, 1);
    if (a === b) {
        console.log(`  ${label}: matches the committed migration`);
        return;
    }
    console.error(`MISMATCH in ${label}`);
    console.error("--- the script produced ---");
    console.error(a);
    console.error("--- the migration produces ---");
    console.error(b);
    process.exit(1);
}

await recreate(FRESH_DB, UPGRADE_DB, REFERENCE_DB);

// The yardstick: every committed migration, including this feature's.
console.log("\n=== reference: prisma migrate deploy ===");
run("npx", ["prisma", "migrate", "deploy"], {
    DATABASE_URL: urlFor(REFERENCE_DB),
    DIRECT_URL: urlFor(REFERENCE_DB),
});
const reference = await shapeOf(REFERENCE_DB);

// 1. FROM SCRATCH: pre-Phase-1, then the script creates the table itself.
deployWithoutPhase1(urlFor(FRESH_DB));
await applyTwice(FRESH_DB, "from scratch");

// 2. THE UPGRADE: pre-Phase-1 PLUS a table an earlier revision of this script
//    left behind, with the old default. This is the only path that exercises
//    the additive section and the state-default repair.
deployWithoutPhase1(urlFor(UPGRADE_DB));
await withClient(urlFor(UPGRADE_DB), async client => {
    await client.$executeRawUnsafe(OLD_PHASE1_TABLE);
    const [before] = await client.$queryRawUnsafe(
        `SELECT column_default FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ReceiptIntake' AND column_name='state'`,
    );
    if (!String(before?.column_default ?? "").includes("RECEIVED")) {
        console.error("the drifted fixture did not take: expected DEFAULT 'RECEIVED'");
        process.exit(1);
    }
    console.log(`\ndrifted fixture in place: state default = ${before.column_default}`);
});
await applyTwice(UPGRADE_DB, "upgrade from the old shape");

await withClient(urlFor(UPGRADE_DB), async client => {
    const [after] = await client.$queryRawUnsafe(
        `SELECT column_default FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ReceiptIntake' AND column_name='state'`,
    );
    if (!String(after?.column_default ?? "").includes("STAGING")) {
        console.error(`the state default was NOT repaired: ${after?.column_default}`);
        process.exit(1);
    }
    console.log(`state default repaired: ${after.column_default}`);
    // ...and it is a real default, not just a catalogue entry.
    await client.$executeRawUnsafe(
        `INSERT INTO "ReceiptIntake"
           ("id", "source", "sourceRef", "storagePath", "mimeType", "fileSize", "fileSha256", "updatedAt")
         VALUES ('ci-probe', 'drive', 'drive:ci-probe', 'receipts/intake/ci-probe.png',
                 'image/png', 4, 'b', NOW())`,
    );
    const [row] = await client.$queryRawUnsafe(
        `SELECT state FROM "ReceiptIntake" WHERE id='ci-probe'`,
    );
    if (row?.state !== "STAGING") {
        console.error(`a row inserted with no state landed in ${row?.state}, not STAGING`);
        process.exit(1);
    }
    await client.$executeRawUnsafe(`DELETE FROM "ReceiptIntake" WHERE id='ci-probe'`);
});

console.log("\n=== comparing shapes against the committed migration ===");
for (const [db, label] of [[FRESH_DB, "from scratch"], [UPGRADE_DB, "upgrade"]]) {
    const shape = await shapeOf(db);
    assertSame(`${label}: columns`, shape.columns, reference.columns);
    assertSame(`${label}: indexes`, shape.indexes, reference.indexes);
    assertSame(`${label}: constraints`, shape.constraints, reference.constraints);
}

console.log("\napply script end-to-end: OK");
