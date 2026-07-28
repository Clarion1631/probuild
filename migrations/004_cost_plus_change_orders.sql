-- PB-pipeline-004: additive cost-plus and milestone change-order support.
-- Safe to re-run: columns/indexes use IF NOT EXISTS and foreign keys are
-- installed only when their named constraint is absent.

ALTER TABLE "CompanySettings"
  ADD COLUMN IF NOT EXISTS "timeZone" TEXT NOT NULL DEFAULT 'America/Los_Angeles';

ALTER TABLE "ChangeOrder"
  ADD COLUMN IF NOT EXISTS "pricingType" TEXT NOT NULL DEFAULT 'FIXED',
  ADD COLUMN IF NOT EXISTS "markupPercent" DOUBLE PRECISION;

ALTER TABLE "TimeEntry"
  ADD COLUMN IF NOT EXISTS "changeOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "isBillable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "invoiceId" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "Expense"
  ADD COLUMN IF NOT EXISTS "changeOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "isBillable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "invoiceId" TEXT,
  ADD COLUMN IF NOT EXISTS "invoicedAt" TIMESTAMP(3);

ALTER TABLE "PaymentSchedule"
  ADD COLUMN IF NOT EXISTS "pretaxAmount" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "sourceChangeOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCoScheduleId" TEXT;

CREATE TABLE IF NOT EXISTS "ChangeOrderBilling" (
  "id" TEXT NOT NULL,
  "changeOrderId" TEXT NOT NULL,
  "paymentScheduleId" TEXT,
  "label" TEXT NOT NULL,
  "laborCents" INTEGER NOT NULL,
  "expenseCents" INTEGER NOT NULL,
  "markupCents" INTEGER NOT NULL,
  "taxCents" INTEGER NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT,
  CONSTRAINT "ChangeOrderBilling_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeEntry_changeOrderId_idx" ON "TimeEntry"("changeOrderId");
CREATE INDEX IF NOT EXISTS "Expense_changeOrderId_idx" ON "Expense"("changeOrderId");
CREATE INDEX IF NOT EXISTS "PaymentSchedule_sourceChangeOrderId_idx" ON "PaymentSchedule"("sourceChangeOrderId");
CREATE INDEX IF NOT EXISTS "ChangeOrderBilling_changeOrderId_idx" ON "ChangeOrderBilling"("changeOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentSchedule_sourceCoScheduleId_key" ON "PaymentSchedule"("sourceCoScheduleId");
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeOrderBilling_paymentScheduleId_key" ON "ChangeOrderBilling"("paymentScheduleId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TimeEntry_changeOrderId_fkey') THEN
    ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_changeOrderId_fkey"
      FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_changeOrderId_fkey') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_changeOrderId_fkey"
      FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentSchedule_sourceCoScheduleId_fkey') THEN
    ALTER TABLE "PaymentSchedule" ADD CONSTRAINT "PaymentSchedule_sourceCoScheduleId_fkey"
      FOREIGN KEY ("sourceCoScheduleId") REFERENCES "ChangeOrderPaymentSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChangeOrderBilling_changeOrderId_fkey') THEN
    ALTER TABLE "ChangeOrderBilling" ADD CONSTRAINT "ChangeOrderBilling_changeOrderId_fkey"
      FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChangeOrderBilling_paymentScheduleId_fkey') THEN
    ALTER TABLE "ChangeOrderBilling" ADD CONSTRAINT "ChangeOrderBilling_paymentScheduleId_fkey"
      FOREIGN KEY ("paymentScheduleId") REFERENCES "PaymentSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
