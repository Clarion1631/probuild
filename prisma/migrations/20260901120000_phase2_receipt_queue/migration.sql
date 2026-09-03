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
  -- COMPARED WITH THE QUOTES AND SPACES REMOVED FROM BOTH SIDES.
  -- pg_get_constraintdef QUOTES a camelCase identifier ("sourceOfRecord"), so a
  -- literal comparison against an unquoted expected string never matched: the
  -- ELSIF fired on EVERY application and dropped and re-added a constraint that
  -- was already correct — a table lock plus a full validation scan on each run,
  -- and a "converges on the definition" claim that in fact converged on nothing.
  ELSIF translate(current_def, '" ', '') <> translate('CHECK (("sourceOfRecord" = ANY (ARRAY[''STATEMENT''::text, ''QBO''::text])))', '" ', '') THEN
    ALTER TABLE "BankLine" DROP CONSTRAINT "BankLine_sourceOfRecord_check";
    ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_sourceOfRecord_check" CHECK ("sourceOfRecord" IN ('STATEMENT', 'QBO'));
  END IF;
END $$;

-- 1b. What QuickBooks says about a register row's BANK CLEARANCE
-- ('Reconciled' | 'Cleared' | 'Uncleared' | 'Unknown'). Nullable with no
-- default on purpose: every observation stored before this column existed was
-- written without anybody asking QuickBooks the question, so NULL means "never
-- asked" — a different fact from "uncleared", and the only truthful backfill.
-- Both keep the row out of the canonical ledger (see isClearedForMint).
ALTER TABLE "BankLineObservation" ADD COLUMN IF NOT EXISTS "clearedStatus" TEXT;

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

