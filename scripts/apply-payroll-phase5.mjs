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
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "payType" TEXT`,
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
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "timeZone" TEXT`,
    // The exported CSVs, frozen at lock time. A locked period is served from
    // these verbatim rather than recomputed — the CSVs are built from mutable
    // inputs (name, email, payType, Gusto id mapping, a punch's project and
    // cost code after logistics recoding) and would not reproduce.
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "summaryCsvSnapshot" TEXT`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "detailCsvSnapshot" TEXT`,
    // Every payroll read is a startTime RANGE scan; no FK index serves that.
    `CREATE INDEX IF NOT EXISTS "TimeEntry_startTime_idx" ON "TimeEntry"("startTime")`,
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
    // NO endTime backfill — see the note in the matching migration. Synthesising
    // a span for a manual entry makes WA meal settlement treat PAID hours as a
    // RAW span, deduct a meal it never owed, and reprice it at the member's
    // current rate. The readers were fixed instead.

    // ONE-SHOT seed for User.payType from the env list, so the export is not
    // blocked on day one by a column nobody has filled in yet. Only touches
    // rows still NULL, so a re-run never overwrites a human's answer — after
    // this, the COLUMN is the source of truth and the env list is a fallback.
    const salaried = (process.env.PAYROLL_SALARIED_EMAILS ?? "cj@goldentouchremodeling.com,rlord@goldentouchremodeling.com")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
    if (salaried.length) {
        const seededSalary = await prisma.$executeRawUnsafe(
            `UPDATE "User" SET "payType" = 'SALARY' WHERE "payType" IS NULL AND lower("email") = ANY($1::text[])`,
            salaried
        );
        console.log(`seeded ${seededSalary} user(s) to payType = SALARY from PAYROLL_SALARIED_EMAILS`);
    }
    // Everyone else who is an ACTIVATED crew/manager account is hourly. ADMIN
    // and FINANCE are left NULL deliberately: they are salaried by role for the
    // rate guard, but the export only demands an answer for people who actually
    // punched, and a human should confirm rather than a script assuming.
    const seededHourly = await prisma.$executeRawUnsafe(
        `UPDATE "User" SET "payType" = 'HOURLY'
         WHERE "payType" IS NULL AND "status" = 'ACTIVATED' AND "role" IN ('FIELD_CREW', 'EMPLOYEE', 'MANAGER')`
    );
    console.log(`seeded ${seededHourly} user(s) to payType = HOURLY`);

    const cols = await prisma.$queryRawUnsafe(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'User' AND column_name IN ('lastRateSyncAt','payType'))
            OR (table_name = 'PayrollPeriod' AND column_name IN ('id','periodStart','periodEnd','lockedAt','lockedById','exportHash','createdAt'))`
    );
    console.log(`verified ${cols.length}/9 columns present`);
    if (cols.length !== 9) process.exit(1);
} finally {
    await prisma.$disconnect();
}
