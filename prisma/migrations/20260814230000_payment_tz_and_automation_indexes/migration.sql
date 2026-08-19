-- Backfills the migration history for two schema.prisma changes that merged without
-- migration files (the "Migrations reproduce production" gate flagged them on every
-- subsequent PR):
--   * #386 fix(money): PaymentSchedule.paymentDate/.paidAt widened to TIMESTAMPTZ(6)
--     to match their mirrored twins on EstimatePaymentSchedule.
--   * #392 automation dashboard: two AutomationEvent lookup indexes.
-- Prod already has all four objects (applied 2026-08-14 via #386's own
-- apply-payment-timestamp-alignment.mjs SQL + CREATE INDEX IF NOT EXISTS, verified
-- against information_schema/pg_indexes). This file exists so a DB built from the
-- committed migrations reproduces that same shape.

-- AlterTable (#386 — on the CI throwaway DB the columns are empty; prod conversion
-- used USING "col" AT TIME ZONE 'UTC' and is already done)
ALTER TABLE "PaymentSchedule" ALTER COLUMN "paymentDate" SET DATA TYPE TIMESTAMPTZ(6),
ALTER COLUMN "paidAt" SET DATA TYPE TIMESTAMPTZ(6);

-- CreateIndex (#392)
CREATE INDEX "AutomationEvent_qbPurchaseId_idx" ON "AutomationEvent"("qbPurchaseId");

-- CreateIndex (#392)
CREATE INDEX "AutomationEvent_driveFileId_idx" ON "AutomationEvent"("driveFileId");
