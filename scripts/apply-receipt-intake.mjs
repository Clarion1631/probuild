// One-off additive migration for ReceiptIntake (Receipt Pipeline v2, Phase 1 —
// docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §2): the single intake row for one
// inbound receipt/check document, from every source (mobile capture, the Apps
// Script Drive/email/chat forwarders, the web uploader).
//
// The SQL here is byte-equivalent to
// prisma/migrations/20260901000000_receipt_intake/migration.sql — that file is
// what a fresh CI/dev database gets; this script is what production gets,
// BEFORE the build that selects these columns deploys (CLAUDE.md pre-deploy
// rule #2 — otherwise every page touching them throws P2022).
//
// Two objects are invisible to Prisma and must be created here, not by the
// generator:
//   * CHECK ("state" IN (...)) — Prisma has no check-constraint concept.
//   * the PARTIAL unique index on "dedupStrongKey" — Prisma's diff engine drops
//     partial indexes without comment. It is not an optimisation: it IS the
//     strong-dedup claim. The reader writes the keys and reads a unique
//     violation as "another live row already owns this purchase", which is what
//     replaces the Apps Script's Script-Properties lock.
//
// Additive and idempotent: CREATE TABLE / INDEX IF NOT EXISTS plus guarded
// constraint adds. Safe to re-run; a second run reports every statement "ok"
// and changes nothing. No existing table is touched.
//
//   node scripts/apply-receipt-intake.mjs --yes --expect-db <name> --expect-host <host>
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-bank-image.mjs: "--yes" alone only proves you meant to run
// something, and a database NAME alone doesn't prove which SERVER it's on.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveDatabaseUrl() {
    if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process.env.DATABASE_URL" };
    for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
        if (match) return { url: match[1], from: file };
    }
    throw new Error("DATABASE_URL not found in process.env, .env.local, or .env");
}

export function maskUrl(url) {
    return url.replace(/:[^:@]*@/, ":****@");
}

function readFlagValue(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/**
 * Pure comparison, exported for unit testing without a live DB. Compares BOTH
 * database name and server host, and both EXACTLY.
 *
 * apply-bank-image.mjs accepts a substring match on the host "because a pooled
 * Supabase host resolves to an IP". That is a guard which gets LOOSER the
 * shorter the operator's input is: `--expect-host 1` satisfies `host.includes`
 * against 10.0.0.5, 172.16.1.1, and almost anything else. A guard whose whole
 * job is to stop DDL landing on the wrong server must not have a degenerate
 * case, so this one is exact. Print `host(inet_server_addr())` (the script logs
 * it before refusing) and pass that value.
 */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    return String(actual.host ?? "") === String(expectHost ?? "");
}

/** The closed set of states the CHECK constraint allows. Exported for tests. */
export const RECEIPT_INTAKE_STATES = [
    "STAGING", "RECEIVED", "READ", "NEEDS_JOB", "NEEDS_REVIEW", "BOOKING",
    "BOOKED", "ARCHIVED", "DUPLICATE", "VOID", "NON_RECEIPT",
    // Received during the shadow week, therefore booked by v1 and NEVER by v2.
    "SHADOW_DONE",
];

