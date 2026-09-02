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

DO $$
DECLARE current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'BankLine_sourceOfRecord_check'
     AND conrelid = '"BankLine"'::regclass;
  IF current_def IS NULL THEN
    ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_sourceOfRecord_check" CHECK ("sourceOfRecord" IN ('STATEMENT', 'QBO'));
  ELSIF current_def <> 'CHECK ((' || 'sourceOfRecord = ANY (ARRAY[''STATEMENT''::text, ''QBO''::text])' || '))' THEN
    ALTER TABLE "BankLine" DROP CONSTRAINT "BankLine_sourceOfRecord_check";
    ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_sourceOfRecord_check" CHECK ("sourceOfRecord" IN ('STATEMENT', 'QBO'));
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

-- 3. The POST-claim, distinct from the row itself. Only the run holding
-- `claimToken` may mark the row posted, so an overlapping run can never
-- complete a post it did not make. ALTERs rather than columns folded into the
-- CREATE above, because CREATE TABLE IF NOT EXISTS is a no-op against a table
-- an earlier run already made — that is what keeps this re-runnable.
ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;

-- 4. A Purchase QuickBooks created for a receipt somebody voided while the send
-- was in flight. NOT qbPurchaseId — that column means "this row is booked", and
-- this row is not; the money exists in QBO and a human has to void it there.
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "postVoidQbPurchaseId" TEXT;

-- RLS, matching ReceiptIntake and every other sensitive table in this schema.
-- ENABLE with no policies and WITHOUT FORCE: the app connects as the
-- owner/service role, which bypasses RLS, so reads and writes are unaffected —
-- while anon and authenticated roles (a leaked anon key, a Supabase client
-- someone wires up later) get nothing. FORCE would deny the owner too and take
-- the cron down. ReceiptRequestCard holds owner names and the item snapshot for
-- real charges, so it belongs in the same class.
ALTER TABLE "ReceiptRequestCard" ENABLE ROW LEVEL SECURITY;


-- `overflow` is a COUNT; this says whether that count is exact. The selection
-- scan can stop early (SCAN_MAX_PAGES) and a retry pass does not scan at all,
-- so without persisting this a resumed card printed "and 4 more" as though it
-- were authoritative when the number came from a scan that never ran. Defaults
-- true: every card written before this column existed came from a full scan.
ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "overflowExact" BOOLEAN NOT NULL DEFAULT true;


-- The card delivery state machine. POSTING is written BEFORE the webhook call,
-- so a crash mid-send is distinguishable from a crash before it — otherwise the
-- next run has to either double-post or silently drop the day's card. A row
-- found in POSTING is UNCERTAIN, not retryable.
ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING';

DO $$
DECLARE current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'ReceiptRequestCard_status_check'
     AND conrelid = '"ReceiptRequestCard"'::regclass;
  IF current_def IS NULL THEN
    ALTER TABLE "ReceiptRequestCard" ADD CONSTRAINT "ReceiptRequestCard_status_check" CHECK ("status" IN ('PENDING', 'POSTING', 'POSTED', 'UNCERTAIN'));
  ELSIF current_def <> 'CHECK ((' || 'status = ANY (ARRAY[''PENDING''::text, ''POSTING''::text, ''POSTED''::text, ''UNCERTAIN''::text])' || '))' THEN
    ALTER TABLE "ReceiptRequestCard" DROP CONSTRAINT "ReceiptRequestCard_status_check";
    ALTER TABLE "ReceiptRequestCard" ADD CONSTRAINT "ReceiptRequestCard_status_check" CHECK ("status" IN ('PENDING', 'POSTING', 'POSTED', 'UNCERTAIN'));
  END IF;
END $$;
