-- AlterTable
-- IF NOT EXISTS on every column: this migration is applied to production out-of-band
-- (scripts/apply-co-revision-schema.mjs), not via `prisma migrate deploy` — DIRECT_URL is
-- unreachable from developer machines (see CLAUDE.md, "Schema migrations"). Idempotency here
-- means a future real `migrate deploy` run against prod (e.g. from a runner that CAN reach
-- DIRECT_URL) applies cleanly as a no-op and self-records in _prisma_migrations, instead of
-- failing with "column already exists". See docs/DB-MIGRATE-WORKFLOW.md for the reconciliation
-- note on this specific migration.
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "termsTaxExempt" BOOLEAN;
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "termsTaxRateName" TEXT;
ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "termsTaxRatePercent" DECIMAL;
