-- Logistics voice dump → formalize → route (plan 02; src/lib/logistics-formalize.ts).
-- Production received these columns via scripts/apply-logistics-routing-schema.mjs
-- (ADD COLUMN IF NOT EXISTS, 2026-08-29); this file records the same shape for
-- fresh-database reproduction in CI.
-- IF NOT EXISTS added 2026-08-29 (retro Codex/Claude review of PR 425): prod
-- already has these columns, so a bare ADD COLUMN replay would fail P3009 and
-- block every later migration. Pair with `prisma migrate resolve --applied`.

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "formalizedNote" TEXT;
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "logisticsCategory" TEXT;
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "rawNote" TEXT;
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "routedAt" TIMESTAMP(3);
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "routedById" TEXT;
ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "routedFromProjectId" TEXT;
