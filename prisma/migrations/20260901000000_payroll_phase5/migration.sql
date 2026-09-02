-- Phase 5 payroll schema (docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md
-- sections 2 and 3). Additive and idempotent — safe to replay and safe to run
-- while the previous build is live. Mirrors scripts/apply-payroll-phase5.mjs
-- statement for statement.

-- AlterTable: last time a member's pay rate was confirmed (import or manual edit).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRateSyncAt" TIMESTAMPTZ(6);

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
