// Additive schema for Phase 5 payroll
// (docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md sections 2 and 3):
//
//   User.lastRateSyncAt   Last time this member's pay rate was CONFIRMED (via
//                         the Gusto CSV rate import or a manual edit on
//                         Company -> Team Members). Null = never confirmed.
//   PayrollPeriod         A reviewed/exported pay period, half-open
//                         [periodStart, periodEnd). lockedAt freezes every
//                         time entry whose startTime falls inside it.
//
// ADD COLUMN / CREATE TABLE IF NOT EXISTS only — idempotent, no drops, safe
// while the previous build is live (the old build ignores both). Run BEFORE
// deploying the build that reads them, per CLAUDE.md "Schema migrations" (no
// `prisma db push` / `migrate dev` here — DIRECT_URL is IPv6-only). Then
// regenerate the client from PowerShell.
//   node scripts/apply-payroll-phase5.mjs
//
// Kept statement-for-statement in sync with
// prisma/migrations/20260901000000_payroll_phase5/migration.sql.
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.production.local") });
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env.production.local missing?).");
    process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const STATEMENTS = [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRateSyncAt" TIMESTAMPTZ(6)`,
    `CREATE TABLE IF NOT EXISTS "PayrollPeriod" (
        "id" TEXT NOT NULL,
        "periodStart" TIMESTAMPTZ(6) NOT NULL,
        "periodEnd" TIMESTAMPTZ(6) NOT NULL,
        "lockedAt" TIMESTAMPTZ(6),
        "lockedById" TEXT,
        "exportHash" TEXT,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStart_periodEnd_key" ON "PayrollPeriod"("periodStart", "periodEnd")`,
    `CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedAt_idx" ON "PayrollPeriod"("lockedAt")`,
    `CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedById_idx" ON "PayrollPeriod"("lockedById")`,
    // ADD CONSTRAINT has no IF NOT EXISTS — guard it so a replay is a no-op.
    `DO $$
     BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_lockedById_fkey') THEN
            ALTER TABLE "PayrollPeriod"
                ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
                FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
     END $$`,
];

try {
    for (const sql of STATEMENTS) {
        await prisma.$executeRawUnsafe(sql);
        console.log("ok:", sql.split("\n")[0].trim().slice(0, 90));
    }
    const cols = await prisma.$queryRawUnsafe(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'User' AND column_name = 'lastRateSyncAt')
            OR (table_name = 'PayrollPeriod' AND column_name IN ('id','periodStart','periodEnd','lockedAt','lockedById','exportHash','createdAt'))`
    );
    console.log(`verified ${cols.length}/8 columns present`);
    if (cols.length !== 8) process.exit(1);
} finally {
    await prisma.$disconnect();
}