export const statements = [
    `CREATE TABLE IF NOT EXISTS "ReceiptIntake" (
       "id"                  TEXT NOT NULL,
       "source"              TEXT NOT NULL,
       "sourceRef"           TEXT NOT NULL,
       "state"               TEXT NOT NULL DEFAULT 'STAGING',
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
       "busyPasses"          INTEGER NOT NULL DEFAULT 0,
       "lastError"           TEXT,
       "nextRetryAt"         TIMESTAMP(3),
       "bookedAt"            TIMESTAMP(3),
       "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"           TIMESTAMP(3) NOT NULL,
       CONSTRAINT "ReceiptIntake_pkey" PRIMARY KEY ("id")
     )`,

    // Additive upgrade for a table created by an EARLIER run of this script,
    // before busyPasses existed: CREATE TABLE IF NOT EXISTS is a no-op on an
    // existing table, so a column added to the CREATE above would never reach
    // it. This is the whole reason the script is re-runnable.
    `ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "busyPasses" INTEGER NOT NULL DEFAULT 0`,

    // Intake idempotency: one row per caller-supplied sourceRef. A forwarder
    // replaying the same Drive file / Gmail message is a no-op.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_sourceRef_key"
       ON "ReceiptIntake"("sourceRef")`,

    // One intake row per booked Expense.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_expenseId_key"
       ON "ReceiptIntake"("expenseId")`,

    // THE STRONG-DEDUP CLAIM (partial — Prisma cannot express this). Quarantined
    // rows (DUPLICATE) and voided ones drop out of the index so the surviving
    // original keeps the key.
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_dedupStrongKey_active_key"
       ON "ReceiptIntake"("dedupStrongKey")
       WHERE "dedupStrongKey" IS NOT NULL AND "state" NOT IN ('DUPLICATE', 'VOID')`,

    // The worker's claim query: state + due time.
    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_state_nextRetryAt_idx"
       ON "ReceiptIntake"("state", "nextRetryAt")`,

    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_projectId_idx"
       ON "ReceiptIntake"("projectId")`,

    // The weak-dedup net is a plain lookup, never a claim.
    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_dedupWeakKey_idx"
       ON "ReceiptIntake"("dedupWeakKey")`,

    `CREATE INDEX IF NOT EXISTS "ReceiptIntake_createdAt_idx"
       ON "ReceiptIntake"("createdAt")`,

    // state is a closed set — a typo must fail loudly rather than create a
    // silent eleventh state that no query ever selects.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_state_check'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
           CHECK ("state" IN ('STAGING', 'RECEIVED', 'READ', 'NEEDS_JOB', 'NEEDS_REVIEW', 'BOOKING',
                              'BOOKED', 'ARCHIVED', 'DUPLICATE', 'VOID', 'NON_RECEIPT',
                              'SHADOW_DONE'));
       END IF;
     END $$`,

    // SET NULL on every parent: losing a project, cost code, user, or expense
    // must never delete the audit trail of a document that was already booked.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_projectId_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_projectId_fkey"
           FOREIGN KEY ("projectId") REFERENCES "Project"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_costCodeId_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_costCodeId_fkey"
           FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_createdById_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_createdById_fkey"
           FOREIGN KEY ("createdById") REFERENCES "User"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,

    // RLS, matching every other sensitive table in this schema
    // (apply-bank-ledger.mjs, apply-automation-events.mjs,
    // apply-deposit-ingest-schema.mjs). ENABLE with no policies and WITHOUT
    // FORCE: the app connects as the owner/service role, which bypasses RLS, so
    // reads and writes are unaffected — while anon and authenticated roles
    // (a leaked anon key, a Supabase client someone wires up later) get nothing.
    // FORCE would deny the owner too and take the pipeline down.
    // ReceiptIntake holds vendor names, amounts and storage paths for real
    // purchases, so it belongs in the same class as BankLine.
    `ALTER TABLE "ReceiptIntake" ENABLE ROW LEVEL SECURITY`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'ReceiptIntake_expenseId_fkey'
                         AND conrelid = '"ReceiptIntake"'::regclass) THEN
         ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_expenseId_fkey"
           FOREIGN KEY ("expenseId") REFERENCES "Expense"("id")
           ON DELETE SET NULL ON UPDATE CASCADE;
       END IF;
     END $$`,
];

const expectedColumns = {
    ReceiptIntake: [
        "id", "source", "sourceRef", "state", "dryRun", "stateReason",
        "projectId", "costCodeId", "suggestedCostCodeId", "suggestedConfidence",
        "createdById", "storagePath", "fileName", "mimeType", "fileSize",
        "fileSha256", "vendor", "txnDate", "totalCents", "taxCents", "docType",
        "refNumber", "memo", "readJson", "readAt", "dedupStrongKey",
        "dedupWeakKey", "duplicateOfId", "qbPurchaseId", "expenseId",
        "archiveDriveFileId", "attempts", "busyPasses", "lastError", "nextRetryAt",
        "bookedAt", "createdAt", "updatedAt",
    ],
};

