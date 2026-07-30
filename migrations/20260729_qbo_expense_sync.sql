-- Additive, idempotent schema support for finalized QuickBooks Purchase imports.
-- Existing/manual expenses remain nullable and unaffected.
ALTER TABLE "Expense"
    ADD COLUMN IF NOT EXISTS "qbPurchaseId" TEXT,
    ADD COLUMN IF NOT EXISTS "qbSyncToken" TEXT,
    ADD COLUMN IF NOT EXISTS "qbSyncedAt" TIMESTAMPTZ;

-- PostgreSQL permits multiple null values in a regular unique index. Keep this
-- index non-partial so it matches Prisma's @unique contract and can support
-- native unique lookups while leaving all manual expense nulls unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_qbPurchaseId_key"
    ON "Expense" ("qbPurchaseId");
