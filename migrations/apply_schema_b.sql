-- Sprint B Schema Changes: Processing Fee, Expiration, Archive for Estimate
-- Run via Supabase SQL Editor or apply_schema.ps1

ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "processingFeeMarkup" DECIMAL;
ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "hideProcessingFee" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "expirationDate" TIMESTAMP(3);
ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
