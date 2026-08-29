-- Repair the baseline table shape: schema.prisma declares this default and
-- the application migration applies it to existing production tables.
-- This migration makes a database built from history reproduce that shape.
ALTER TABLE "QboPurchaseClassification"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
