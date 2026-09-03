-- Deposit sweep: replay identity (docs/plans/DEPOSIT-SWEEP-PLAN.md).
--
-- One nullable column. A bank credit's fileId is "bank:<reference>", which is
-- an identity only if the reference always means the same money; this records
-- the normalised credit so a reused reference carrying DIFFERENT data is
-- caught and sent to a human instead of silently replacing the original.
--
-- Additive and idempotent, safe while the previous build is live. Its twin is
-- scripts/apply-deposit-sweep-fingerprint.mjs — identical DDL on purpose (prod
-- is written by the script, CI's throwaway database is built from this file).

-- AlterTable
ALTER TABLE "DepositIngest" ADD COLUMN IF NOT EXISTS "bankFingerprint" TEXT;
