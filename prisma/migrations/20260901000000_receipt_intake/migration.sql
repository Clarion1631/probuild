-- ReceiptIntake schema history (Receipt Pipeline v2, Phase 1 —
-- docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §2). The table is first applied to
-- production through the guarded rollout script scripts/apply-receipt-intake.mjs;
-- this migration carries the SAME statements so a fresh database built from
-- prisma/migrations/ reproduces production. Keep both additive and idempotent.
--
-- Two objects here are invisible to Prisma and MUST stay hand-written:
--   * the CHECK on "state" (Prisma has no check-constraint concept), and
--   * the PARTIAL unique index on "dedupStrongKey" (Prisma's diff engine drops
--     partial indexes silently — CLAUDE.md, prisma/prisma-blind-spots.json).
-- The partial index is not an optimisation: it IS the strong-dedup claim. The
-- read step writes the keys and reads a unique violation as "someone already
-- owns this purchase", which is what replaces the Apps Script's Properties lock.

CREATE TABLE IF NOT EXISTS "ReceiptIntake" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STAGING',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "stateReason" TEXT,
    "taxWarning" TEXT,
    "projectId" TEXT,
    "costCodeId" TEXT,
    "suggestedCostCodeId" TEXT,
    "suggestedConfidence" DOUBLE PRECISION,
    "createdById" TEXT,
    "storagePath" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "expectedSha256" TEXT,
    "uploadUrlExpiresAt" TIMESTAMP(3),
    "uploadLeaseVersion" INTEGER NOT NULL DEFAULT 0,
    "uploadLeaseNonce" TEXT,
    "vendor" TEXT,
    "txnDate" DATE,
    "totalCents" INTEGER,
    "taxCents" INTEGER,
    "docType" TEXT,
    "refNumber" TEXT,
    "memo" TEXT,
    "readJson" TEXT,
    "readAt" TIMESTAMP(3),
    "dedupStrongKey" TEXT,
    "dedupWeakKey" TEXT,
    "duplicateOfId" TEXT,
    "sendAttempted" BOOLEAN NOT NULL DEFAULT false,
    "archivedByV1" BOOLEAN NOT NULL DEFAULT false,
    "qbPurchaseId" TEXT,
    "expenseId" TEXT,
    "archiveDriveFileId" TEXT,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "busyPasses" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "bookedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptIntake_pkey" PRIMARY KEY ("id")
);

-- Additive upgrade for a table created by an earlier run of
-- scripts/apply-receipt-intake.mjs: CREATE TABLE IF NOT EXISTS is a no-op on an
-- existing table, so a column added to the CREATE above would never reach it.
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "busyPasses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "expectedSha256" TEXT;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadUrlExpiresAt" TIMESTAMP(3);
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadLeaseVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "uploadLeaseNonce" TEXT;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "sendAttempted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "archivedByV1" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
-- The dropped-tax-reading marker's DURABLE home. It lived in stateReason,
-- which every deferred booking and every park overwrites, so the evidence
-- was gone by the time the row reached BOOKED.
ALTER TABLE "ReceiptIntake" ADD COLUMN IF NOT EXISTS "taxWarning" TEXT;

-- THE STATE DEFAULT IS REPAIRED, not merely declared on a fresh table.
-- CREATE TABLE above carries DEFAULT 'STAGING'; a table an earlier Phase-1
-- revision created carries DEFAULT 'RECEIVED', and adding columns cannot fix
-- that. An upgraded deployment kept minting rows that skip STAGING entirely —
-- claimable by the worker before their object exists, which is exactly what
-- the two-step upload exists to prevent. Idempotent.
ALTER TABLE "ReceiptIntake" ALTER COLUMN "state" SET DEFAULT 'STAGING';

-- ONE LIVE CLAIM PER OBJECT PATH. The primary key IS the invariant: two
-- live claims over one path cannot exist, whatever the application does.
-- Publishing and deleting the same object used to be separated only by
-- claim data inside an AutomationEvent's JSON, which nothing enforced and
-- which two concurrent transactions could each read as 'free'.
CREATE TABLE IF NOT EXISTS "ReceiptObjectClaim" (
    "storagePath" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptObjectClaim_pkey" PRIMARY KEY ("storagePath")
);
CREATE INDEX IF NOT EXISTS "ReceiptObjectClaim_expiresAt_idx" ON "ReceiptObjectClaim"("expiresAt");
ALTER TABLE "ReceiptObjectClaim" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_sourceRef_key" ON "ReceiptIntake"("sourceRef");
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_expenseId_key" ON "ReceiptIntake"("expenseId");
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIntake_dedupStrongKey_active_key"
    ON "ReceiptIntake"("dedupStrongKey")
    WHERE "dedupStrongKey" IS NOT NULL AND "state" NOT IN ('DUPLICATE', 'VOID');
