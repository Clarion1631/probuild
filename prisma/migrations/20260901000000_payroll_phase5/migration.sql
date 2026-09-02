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

-- CreateIndex: every payroll read is a startTime RANGE scan (whole workweeks
-- for the export, a period for the lock check and the settlement planner) and
-- none of TimeEntry's FK indexes serve a bare range predicate.
CREATE INDEX IF NOT EXISTS "TimeEntry_startTime_idx" ON "TimeEntry"("startTime");

-- Backfill: manual time entries were created with durationHours set but
-- endTime NULL, which every "is this punch still open?" reader has to treat as
-- open. They are COMPLETED rows — give them the end time their duration
-- implies. Idempotent (only touches rows still NULL) and additive.
UPDATE "TimeEntry"
SET "endTime" = "startTime" + make_interval(secs => "durationHours" * 3600)
WHERE "endTime" IS NULL AND "durationHours" IS NOT NULL AND "durationHours" > 0;

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
