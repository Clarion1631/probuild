-- Phase 5 payroll schema (docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md
-- sections 2 and 3). Additive and idempotent — safe to replay and safe to run
-- while the previous build is live. Mirrors scripts/apply-payroll-phase5.mjs
-- statement for statement.

-- AlterTable: last time a member's pay rate was confirmed (import or manual edit).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRateSyncAt" TIMESTAMPTZ(6);

-- AlterTable: how Gusto pays this member ("HOURLY" | "SALARY"). Nullable on
-- purpose — NULL means unanswered, which the payroll export refuses to guess.
-- The backfill from PAYROLL_SALARIED_EMAILS lives in the apply script, where
-- the env value is readable; it is a ONE-SHOT seed, not the ongoing source.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "payType" TEXT;

-- CreateTable: reviewed/exported pay periods. Half-open [periodStart, periodEnd).
CREATE TABLE IF NOT EXISTS "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "lockedAt" TIMESTAMPTZ(6),
    "lockedById" TEXT,
    "exportHash" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStart_periodEnd_key" ON "PayrollPeriod"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedAt_idx" ON "PayrollPeriod"("lockedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollPeriod_lockedById_idx" ON "PayrollPeriod"("lockedById");

-- AlterTable: the IANA zone the period was locked in. Enforcement reads it back
-- so a later CompanySettings.timeZone change cannot move the workweek envelope
-- of a period that was already paid.
ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "timeZone" TEXT;

-- AlterTable: the exported CSVs, frozen at lock time. A locked period is served
-- from these verbatim rather than recomputed, because the CSVs are built from
-- mutable inputs (name, email, payType, Gusto id mapping, a punch's project and
-- cost code) and would not reproduce. Unlock clears them.
ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "summaryCsvSnapshot" TEXT;

-- AlterTable: STABLE IDENTITY. The timestamps are derived from company-local
-- calendar days, so they move if the company time zone changes and an exact
-- timestamp lookup then misses its own locked row. Periods are identified by
-- these keys; the timestamps stay for range/overlap queries.
ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodStartKey" TEXT;
ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "periodEndKey" TEXT;

-- Backfill from the timestamps, in the zone each row was locked in (falling
-- back to the company default for rows written before timeZone existed).
UPDATE "PayrollPeriod"
SET "periodStartKey" = to_char("periodStart" AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD'),
    "periodEndKey"   = to_char("periodEnd"   AT TIME ZONE COALESCE("timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD')
WHERE "periodStartKey" IS NULL OR "periodEndKey" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollPeriod_periodStartKey_periodEndKey_key" ON "PayrollPeriod"("periodStartKey", "periodEndKey");
ALTER TABLE "PayrollPeriod" ADD COLUMN IF NOT EXISTS "detailCsvSnapshot" TEXT;

-- CreateIndex: every payroll read is a startTime RANGE scan (whole workweeks
-- for the export, a period for the lock check and the settlement planner) and
-- none of TimeEntry's FK indexes serve a bare range predicate.
CREATE INDEX IF NOT EXISTS "TimeEntry_startTime_idx" ON "TimeEntry"("startTime");

-- NOTE — no endTime backfill here, deliberately.
--
-- An earlier revision synthesised endTime = startTime + durationHours for
-- manual entries so that "is this punch open?" readers stopped mistaking a
-- completed manual entry for an open one. That was the wrong fix: WA meal
-- settlement (src/lib/wa-breaks.ts settleDayPlan) reads endTime - startTime as
-- the RAW worked span, so a synthesised span makes an 8h manual entry look like
-- an 8h shift that owes a 30-minute meal, and re-persists it as 7.5 paid hours
-- repriced at the member's CURRENT rate. That silently rewrites historical pay.
--
-- durationHours on a manual entry is PAID hours that a human entered directly;
-- there is no span to deduct from. The readers were fixed instead: "open" now
-- means endTime IS NULL *and* durationHours IS NULL (see
-- src/lib/gusto-export-core.ts blockingEntries).

-- AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS on Postgres 15).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_lockedById_fkey'
    ) THEN
        ALTER TABLE "PayrollPeriod"
            ADD CONSTRAINT "PayrollPeriod_lockedById_fkey"
            FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Integrity constraints + RLS (Phase 5 review round 5, items 7 and 9).
--
-- CHECK constraints, not just application validation: payType and the period
-- bounds are money-critical, every one of them is reachable from more than one
-- code path, and Prisma's diff engine cannot see CHECKs — which is why they are
-- also recorded in prisma/prisma-blind-spots.json.
--
-- RLS + REVOKE follow the same pattern as StatementImport/BankLine (Phase 1):
-- the app connects as the table owner and is unaffected, but a leaked anon or
-- authenticated Supabase key cannot read payroll periods or their frozen CSVs.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'User_payType_check' AND conrelid = '"User"'::regclass
   ) THEN
     ALTER TABLE "User" ADD CONSTRAINT "User_payType_check"
       CHECK ("payType" IS NULL OR "payType" IN ('HOURLY', 'SALARY'));
   END IF;
 END $$;

DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_range_check' AND conrelid = '"PayrollPeriod"'::regclass
   ) THEN
     ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_range_check"
       CHECK ("periodEnd" > "periodStart");
   END IF;
 END $$;