CREATE INDEX IF NOT EXISTS "ReceiptIntake_state_nextRetryAt_idx" ON "ReceiptIntake"("state", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_projectId_idx" ON "ReceiptIntake"("projectId");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_dedupWeakKey_idx" ON "ReceiptIntake"("dedupWeakKey");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_createdAt_idx" ON "ReceiptIntake"("createdAt");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_costCodeId_idx" ON "ReceiptIntake"("costCodeId");
CREATE INDEX IF NOT EXISTS "ReceiptIntake_createdById_idx" ON "ReceiptIntake"("createdById");

-- CONVERGENT, exactly like scripts/apply-receipt-intake.mjs: a constraint that
-- exists with a STALE definition is replaced, not left alone. "Create only when
-- absent" is what let the two diverge — a database that already carried an
-- older state list (one without SHADOW_QUARANTINE, say) kept it forever here
-- while the apply script corrected it in production, so the same repo described
-- two different tables depending on which path built them.
DO $$
DECLARE current_def TEXT;
        wanted_def  TEXT := 'CHECK ((state = ANY (ARRAY[''STAGING''::text, ''RECEIVED''::text, ''READ''::text, ''NEEDS_JOB''::text, ''NEEDS_REVIEW''::text, ''BOOKING''::text, ''BOOKED''::text, ''ARCHIVED''::text, ''DUPLICATE''::text, ''VOID''::text, ''NON_RECEIPT''::text, ''SHADOW_DONE''::text, ''SHADOW_QUARANTINE''::text])))';
BEGIN
    SELECT pg_get_constraintdef(oid) INTO current_def
      FROM pg_constraint
     WHERE conname = 'ReceiptIntake_state_check'
       AND conrelid = '"ReceiptIntake"'::regclass;

    IF current_def IS NULL THEN
        ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
            CHECK ("state" IN ('STAGING', 'RECEIVED', 'READ', 'NEEDS_JOB', 'NEEDS_REVIEW', 'BOOKING',
                               'BOOKED', 'ARCHIVED', 'DUPLICATE', 'VOID', 'NON_RECEIPT',
                               'SHADOW_DONE', 'SHADOW_QUARANTINE'));
    ELSIF current_def IS DISTINCT FROM wanted_def THEN
        -- One statement each, in the SAME transaction as everything else here,
        -- so the table is never briefly unconstrained.
        ALTER TABLE "ReceiptIntake" DROP CONSTRAINT "ReceiptIntake_state_check";
        ALTER TABLE "ReceiptIntake" ADD CONSTRAINT "ReceiptIntake_state_check"
            CHECK ("state" IN ('STAGING', 'RECEIVED', 'READ', 'NEEDS_JOB', 'NEEDS_REVIEW', 'BOOKING',
                               'BOOKED', 'ARCHIVED', 'DUPLICATE', 'VOID', 'NON_RECEIPT',
                               'SHADOW_DONE', 'SHADOW_QUARANTINE'));
    END IF;
END $$;

-- RLS, matching every other sensitive table in this schema. ENABLE with no
-- policies and WITHOUT FORCE: the app connects as the owner/service role, which
-- bypasses RLS, so reads and writes are unaffected — while anon and
-- authenticated roles get nothing. FORCE would deny the owner too.
ALTER TABLE "ReceiptIntake" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ReceiptIntake_projectId_fkey'
          AND conrelid = '"ReceiptIntake"'::regclass
    ) THEN
        ALTER TABLE "ReceiptIntake"
            ADD CONSTRAINT "ReceiptIntake_projectId_fkey"
            FOREIGN KEY ("projectId") REFERENCES "Project"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ReceiptIntake_costCodeId_fkey'
          AND conrelid = '"ReceiptIntake"'::regclass
    ) THEN
        ALTER TABLE "ReceiptIntake"
            ADD CONSTRAINT "ReceiptIntake_costCodeId_fkey"
            FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ReceiptIntake_createdById_fkey'
          AND conrelid = '"ReceiptIntake"'::regclass
    ) THEN
        ALTER TABLE "ReceiptIntake"
            ADD CONSTRAINT "ReceiptIntake_createdById_fkey"
            FOREIGN KEY ("createdById") REFERENCES "User"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ReceiptIntake_expenseId_fkey'
          AND conrelid = '"ReceiptIntake"'::regclass
    ) THEN
        ALTER TABLE "ReceiptIntake"
            ADD CONSTRAINT "ReceiptIntake_expenseId_fkey"
            FOREIGN KEY ("expenseId") REFERENCES "Expense"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
