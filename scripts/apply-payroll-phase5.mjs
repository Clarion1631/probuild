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
    // Stable identity — see the matching migration.
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodStartKey" TEXT`,
    `ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodEndKey" TEXT`,
    `UPDATE "PayrollPeriod"
     SET "periodStartKey" = to_char("periodStart" AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD'),
         "periodEndKey"   = to_char("periodEnd"   AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD')
     WHERE "periodStartKey" IS NULL OR "periodEndKey" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStartKey_periodEndKey_key" ON "PayrollPeriod"("periodStartKey", "periodEndKey")`,
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
    // ---- Integrity + RLS (review round 5, items 7 and 9) ----------------
    // CHECKs because payType and the period bounds are money-critical and
    // reachable from several code paths; Prisma cannot see them, so they are
    // also recorded in prisma/prisma-blind-spots.json.
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_payType_check' AND conrelid = '"User"'::regclass) THEN
            ALTER TABLE "User" ADD CONSTRAINT "User_payType_check" CHECK ("payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY'));
        END IF;
     END $$`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_range_check' AND conrelid = '"PayrollPeriod"'::regclass) THEN
            ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_range_check" CHECK ("periodEnd" > "periodStart");
        END IF;
     END $$`,
    // NOT VALID: new rows must carry the stable keys, legacy rows are backfilled
    // above and never fail the migration.
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_keys_present' AND conrelid = '"PayrollPeriod"'::regclass) THEN
            ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_keys_present" CHECK ("periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL) NOT VALID;
        END IF;
     END $$`,
    // The key backfill above filled every legacy row, so validate it: a
    // permanently NOT VALID constraint has never checked anything, and it is a
    // real difference from production. VALIDATE takes only SHARE UPDATE
    // EXCLUSIVE, so it blocks neither reads nor writes.
    `ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_keys_present"`,
    // A leaked anon/authenticated Supabase key must not read payroll periods,
    // their frozen CSVs, or the pay columns on User. Prisma connects as the
    // table OWNER and owners bypass RLS, so the app is unaffected; the Supabase
    // client here is storage-only (CLAUDE.md), so nothing reads these through
    // the Data API.
    `ALTER TABLE "PayrollPeriod" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "User" ENABLE ROW LEVEL SECURITY`,
    // The Supabase roles do not exist on a vanilla Postgres and REVOKE on a
    // missing role is a hard error — guarded so CI's throwaway DB runs the same
    // statements.
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "PayrollPeriod" FROM anon;
            REVOKE ALL ON TABLE "User" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "PayrollPeriod" FROM authenticated;
            REVOKE ALL ON TABLE "User" FROM authenticated;
        END IF;
     END $$`,
    // ---- Help-widget throttle + idempotency (round 6, item 6) -----------
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "submissionId" TEXT`,
    // Whether the GitHub issue exists yet — `status` could not tell "never
    // tried" from "tried and finished".
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerIssueRef" TEXT`,
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerState" TEXT DEFAULT 'pending'`,
    // CAS lease over the provider call — see the matching migration.
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseToken" TEXT`,
    `ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseExpiresAt" TIMESTAMPTZ(6)`,
    // Unique PER USER — a global key would collide across users and hand back
    // somebody else's report.
    `CREATE UNIQUE INDEX IF NOT EXISTS "HelpRequest_userId_submissionId_key" ON "HelpRequest"("userId", "submissionId")`,
    `CREATE INDEX IF NOT EXISTS "HelpRequest_userId_createdAt_idx" ON "HelpRequest"("userId", "createdAt")`,
    `CREATE TABLE IF NOT EXISTS "HelpSubmissionQuota" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "hourBucket" TIMESTAMPTZ(6) NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "HelpSubmissionQuota_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "HelpSubmissionQuota_userId_hourBucket_key" ON "HelpSubmissionQuota"("userId", "hourBucket")`,
    `ALTER TABLE "HelpSubmissionQuota" ENABLE ROW LEVEL SECURITY`,
    `DO $$
     BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM authenticated;
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

    // User.payType is left NULL for anyone nobody has confirmed.
    //
    // An earlier revision also stamped every ACTIVATED crew member and manager
    // as HOURLY. That defeated the whole point of the column: stored values beat
    // the env fallback, so a salaried manager omitted from
    // PAYROLL_SALARIED_EMAILS would have been permanently marked hourly, and
    // later fixing the env var would have changed nothing — Gusto would pay them
    // a salary AND the exported hours. NULL blocks the export until a human
    // answers on Company -> Team Members, which is the fail-closed behaviour the
    // column exists for.
    //
    // The SALARY seed below is kept because it only ever moves a row in the SAFE
    // direction (excluded from the summary = cannot be double-paid) and only for
    // emails an operator explicitly listed. It never overwrites an existing
    // answer.
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
    const unconfirmed = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "User" WHERE "payType" IS NULL AND "status" = 'ACTIVATED'`
    );
    console.log(
        `${unconfirmed[0].n} activated user(s) still have no payType — the payroll export will refuse to run for anyone with hours until they are set on Company -> Team Members. This is intentional.`
    );

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
