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

-- ScheduleTask.costCodeId — phase attribution for CHANGE-ORDER tasks.
--
-- applyChangeOrderToSchedule sets estimateItemId null on every task it creates
-- (CO scope lives in ChangeOrderItem, not EstimateItem), so a CO task had no
-- route to a cost code at all. Approved CO dollars ARE counted in phase
-- budgets, so a CO-only phase could never advance past 0% and CO work in a
-- shared phase silently inherited the original estimate tasks' progress.
ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "costCodeId" TEXT;
CREATE INDEX IF NOT EXISTS "ScheduleTask_costCodeId_idx" ON "ScheduleTask"("costCodeId");
DO $$ BEGIN
  ALTER TABLE "ScheduleTask" ADD CONSTRAINT "ScheduleTask_costCodeId_fkey"
    FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One-shot backfill for CO tasks that already exist. There is no durable
-- task→ChangeOrderItem link (the child task is created from the item's `name`,
-- in order), so the only available join is the name — and a name match is only
-- trustworthy when it is UNAMBIGUOUS on both sides. Both guards below are
-- required: exactly one CO item with that name in that CO, and exactly one CO
-- task with that name in that CO. Anything ambiguous is left null and simply
-- goes on being unattributed, which is the honest outcome. Idempotent via the
-- `costCodeId IS NULL` guard.
UPDATE "ScheduleTask" st
SET "costCodeId" = ci."costCodeId"
FROM "ChangeOrderItem" ci
WHERE st."generatedFromChangeOrderId" = ci."changeOrderId"
  AND st."name" = ci."name"
  AND st."costCodeId" IS NULL
  AND st."estimateItemId" IS NULL
  AND st."type" = 'task'
  AND ci."costCodeId" IS NOT NULL
  AND (SELECT COUNT(*) FROM "ChangeOrderItem" c2
       WHERE c2."changeOrderId" = ci."changeOrderId" AND c2."name" = ci."name") = 1
  AND (SELECT COUNT(*) FROM "ScheduleTask" s2
       WHERE s2."generatedFromChangeOrderId" = st."generatedFromChangeOrderId"
         AND s2."name" = st."name" AND s2."type" = 'task') = 1;
