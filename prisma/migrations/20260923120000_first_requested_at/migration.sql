-- PaymentSchedule.firstRequestedAt: the FIRST time a payment request was
-- emailed for a milestone. Set once by src/lib/milestone-request-stamp.ts and
-- never moved; qbInvoiceSentAt keeps meaning the LAST send, and every resend
-- moves it forward, which made a resend look like a fresh bill to AR aging
-- and pushed a paid milestone past the bank-deposit chronology bound.
--
-- Backfill from qbInvoiceSentAt, the only request date a row holds. For a
-- milestone already resent before this ran that is its LAST send, so its age
-- stays understated exactly as before; no log exists to recover the true
-- date. Every send after this ships records it correctly.
--
-- Additive and idempotent (the backfill only touches rows still NULL), safe
-- while the previous build is live. Its twin is
-- scripts/apply-first-requested-at.mjs, identical SQL on purpose (prod is
-- written by the script, CI's throwaway database is built from this file).

-- AlterTable
ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "firstRequestedAt" TIMESTAMP(3);

-- Backfill
UPDATE "PaymentSchedule" SET "firstRequestedAt" = "qbInvoiceSentAt" WHERE "firstRequestedAt" IS NULL AND "qbInvoiceSentAt" IS NOT NULL;
