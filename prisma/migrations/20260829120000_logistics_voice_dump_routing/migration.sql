-- Logistics voice dump → formalize → route (plan 02; src/lib/logistics-formalize.ts).
-- Production received these columns via scripts/apply-logistics-routing-schema.mjs
-- (ADD COLUMN IF NOT EXISTS, 2026-08-29); this file records the same shape for
-- fresh-database reproduction in CI.

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "formalizedNote" TEXT,
ADD COLUMN     "logisticsCategory" TEXT,
ADD COLUMN     "rawNote" TEXT,
ADD COLUMN     "routedAt" TIMESTAMP(3),
ADD COLUMN     "routedById" TEXT,
ADD COLUMN     "routedFromProjectId" TEXT;
