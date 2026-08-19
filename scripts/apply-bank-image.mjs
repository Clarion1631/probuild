// One-off additive migration for BankImage (docs/BANK-REGISTER-PLAN.md
// "Phase 3 — BankImage ingest"): the check and deposit images pulled from
// Washington Trust Bank, so a bare "CHECK PAID" or "DEPOSIT - DDA/MMKT"
// ledger line can be named by a human or matched to a milestone.
//
// WHY THIS EXISTS (2026-08-19): the ledger holds a $6,037.15 check with no
// payee and a $15,723.38 deposit that matches no milestone. Neither can be
// explained from the CSV — the bank's export carries an empty Image column.
// The image is the only evidence that names them.
//
// Shape follows the plan's hard requirements verbatim:
//   {id, source, sourceExternalId (unique WITH source — the idempotency
//    key), kind, capturedAt, documentDate?, driveFileId unique, fileName,
//    mime, normalizedCheckNumber?, amountCents?, createdAt, updatedAt}
//   + indexes (kind, capturedAt) and (kind, normalizedCheckNumber)
//   + a SEPARATE confirmed-match link table {qbType, qbTxnId, confirmedBy,
//     at} so an automated guess is never mistaken for a human decision.
//
// Additive and idempotent: pure CREATE TABLE IF NOT EXISTS plus guarded
// index/constraint adds, safe to re-run. No existing table is touched.
//
//   node scripts/apply-bank-image.mjs --yes --expect-db <name> --expect-host <host>
//
// --expect-db and --expect-host are BOTH required alongside --yes, matching
// scripts/apply-bank-ledger.mjs: "--yes" alone only proves you meant to run
// something, and a database NAME alone doesn't prove which SERVER it's on.
//
// Apply BEFORE deploying any build that selects these tables (P2022).
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
 * Pure comparison, exported for unit testing without a live DB (mirrors
 * apply-bank-ledger.mjs). Compares BOTH database name and server host.
 */
export function targetMatches(actual, expectDb, expectHost) {
    if (!actual || typeof actual !== "object") return false;
    if (String(actual.db ?? "") !== String(expectDb ?? "")) return false;
    const host = String(actual.host ?? "");
    const wanted = String(expectHost ?? "");
    if (host === wanted) return true;
    // A pooled Supabase host resolves to an IP; accept either the literal
    // host string or an address that the operator typed instead.
    return host !== "" && wanted !== "" && (host.includes(wanted) || wanted.includes(host));
}

/** kind values the ingest is allowed to store. */
export const BANK_IMAGE_KINDS = ["CHECK_FRONT", "CHECK_BACK", "DEPOSIT_SLIP", "DEPOSIT_PHOTO"];

