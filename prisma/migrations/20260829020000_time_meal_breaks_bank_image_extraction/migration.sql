-- Recorded 2026-08-28 from CI "Migrations reproduce production" on main abd0808a:
-- schema.prisma changed in 854c3eb3 / ca7b5444 / abd0808a with no migration file.
-- This is the exact diff CI computed; it makes main reproducible again.

-- AlterTable
ALTER TABLE "BankImage" ADD COLUMN     "extractedAt" TIMESTAMPTZ(6),
ADD COLUMN     "extractionModel" TEXT,
ADD COLUMN     "memoText" TEXT,
ADD COLUMN     "payerName" TEXT;

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "mealOutcome" TEXT,
ADD COLUMN     "mealSkipDecidedAt" TIMESTAMP(3),
ADD COLUMN     "mealSkipDecidedById" TEXT,
ADD COLUMN     "mealSkipReason" TEXT,
ADD COLUMN     "mealSkipRequestedAt" TIMESTAMP(3),
ADD COLUMN     "mealSkipStatus" TEXT,
ADD COLUMN     "restBreaksMissed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shiftHours" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mealWaiverSignedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessage_twilioMessageSid_key" ON "ClientMessage"("twilioMessageSid");