-- THE DURABLE QUEUE STATE FOR A RESEND (Codex PR #443 gate round 41, finding 3).
--
-- An operator answering "resend" on an uncertain card puts it back to PENDING.
-- That decision used to live in `lastError` as the text `resend-requested` —
-- and `lastError` is DIAGNOSTIC: the next failure overwrites it. A queued card
-- that Chat then rejected became `rejected:*`, so the cards cron stopped
-- draining it and the health probe stopped counting it. The operator's decision
-- disappeared with no trace, and the crew was never asked.
--
-- Its own nullable column, so no write that records an ERROR can erase a
-- DECISION. Set by the resend action, cleared only by a successful post (or by
-- the row being deleted because every item was answered).
ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "resendQueuedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ReceiptRequestCard_resendQueuedAt_idx"
  ON "ReceiptRequestCard"("resendQueuedAt");

-- THE DAY A CARD WAS ACTUALLY DELIVERED (Codex PR #443 gate round 42, finding 4).
--
-- `pacificDate` is the day a card was SELECTED for, and a resend deliberately
-- keeps its original one (its request id, and therefore its Chat thread, are
-- derived from it). That leaves nothing recording the day it was SENT — so the
-- one-message-per-owner-per-day rule, which is the whole point of the (owner,
-- pacificDate) key, could be broken from two directions: several queued
-- resends for one owner drained in the same run, and a resend drained on a day
-- the owner had already had their ordinary card.
--
-- This column is the delivery-day claim, taken BEFORE the post and unique per
-- owner and day, so the second attempt loses on the constraint rather than on
-- a check somebody has to remember to write.
ALTER TABLE "ReceiptRequestCard" ADD COLUMN IF NOT EXISTS "deliveredOn" TEXT;

-- PARTIAL, so a card that has never been delivered holds no claim at all.
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_deliveredOn_key"
  ON "ReceiptRequestCard"("owner", "deliveredOn")
  WHERE "deliveredOn" IS NOT NULL;

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
  -- Quote- and space-insensitive, exactly as above. The status column needs no quoting
  -- today, so this one already matched — but the two comparisons must not read
  -- differently, or the next lowercase-to-camelCase column reintroduces the bug.
  ELSIF translate(current_def, '" ', '') <> translate('CHECK (("status" = ANY (ARRAY[''PENDING''::text, ''POSTING''::text, ''POSTED''::text, ''UNCERTAIN''::text])))', '" ', '') THEN
    ALTER TABLE "ReceiptRequestCard" DROP CONSTRAINT "ReceiptRequestCard_status_check";
    ALTER TABLE "ReceiptRequestCard" ADD CONSTRAINT "ReceiptRequestCard_status_check" CHECK ("status" IN ('PENDING', 'POSTING', 'POSTED', 'UNCERTAIN'));
  END IF;
END $$;


-- 5. The DURABLE identity of a signed missing-receipt memo (Codex PR #443 gate
-- round 34, finding 1).
--
-- Two invariants, two unique constraints, in the one place a concurrent writer
-- cannot argue with:
--   * "pdfId" UNIQUE            — one signed memo answers ONE charge.
--   * (targetType, targetKey)   — one charge is bound to ONE memo, immutably.
--
-- The answers route checked reuse by scanning every OTHER issue's displayDetails
-- and then REPLACED its own issue's pdfId in place, so a memo could be unbound
-- by a later one and then replayed against a second charge with nothing on
-- record to catch it. A check is a statement about the moment it ran; these are
-- statements about the row.
CREATE TABLE IF NOT EXISTS "ReceiptMemoArtifact" (
    "id" TEXT NOT NULL,
    "pdfId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptMemoArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_pdfId_key"
  ON "ReceiptMemoArtifact"("pdfId");

CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptMemoArtifact_targetType_targetKey_key"
  ON "ReceiptMemoArtifact"("targetType", "targetKey");

CREATE INDEX IF NOT EXISTS "ReceiptMemoArtifact_issueId_idx"
  ON "ReceiptMemoArtifact"("issueId");

-- BACKFILL FROM THE EVIDENCE THAT ALREADY EXISTS. Every issue already carrying
-- a `memo-signed` resolution with a pdfId is a binding that was made before this
-- table existed; without this the first replay of one of those memos would find
-- an empty table and read as unbound.
--
-- Read with `substring(... from ...)`, NOT a jsonb cast: displayDetails is TEXT
-- and a single malformed row would abort the whole migration. A regex that does
-- not match yields NULL, which the WHERE drops.
--
-- The id is DERIVED from the pdfId (md5), so a re-run inserts the same row and
-- ON CONFLICT makes it a no-op rather than a duplicate under a new cuid.
--
-- ORDER BY makes the residue deterministic: where the pre-fix bug already let
-- two issues record the SAME pdfId, the oldest binding wins and the other issue
-- keeps its recorded resolution but gains no artifact row — which is right, it
-- is the one whose memo was spent elsewhere.
INSERT INTO "ReceiptMemoArtifact" ("id", "pdfId", "targetType", "targetKey", "issueId", "createdAt")
SELECT 'rma_' || md5(parsed."pdfId"), parsed."pdfId", i."targetType", i."targetKey", i."id",
       COALESCE(i."updatedAt", CURRENT_TIMESTAMP)
  FROM "ReviewIssue" i
  CROSS JOIN LATERAL (
      SELECT substring(i."displayDetails" from '"pdfId"[[:space:]]*:[[:space:]]*"([^"]+)"') AS "pdfId",
             substring(i."displayDetails" from '"resolution"[[:space:]]*:[[:space:]]*"([^"]+)"') AS "resolution"
  ) parsed
 WHERE i."displayDetails" LIKE '%memo-signed%'
   AND parsed."resolution" = 'memo-signed'
   AND parsed."pdfId" IS NOT NULL
 ORDER BY i."firstObservedAt", i."id"
 ON CONFLICT DO NOTHING;

-- AND REOPEN THE ONES THAT LOST (Codex PR #443 gate round 36, finding 3).
--
-- `ON CONFLICT DO NOTHING` above binds the OLDEST claimant of a duplicated
-- pdfId and walks away from the others — leaving them with a `memo-signed`
-- resolution and no artifact. That is an answer nothing can vouch for: the
-- memo was spent on a different charge, and `hasResolution` alone kept the
-- chase closed forever. The same shape covers a `memo-signed` blob that never
-- carried a pdfId at all — a claim with no evidence to check.
--
-- QUARANTINED, NOT DELETED: the resolution becomes `memo-conflict`, which
-- `hasResolution` deliberately does not treat as an answer (see
-- src/lib/receipt-requests.ts), and `clearedAt` is cleared — so the charge is
-- chased again while the blob still records what happened. `version` is
-- incremented so an in-flight optimistic write loses rather than clobbering
-- the repair.
--
-- IDEMPOTENT: a re-run finds no `memo-signed` without a binding, because this
-- one rewrote every such row.
UPDATE "ReviewIssue" i
   SET "displayDetails" = regexp_replace(
           i."displayDetails",
           '"resolution"[[:space:]]*:[[:space:]]*"memo-signed"',
           '"resolution":"memo-conflict"'),
       "clearedAt" = NULL,
       "updatedAt" = CURRENT_TIMESTAMP,
       "version" = i."version" + 1
 WHERE i."displayDetails" LIKE '%memo-signed%'
   AND substring(i."displayDetails" from '"resolution"[[:space:]]*:[[:space:]]*"([^"]+)"') = 'memo-signed'
   AND NOT EXISTS (
       SELECT 1
         FROM "ReceiptMemoArtifact" a
        WHERE a."issueId" = i."id"
          AND a."pdfId" IS NOT DISTINCT FROM
              substring(i."displayDetails" from '"pdfId"[[:space:]]*:[[:space:]]*"([^"]+)"')
   );

-- RLS, matching ReceiptRequestCard: ENABLE without FORCE, so the owner/service
-- role the app connects as is unaffected while anon and authenticated get
-- nothing.
ALTER TABLE "ReceiptMemoArtifact" ENABLE ROW LEVEL SECURITY;
