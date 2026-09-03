// Additive schema for the deposit sweep
// (docs/plans/DEPOSIT-SWEEP-PLAN.md "Schema change"):
//
//   DepositIngest.source        null = the photo path, "bank" = the daily sweep
//   DepositIngest.bankReference the bank's stable per-deposit id (bank rows)
//   DepositIngest.postDate      bank: the CSV Post Date; photo: the checkDate
//   DepositIngest.amountCents   the deposit amount in cents, BOTH sources
//   PaymentNotification.suppressClientReceipt
//                               settle-time flag the outbox drainer reads, so a
//                               swept bank credit never emails the client a
//                               receipt for money no human has looked at
//
// postDate + amountCents are written for both sources so the cross-source
// claim check ("is the other path already working this same money?") is an
// indexed query in both directions; the two indexes below back it and the
// batch preflight.
//
// ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only — idempotent, no
// drops, safe to re-run and safe while the previous build is live (the old
// build simply ignores the new columns). Run BEFORE deploying the build that
// selects them, per CLAUDE.md "Schema migrations" (no `prisma db push` /
// `migrate dev` here — DIRECT_URL is IPv6-only from this machine). Then
// regenerate the client from PowerShell.
//
//   node scripts/apply-deposit-sweep-schema.mjs
//
// The identical DDL is checked in at
// prisma/migrations/20260902000000_deposit_sweep/migration.sql, which is what
// CI's throwaway database is built from. The partial unique index on
// "paymentScheduleId" is NOT touched here — it belongs to
// scripts/apply-deposit-ingest-schema.mjs, and `proposed` is deliberately
// outside its predicate (a proposed row holds no reservation).
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STATEMENTS = [
    `ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "source" TEXT`,
    `ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "bankReference" TEXT`,
    `ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "postDate" DATE`,
    `ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "amountCents" INTEGER`,
    `CREATE INDEX IF NOT EXISTS "DepositIngest_postDate_amountCents_idx" ON "DepositIngest"("postDate", "amountCents")`,
    `CREATE INDEX IF NOT EXISTS "DepositIngest_bankReference_idx" ON "DepositIngest"("bankReference")`,
    `ALTER TABLE "PaymentNotification" ADD COLUMN IF NOT EXISTS "suppressClientReceipt" BOOLEAN`,
];

export const EXPECTED_COLUMNS = ["source", "bankReference", "postDate", "amountCents"];
export const EXPECTED_INDEXES = ["DepositIngest_postDate_amountCents_idx", "DepositIngest_bankReference_idx"];

// Every side effect (dotenv, DATABASE_URL resolution, PrismaClient, DDL,
// verification, process.exit) lives in here and runs ONLY behind the
// main-module guard below, so importing this module to read its exported SQL
// never opens a connection or mutates anything — the 2026-09-02 incident where
// importing an apply script executed it against production.
async function main() {
    config({ path: join(__dirname, "..", ".env.production.local") });
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set (.env.production.local missing?).");
        process.exit(1);
    }

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
            console.log("ok:", sql.split("\n")[0].trim());
        }

        const cols = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'DepositIngest'`
        );
        const present = new Set(cols.map((c) => c.column_name));
        const missing = EXPECTED_COLUMNS.filter((name) => !present.has(name));
        console.log(
            `verified ${EXPECTED_COLUMNS.length - missing.length}/${EXPECTED_COLUMNS.length} DepositIngest columns present`,
            missing.length ? `— MISSING: ${missing.join(", ")}` : ""
        );
        if (missing.length) process.exit(1);

        const notifCol = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'PaymentNotification' AND column_name = 'suppressClientReceipt'`
        );
        console.log(`verified ${notifCol.length}/1 PaymentNotification.suppressClientReceipt present`);
        if (notifCol.length !== 1) process.exit(1);

        const idx = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE indexname IN
             ('DepositIngest_postDate_amountCents_idx', 'DepositIngest_bankReference_idx')`
        );
        console.log(`verified ${idx.length}/${EXPECTED_INDEXES.length} indexes present`);
        if (idx.length !== EXPECTED_INDEXES.length) process.exit(1);

        // The reservation index is the deposit path's single concurrency guard;
        // report (never create) it here so a run against a database that somehow
        // lacks it is visible rather than assumed.
        const reservation = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE indexname = 'DepositIngest_paymentScheduleId_reservation_key'`
        );
        console.log(
            reservation.length === 1
                ? "reservation partial unique index present (owned by apply-deposit-ingest-schema.mjs)"
                : "WARNING: the reservation partial unique index is MISSING — run scripts/apply-deposit-ingest-schema.mjs"
        );
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
