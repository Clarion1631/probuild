-- Deposit sweep (docs/plans/DEPOSIT-SWEEP-PLAN.md "Schema change").
--
-- Additive and idempotent: four nullable DepositIngest columns, two indexes,
-- and one nullable PaymentNotification column. No existing column is touched,
-- so this is safe to apply while the previous build is live. Its twin is
-- scripts/apply-deposit-sweep-schema.mjs — the two carry identical DDL on
-- purpose (repo rule: prod is written by the script, CI's throwaway database
-- is built from this file).
--
-- The partial unique index on DepositIngest("paymentScheduleId") is NOT
-- touched here: it lives in scripts/apply-deposit-ingest-schema.mjs and in the
-- baseline's generated tail block, and `proposed` is deliberately outside its
-- predicate (a proposed row holds no reservation).

-- AlterTable
ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "bankReference" TEXT;
ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "postDate" DATE;
ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "amountCents" INTEGER;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DepositIngest_postDate_amountCents_idx" ON "DepositIngest"("postDate", "amountCents");
CREATE INDEX IF NOT EXISTS "DepositIngest_bankReference_idx" ON "DepositIngest"("bankReference");

-- AlterTable
ALTER TABLE "PaymentNotification" ADD COLUMN IF NOT EXISTS "suppressClientReceipt" BOOLEAN;
