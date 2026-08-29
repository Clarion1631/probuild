-- Recorded 2026-08-28 from CI "Migrations reproduce production" on main abd0808a:
-- schema.prisma changed in 854c3eb3 / ca7b5444 / abd0808a with no migration file.
-- CI's "+" lines were the TimeEntry and User columns. The BankImage columns and the
-- ClientMessage index appeared in its reference diff but already exist in the migration
-- history (the first attempt failed 42P07 on the index), so every statement here is
-- idempotent: it only adds what is actually missing.

-- AlterTable
ALTER TABLE "TimeEntry"
  ADD COLUMN IF NOT EXISTS "mealOutcome" TEXT,
  ADD COLUMN IF NOT EXISTS "mealSkipDecidedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mealSkipDecidedById" TEXT,
  ADD COLUMN IF NOT EXISTS "mealSkipReason" TEXT,
  ADD COLUMN IF NOT EXISTS "mealSkipRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mealSkipStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "restBreaksMissed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shiftHours" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mealWaiverSignedAt" TIMESTAMP(3);

-- AlterTable (already present in history on most databases; harmless here)
ALTER TABLE "BankImage"
  ADD COLUMN IF NOT EXISTS "extractedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "extractionModel" TEXT,
  ADD COLUMN IF NOT EXISTS "memoText" TEXT,
  ADD COLUMN IF NOT EXISTS "payerName" TEXT;

-- CreateIndex (already present in history; idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "ClientMessage_twilioMessageSid_key" ON "ClientMessage"("twilioMessageSid");