const expectedConstraints = [
    { name: "ReceiptIntake_state_check", table: "ReceiptIntake" },
    { name: "ReceiptIntake_projectId_fkey", table: "ReceiptIntake" },
    { name: "ReceiptIntake_costCodeId_fkey", table: "ReceiptIntake" },
    { name: "ReceiptIntake_createdById_fkey", table: "ReceiptIntake" },
    { name: "ReceiptIntake_expenseId_fkey", table: "ReceiptIntake" },
];

// The partial index is the one object a "table exists" check cannot vouch for
// (Prisma would have created the table on its own; it would never create this).
// Verified on three properties, because any one of them alone can pass while
// the index is useless: it must EXIST, be UNIQUE (a non-unique index claims
// nothing, so every duplicate would sail through), and carry the EXACT
// predicate (a wider one quarantines rows that were deliberately excluded; a
// narrower one stops quarantining real duplicates).
const expectedPartialIndexes = [{
    name: "ReceiptIntake_dedupStrongKey_active_key",
    mustMatch: [
        /CREATE UNIQUE INDEX/,
        /\("dedupStrongKey"\)/,
        /WHERE \(\("dedupStrongKey" IS NOT NULL\) AND \(state <> ALL \(ARRAY\['DUPLICATE'::text, 'VOID'::text\]\)\)\)/,
    ],
}];

async function main() {
    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.RECEIPT_INTAKE_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.RECEIPT_INTAKE_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or RECEIPT_INTAKE_EXPECT_DB / RECEIPT_INTAKE_EXPECT_HOST).");
        process.exit(1);
    }

    const { url, from } = resolveDatabaseUrl();
    console.log(`DATABASE_URL from ${from}: ${maskUrl(url)}`);
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const [actual] = await prisma.$queryRawUnsafe(
            `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), '') AS host`,
        );
        console.log(`connected to db="${actual.db}" host="${actual.host}"`);
        if (!targetMatches(actual, expectDb, expectHost)) {
            console.error(`REFUSING: expected db="${expectDb}" host="${expectHost}" but connected to db="${actual.db}" host="${actual.host}".`);
            process.exit(1);
        }

        for (const sql of statements) {
            const label = sql.replace(/\s+/g, " ").slice(0, 84);
            process.stdout.write(`  ${label} ... `);
            await prisma.$executeRawUnsafe(sql);
            console.log("ok");
        }

        // Verify shape rather than trusting the run.
        for (const [table, columns] of Object.entries(expectedColumns)) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
                table,
            );
            const found = new Set(rows.map(r => r.column_name));
            const missing = columns.filter(c => !found.has(c));
            if (missing.length) {
                console.error(`VERIFY FAILED: ${table} missing columns: ${missing.join(", ")}`);
                process.exit(1);
            }
            console.log(`verified ${table}: ${columns.length} columns`);
        }
        for (const { name, table } of expectedConstraints) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT 1 AS ok FROM pg_constraint WHERE conname = $1`, name,
            );
            if (!row) {
                console.error(`VERIFY FAILED: constraint ${name} missing on ${table}`);
                process.exit(1);
            }
        }
        console.log(`verified ${expectedConstraints.length} constraints`);

        // indpred IS NOT NULL is the whole point: a plain unique index of the
        // same name would silently quarantine nothing and reject legitimate
        // re-reads, so assert the DEFINITION, not just the name.
        for (const { name, mustMatch } of expectedPartialIndexes) {
            const [row] = await prisma.$queryRawUnsafe(
                `SELECT pg_get_indexdef(i.indexrelid) AS def
                   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relnamespace = 'public'::regnamespace
                    AND i.indpred IS NOT NULL AND c.relname = $1`,
                name,
            );
            if (!row) {
                console.error(`VERIFY FAILED: PARTIAL index ${name} missing (a non-partial index of that name is NOT the same thing)`);
                process.exit(1);
            }
            for (const pattern of mustMatch) {
                if (!pattern.test(row.def)) {
                    console.error(`VERIFY FAILED: ${name} does not match ${pattern}\n  actual: ${row.def}`);
                    process.exit(1);
                }
            }
            console.log(`verified partial index ${name}: ${row.def}`);
        }

        console.log("\nReceiptIntake migration applied and verified.");
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
