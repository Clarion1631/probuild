-- Durable change-order automation outbox and opaque QBO create checkpoint.
-- This migration is deliberately
-- additive and idempotent because production may receive the same DDL first via
-- scripts/apply-co-revision-schema.mjs (DATABASE_URL) and later via a normal
-- `prisma migrate deploy` run (DIRECT_URL).
ALTER TABLE "PaymentSchedule"
    ADD COLUMN IF NOT EXISTS "qbCreateGeneration" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "qbCreateRequestId" TEXT,
    ADD COLUMN IF NOT EXISTS "qbCreateFingerprint" TEXT,
    ADD COLUMN IF NOT EXISTS "qbCreateStartedAt" TIMESTAMPTZ(6);
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentSchedule_qbCreateRequestId_key"
    ON "PaymentSchedule"("qbCreateRequestId");

CREATE TABLE IF NOT EXISTS "InvoiceEmailAttempt" (
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "providerStartedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvoiceEmailAttempt_pkey" PRIMARY KEY ("invoiceId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceEmailAttempt_attemptKey_key"
    ON "InvoiceEmailAttempt"("attemptKey");
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'InvoiceEmailAttempt_invoiceId_fkey'
          AND conrelid = '"InvoiceEmailAttempt"'::regclass
    ) THEN
        ALTER TABLE "InvoiceEmailAttempt"
            ADD CONSTRAINT "InvoiceEmailAttempt_invoiceId_fkey"
            FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- These payloads are server-only and may contain signed portal bearer links.
-- RLS with no policies denies Data API roles even if a future broad grant
-- restores table privileges. The database owner/service role still bypasses
-- RLS; intentionally do not FORCE it.
ALTER TABLE "InvoiceEmailAttempt" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM authenticated';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ChangeOrderAutomationJob" (
    "id" TEXT NOT NULL,
    "changeOrderId" TEXT NOT NULL,
    "eventRevision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "approvalMode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "result" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3),
    "firstProviderAttemptAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeOrderAutomationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_idempotencyKey_key"
    ON "ChangeOrderAutomationJob"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_dedupeKey_key"
    ON "ChangeOrderAutomationJob"("dedupeKey");
CREATE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_changeOrderId_eventRevision_kind_idx"
    ON "ChangeOrderAutomationJob"("changeOrderId", "eventRevision", "kind");
CREATE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_changeOrderId_idx"
    ON "ChangeOrderAutomationJob"("changeOrderId");
CREATE INDEX IF NOT EXISTS "ChangeOrderAutomationJob_status_nextAttemptAt_createdAt_idx"
    ON "ChangeOrderAutomationJob"("status", "nextAttemptAt", "createdAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ChangeOrderAutomationJob_changeOrderId_fkey'
          AND conrelid = '"ChangeOrderAutomationJob"'::regclass
    ) THEN
        ALTER TABLE "ChangeOrderAutomationJob"
            ADD CONSTRAINT "ChangeOrderAutomationJob_changeOrderId_fkey"
            FOREIGN KEY ("changeOrderId") REFERENCES "ChangeOrder"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- Same server-only/no-policy posture as InvoiceEmailAttempt. Keep FORCE off so
-- the direct Prisma owner connection can run the durable worker.
ALTER TABLE "ChangeOrderAutomationJob" ENABLE ROW LEVEL SECURITY;

-- Frozen dispatch payloads can contain recipient addresses or signed context.
-- The roles do not exist in every local/test database, so resolve them only
-- inside guarded dynamic statements.
REVOKE ALL PRIVILEGES ON TABLE "ChangeOrderAutomationJob" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "ChangeOrderAutomationJob" FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "ChangeOrderAutomationJob" FROM authenticated';
    END IF;
END $$;
