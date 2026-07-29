-- Additive, idempotent schema support for finalized QuickBooks Purchase imports.
-- Existing/manual expenses remain nullable and unaffected.
ALTER TABLE "Expense"
    ADD COLUMN IF NOT EXISTS "qbPurchaseId" TEXT,
    ADD COLUMN IF NOT EXISTS "qbSyncToken" TEXT,
    ADD COLUMN IF NOT EXISTS "qbSyncedAt" TIMESTAMPTZ;

-- PostgreSQL permits multiple null values in a unique index. The partial
-- predicate keeps the index limited to imported QBO rows and makes the QBO
-- transaction id the atomic upsert/idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_qbPurchaseId_key"
    ON "Expense" ("qbPurchaseId")
    WHERE "qbPurchaseId" IS NOT NULL;