-- Stable keys are NOT NULL for NEW rows only: rows written before the columns
-- existed are backfilled above, but the constraint is NOT VALID so the
-- migration never fails on legacy data it cannot see.
DO $$ BEGIN
   IF NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = 'PayrollPeriod_keys_present' AND conrelid = '"PayrollPeriod"'::regclass
   ) THEN
     ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_keys_present"
       CHECK ("periodStartKey" IS NOT NULL AND "periodEndKey" IS NOT NULL) NOT VALID;
   END IF;
 END $$;

-- The backfill above filled every legacy row, so the constraint can now be
-- VALIDATED. Leaving it NOT VALID meant the constraint existed but had never
-- checked anything, which is both weaker than it looks and a real difference
-- from production that the migrations job correctly refused to ignore.
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock, so it does not block reads
-- or writes.
ALTER TABLE "PayrollPeriod" VALIDATE CONSTRAINT "PayrollPeriod_keys_present";

ALTER TABLE "PayrollPeriod" ENABLE ROW LEVEL SECURITY;

-- User carries hourlyRate / burdenRate / payType, so it needs the same
-- treatment as PayrollPeriod. Prisma connects as the table OWNER and owners
-- bypass RLS, so the app is unaffected; the Supabase client in this codebase is
-- storage-only (CLAUDE.md), so nothing reads User through the Data API. This
-- only closes the door on a leaked anon/authenticated key.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;

-- The Supabase roles do not exist on a vanilla Postgres (CI builds a throwaway
-- database from these migrations), and REVOKE on a missing role is a hard
-- error. Guarded so the same DDL runs in both places.
DO $$
BEGIN
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
     REVOKE ALL ON TABLE "PayrollPeriod" FROM anon;
     REVOKE ALL ON TABLE "User" FROM anon;
   END IF;
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
     REVOKE ALL ON TABLE "PayrollPeriod" FROM authenticated;
     REVOKE ALL ON TABLE "User" FROM authenticated;
   END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Help-widget throttle + idempotency (review round 6, item 6).
--
-- The count lives in its own row so the limit is enforced by ONE conditional
-- UPDATE rather than a count-then-insert, which concurrent requests all passed.
-- submissionId makes a retry return the row that already exists instead of
-- filing a second GitHub issue.
-- ---------------------------------------------------------------------------

ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "submissionId" TEXT;

-- Whether this report's GitHub issue exists yet. `status` could not distinguish
-- "never tried" from "tried and finished", so a resumed submission had no way
-- to know whether calling GitHub would duplicate an issue.
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerIssueRef" TEXT;
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerState" TEXT DEFAULT 'pending';

-- Compare-and-set lease over the provider call: two attempts reaching the
-- GitHub step at once would otherwise both file, and the marker search cannot
-- help because neither issue exists yet when they both look.
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseToken" TEXT;
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "providerLeaseExpiresAt" TIMESTAMPTZ(6);
-- Unique PER USER, not globally: a globally unique key means one user's value
-- collides with another's, and the idempotency lookup then returns somebody
-- else's report.
CREATE UNIQUE INDEX IF NOT EXISTS "HelpRequest_userId_submissionId_key" ON "HelpRequest"("userId", "submissionId");
CREATE INDEX IF NOT EXISTS "HelpRequest_userId_createdAt_idx" ON "HelpRequest"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "HelpSubmissionQuota" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hourBucket" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpSubmissionQuota_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HelpSubmissionQuota_userId_hourBucket_key" ON "HelpSubmissionQuota"("userId", "hourBucket");

ALTER TABLE "HelpSubmissionQuota" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
     REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM anon;
   END IF;
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
     REVOKE ALL ON TABLE "HelpSubmissionQuota" FROM authenticated;
   END IF;
END $$;
