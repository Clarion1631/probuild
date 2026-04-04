-- A2: Company-Wide Document Numbering
-- Run this BEFORE committing schema.prisma changes
-- Execute via: powershell -ExecutionPolicy Bypass -File apply_schema.ps1

-- 1. Create DocumentCounter table
CREATE TABLE IF NOT EXISTS "DocumentCounter" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentCounter_type_key" ON "DocumentCounter"("type");

-- 2. Add referenceNumber to Expense
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;

-- 3. Seed counters based on existing document counts
-- This ensures new documents continue from after existing ones
INSERT INTO "DocumentCounter" ("id", "type", "prefix", "nextNumber", "updatedAt")
VALUES
    (gen_random_uuid()::text, 'ESTIMATE', 'ES', COALESCE((SELECT COUNT(*) + 1 FROM "Estimate"), 1), NOW()),
    (gen_random_uuid()::text, 'INVOICE', 'IN', COALESCE((SELECT COUNT(*) + 1 FROM "Invoice"), 1), NOW()),
    (gen_random_uuid()::text, 'CHANGE_ORDER', 'CO', COALESCE((SELECT COUNT(*) + 1 FROM "ChangeOrder"), 1), NOW()),
    (gen_random_uuid()::text, 'PURCHASE_ORDER', 'PO', COALESCE((SELECT COUNT(*) + 1 FROM "PurchaseOrder"), 1), NOW()),
    (gen_random_uuid()::text, 'RETAINER', 'RR', COALESCE((SELECT COUNT(*) + 1 FROM "Retainer"), 1), NOW()),
    (gen_random_uuid()::text, 'EXPENSE', 'EX', COALESCE((SELECT COUNT(*) + 1 FROM "Expense"), 1), NOW()),
    (gen_random_uuid()::text, 'PAYMENT', 'PM', 1, NOW())
ON CONFLICT ("type") DO NOTHING;

-- 4. Backfill existing documents with sequential reference numbers
-- Estimates: update code from random EST-XXXX to sequential ES-NNNNN
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") as rn
    FROM "Estimate"
)
UPDATE "Estimate" e
SET code = 'ES-' || LPAD(n.rn::text, 5, '0')
FROM numbered n
WHERE e.id = n.id;

-- Invoices
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") as rn
    FROM "Invoice"
)
UPDATE "Invoice" i
SET code = 'IN-' || LPAD(n.rn::text, 5, '0')
FROM numbered n
WHERE i.id = n.id;

-- Change Orders
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") as rn
    FROM "ChangeOrder"
)
UPDATE "ChangeOrder" co
SET code = 'CO-' || LPAD(n.rn::text, 5, '0')
FROM numbered n
WHERE co.id = n.id;

-- Purchase Orders
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") as rn
    FROM "PurchaseOrder"
)
UPDATE "PurchaseOrder" po
SET code = 'PO-' || LPAD(n.rn::text, 5, '0')
FROM numbered n
WHERE po.id = n.id;

-- Retainers
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") as rn
    FROM "Retainer"
)
UPDATE "Retainer" r
SET code = 'RR-' || LPAD(n.rn::text, 5, '0')
FROM numbered n
WHERE r.id = n.id;

-- Expenses: set referenceNumber
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") as rn
    FROM "Expense"
)
UPDATE "Expense" ex
SET "referenceNumber" = 'EX-' || LPAD(n.rn::text, 5, '0')
FROM numbered n
WHERE ex.id = n.id;
