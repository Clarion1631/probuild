// Replay identity for the deposit sweep
// (docs/plans/DEPOSIT-SWEEP-PLAN.md):
//
//   DepositIngest.bankFingerprint  normalised identity of the bank credit this
//                                  row was created from
//                                  (postDate|amountCents|baiCode|description|
//                                  transactionDetail)
//
// A bank credit's fileId is "bank:<reference>". That is an idempotency key
// only while the reference means the same money every time; if the bank ever
// reuses one for a different credit, the sweep would silently treat the new
// money as a replay of the old. The fingerprint turns that into a visible
// `reconcile` instead.
//
// ADD COLUMN IF NOT EXISTS only — idempotent, no drops, safe to re-run and
// safe while the previous build is live. Run BEFORE deploying the build that
// selects it, per CLAUDE.md "Schema migrations" (no `prisma db push` /
// `migrate dev` here — DIRECT_URL is IPv6-only from this machine). Then
// regenerate the client from PowerShell.
//
//   node scripts/apply-deposit-sweep-fingerprint.mjs
//
// The identical DDL is checked in at
// prisma/migrations/20260903000000_deposit_sweep_fingerprint/migration.sql,
// which is what CI's throwaway database is built from.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STATEMENTS = [
    `ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "bankFingerprint" TEXT`,
];

export const EXPECTED_COLUMNS = ["bankFingerprint"];

// Every side effect lives in here and runs ONLY behind the main-module guard
// below, so importing this module to read its exported SQL never opens a
// connection or mutates anything (the 2026-09-02 incident).
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
            `verified ${EXPECTED_COLUMNS.length - missing.length}/${EXPECTED_COLUMNS.length} column(s) present`,
            missing.length ? `— MISSING: ${missing.join(", ")}` : ""
        );
        if (missing.length) process.exit(1);
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
