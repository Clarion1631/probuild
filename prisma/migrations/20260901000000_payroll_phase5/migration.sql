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
