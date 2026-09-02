-- Phase 2 schema (docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md). Production gets
-- these through the guarded rollout script scripts/apply-phase2-receipt-queue.mjs;
-- this migration carries the SAME statements so a fresh database built from
-- prisma/migrations/ reproduces production. Keep both additive and idempotent.
--
-- The CHECK on "sourceOfRecord" is invisible to Prisma (no check-constraint
-- concept) and MUST stay hand-written here. It is not decoration: 'QBO' vs
-- 'STATEMENT' decides whether a line is adoptable when the statement arrives,
-- and a typo'd third value would leave a line permanently un-adoptable while
-- looking perfectly fine in the UI.

-- 1. Which source MINTED this canonical BankLine.
-- NOT NULL with a DEFAULT, so existing rows are backfilled by the DDL itself:
-- every line that exists today WAS minted from a statement, so the default is a
-- true statement about them, not a convenient guess.
ALTER TABLE "BankLine" ADD COLUMN IF NOT EXISTS "sourceOfRecord" TEXT NOT NULL DEFAULT 'STATEMENT';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'BankLine_sourceOfRecord_check'
                    AND conrelid = '"BankLine"'::regclass) THEN
    ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_sourceOfRecord_check"
      CHECK ("sourceOfRecord" IN ('STATEMENT', 'QBO'));
  END IF;
END $$;

-- Adoption looks lines up by (account, postedDate, amountCents) and then filters
-- in memory on payee/check#/sourceOfRecord — index the lookup, not the flag.
CREATE INDEX IF NOT EXISTS "BankLine_account_postedDate_amountCents_idx"
  ON "BankLine"("account", "postedDate", "amountCents");

-- 2. Durable outbox for the per-owner missing-receipt Chat digest.
CREATE TABLE IF NOT EXISTS "ReceiptRequestCard" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "pacificDate" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "overflow" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "threadName" TEXT,
    "messageName" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptRequestCard_pkey" PRIMARY KEY ("id")
);

-- THE CLAIM. One card per owner per Pacific day; the insert IS the lock, so a
-- second concurrent cron run loses it and posts nothing. A non-unique index
-- here would silently permit exactly the double-post this exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_pacificDate_key"
  ON "ReceiptRequestCard"("owner", "pacificDate");

CREATE INDEX IF NOT EXISTS "ReceiptRequestCard_pacificDate_idx"
  ON "ReceiptRequestCard"("pacificDate");