const statements = [
    `CREATE TABLE IF NOT EXISTS "BankImage" (
       "id"                    TEXT NOT NULL,
       "source"                TEXT NOT NULL,
       "sourceExternalId"      TEXT NOT NULL,
       "kind"                  TEXT NOT NULL,
       "account"               TEXT NOT NULL,
       "capturedAt"            TIMESTAMPTZ(6) NOT NULL,
       "documentDate"          DATE,
       "driveFileId"           TEXT,
       "fileName"              TEXT NOT NULL,
       "mime"                  TEXT NOT NULL,
       "byteSize"              INTEGER,
       "normalizedCheckNumber" TEXT,
       "amountCents"           INTEGER,
       "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
       "updatedAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
       CONSTRAINT "BankImage_pkey" PRIMARY KEY ("id")
     )`,

    // Idempotency: one row per (source, sourceExternalId). Re-pulling the
    // same check from the bank is a no-op, exactly like the statement
    // ingest's content hash.
    `CREATE UNIQUE INDEX IF NOT EXISTS "BankImage_source_sourceExternalId_key"
       ON "BankImage" ("source", "sourceExternalId")`,

    // A Drive file backs at most one image row.
    `CREATE UNIQUE INDEX IF NOT EXISTS "BankImage_driveFileId_key"
       ON "BankImage" ("driveFileId") WHERE "driveFileId" IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS "BankImage_kind_capturedAt_idx"
       ON "BankImage" ("kind", "capturedAt")`,

    `CREATE INDEX IF NOT EXISTS "BankImage_kind_normalizedCheckNumber_idx"
       ON "BankImage" ("kind", "normalizedCheckNumber")`,

    `CREATE INDEX IF NOT EXISTS "BankImage_account_documentDate_idx"
       ON "BankImage" ("account", "documentDate")`,

    // kind is a closed set — a typo must fail loudly rather than create a
    // silent third category nothing queries.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_kind_check') THEN
         ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_kind_check"
           CHECK ("kind" IN ('CHECK_FRONT','CHECK_BACK','DEPOSIT_SLIP','DEPOSIT_PHOTO'));
       END IF;
     END $$`,

    // Amount, when present, is integer cents and never negative: an image is
    // evidence of a document, not a signed ledger movement.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_amountCents_check') THEN
         ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_amountCents_check"
           CHECK ("amountCents" IS NULL OR "amountCents" >= 0);
       END IF;
     END $$`,

    // A check image must carry a check number; a deposit image must not
    // pretend to have one. Keeps the matcher's inputs honest.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImage_check_number_shape') THEN
         ALTER TABLE "BankImage" ADD CONSTRAINT "BankImage_check_number_shape"
           CHECK (
             ("kind" IN ('CHECK_FRONT','CHECK_BACK') AND "normalizedCheckNumber" IS NOT NULL)
             OR ("kind" IN ('DEPOSIT_SLIP','DEPOSIT_PHOTO') AND "normalizedCheckNumber" IS NULL)
           );
       END IF;
     END $$`,

    // ── Confirmed matches ────────────────────────────────────────────────
    // DELIBERATELY SEPARATE from BankImage. An automated candidate (same
    // check number + date + amount) is a suggestion; a row here means a
    // HUMAN said yes. Never write this from a matcher.
    `CREATE TABLE IF NOT EXISTS "BankImageMatch" (
       "id"           TEXT NOT NULL,
       "bankImageId"  TEXT NOT NULL,
       "bankLineId"   TEXT,
       "qbType"       TEXT,
       "qbTxnId"      TEXT,
       "confirmedBy"  TEXT NOT NULL,
       "confirmedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
       "note"         TEXT,
       CONSTRAINT "BankImageMatch_pkey" PRIMARY KEY ("id")
     )`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImageMatch_bankImageId_fkey') THEN
         ALTER TABLE "BankImageMatch" ADD CONSTRAINT "BankImageMatch_bankImageId_fkey"
           FOREIGN KEY ("bankImageId") REFERENCES "BankImage"("id")
           ON DELETE RESTRICT ON UPDATE CASCADE;
       END IF;
     END $$`,

    // Restrict, not Cascade: deleting a bank line must not silently erase a
    // human's confirmation. Same policy as BankLineObservation.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImageMatch_bankLineId_fkey') THEN
         ALTER TABLE "BankImageMatch" ADD CONSTRAINT "BankImageMatch_bankLineId_fkey"
           FOREIGN KEY ("bankLineId") REFERENCES "BankLine"("id")
           ON DELETE RESTRICT ON UPDATE CASCADE;
       END IF;
     END $$`,

    // One confirmed match per image — a second one means somebody disagreed
    // and that must be resolved, not stacked.
    `CREATE UNIQUE INDEX IF NOT EXISTS "BankImageMatch_bankImageId_key"
       ON "BankImageMatch" ("bankImageId")`,

    `CREATE INDEX IF NOT EXISTS "BankImageMatch_bankLineId_idx"
       ON "BankImageMatch" ("bankLineId")`,

    // A match must point at SOMETHING.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankImageMatch_target_present') THEN
         ALTER TABLE "BankImageMatch" ADD CONSTRAINT "BankImageMatch_target_present"
           CHECK ("bankLineId" IS NOT NULL OR "qbTxnId" IS NOT NULL);
       END IF;
     END $$`,
];

const expectedColumns = {
    BankImage: [
        "id", "source", "sourceExternalId", "kind", "account", "capturedAt",
        "documentDate", "driveFileId", "fileName", "mime", "byteSize",
        "normalizedCheckNumber", "amountCents", "createdAt", "updatedAt",
    ],
    BankImageMatch: [
        "id", "bankImageId", "bankLineId", "qbType", "qbTxnId",
        "confirmedBy", "confirmedAt", "note",
    ],
};

const expectedConstraints = [
    { name: "BankImage_kind_check", table: "BankImage" },
    { name: "BankImage_amountCents_check", table: "BankImage" },
    { name: "BankImage_check_number_shape", table: "BankImage" },
    { name: "BankImageMatch_bankImageId_fkey", table: "BankImageMatch" },
    { name: "BankImageMatch_bankLineId_fkey", table: "BankImageMatch" },
    { name: "BankImageMatch_target_present", table: "BankImageMatch" },
];

async function main() {
    if (!process.argv.includes("--yes")) {
        console.error("Refusing to run without --yes (and --expect-db / --expect-host).");
        process.exit(1);
    }
    const expectDb = readFlagValue("--expect-db") ?? process.env.BANK_LEDGER_EXPECT_DB;
    const expectHost = readFlagValue("--expect-host") ?? process.env.BANK_LEDGER_EXPECT_HOST;
    if (!expectDb || !expectHost) {
        console.error("Both --expect-db and --expect-host are required (or BANK_LEDGER_EXPECT_DB / BANK_LEDGER_EXPECT_HOST).");
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
        console.log("\nBankImage migration applied and verified.");
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
