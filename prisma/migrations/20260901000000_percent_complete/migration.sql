-- Percent complete / earned margin (docs/plans/PHASE-4-EARNED-MARGIN-SPEC.md §2).
--
-- Additive and idempotent: a new enum type plus six nullable Project columns and
-- one guarded FK. No existing column is touched, so this is safe to apply while
-- the previous build is live. Its twin is scripts/apply-percent-complete.mjs —
-- the two carry identical DDL on purpose (repo rule: prod is written by the
-- script, CI's throwaway database is built from this file).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PercentCompleteSource" AS ENUM ('AUTO', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentComplete" DECIMAL(5,2);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteSource" "PercentCompleteSource";
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAsOf" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAuto" DECIMAL(5,2);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteAutoAtOverride" DECIMAL(5,2);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "percentCompleteUpdatedById" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Project_percentCompleteUpdatedById_idx" ON "Project"("percentCompleteUpdatedById");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Project" ADD CONSTRAINT "Project_percentCompleteUpdatedById_fkey"
    FOREIGN KEY ("percentCompleteUpdatedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
