-- Speed-to-Lead v1 (PB-leads-001). Additive only — see docs/plans/SPEED-TO-LEAD-SPEC.md.
-- Every statement is re-runnable (IF NOT EXISTS / duplicate_object-safe), matching
-- the rest of this schema's migrations. "-- statement-break" markers (same
-- convention as prisma/migrations/20260907000000_time_entry_void) separate
-- top-level statements for the apply script's splitter, which must never split
-- inside a dollar-quoted DO block.
--
-- Deliberately NO "ENABLE ROW LEVEL SECURITY" and no append-only trigger here,
-- even though some sibling tables in this schema carry both. Both are objects
-- Prisma's diff engine cannot see (scripts/check-migrations-match.mjs's "blind
-- spots" pass), which are asserted against prisma/prisma-blind-spots.json — a
-- snapshot of PRODUCTION. This PR does not touch production (by instruction),
-- so adding either here would make that snapshot describe a state production
-- does not have yet, and CI's migrations job would fail until someone
-- re-snapshotted it. Append-only is enforced at the application layer instead
-- (src/lib/speed-to-lead never calls .update()/.delete() on OutreachEvent or
-- ReadinessRecord — see tests/speed-to-lead-append-only.test.ts).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LeadIntakeSource" AS ENUM ('WEB', 'WEB_EMAIL_FALLBACK', 'VOICE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
DO $$ BEGIN
  CREATE TYPE "LeadIntakeState" AS ENUM ('PENDING_FALLBACK', 'PROCESSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
DO $$ BEGIN
  CREATE TYPE "LeadVerdict" AS ENUM ('REAL', 'REVIEW', 'JUNK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
DO $$ BEGIN
  CREATE TYPE "OutreachKind" AS ENUM ('TEMPLATE_A', 'PERSONAL', 'FOLLOWUP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
DO $$ BEGIN
  CREATE TYPE "OutreachStatus" AS ENUM (
    'DRAFT', 'READY', 'PENDING_APPROVAL', 'APPROVED', 'DISPATCHING',
    'SENT', 'FAILED', 'UNKNOWN_DELIVERY', 'CANCELLED', 'SUPERSEDED', 'EXPIRED', 'BLOCKED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
DO $$ BEGIN
  CREATE TYPE "OutreachAttemptOutcome" AS ENUM ('SENT', 'FAILED', 'UNKNOWN_DELIVERY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
-- AlterTable: Lead timing row (spec Goal 9)
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "firstTouchAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "personalReplyAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "bookedAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "calledAt" TIMESTAMP(3);

-- statement-break
-- AlterTable: CompanySettings lead-inbox poll (a second, independent Gmail identity)
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxRefreshToken" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxEmail" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxHistoryId" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxCutoffAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollStartedAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollOk" BOOLEAN;

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "LeadIntakeEvent" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "submissionId" TEXT,
    "source" "LeadIntakeSource" NOT NULL,
    "state" "LeadIntakeState" NOT NULL DEFAULT 'PROCESSED',
    "dueAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "leadId" TEXT,
    "verdict" "LeadVerdict",
    "reasons" JSONB,
    "payload" JSONB NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeadIntakeEvent_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "LeadIntakeEvent_externalId_key" ON "LeadIntakeEvent"("externalId");
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "LeadIntakeEvent_submissionId_key" ON "LeadIntakeEvent"("submissionId");
-- statement-break
CREATE INDEX IF NOT EXISTS "LeadIntakeEvent_state_dueAt_idx" ON "LeadIntakeEvent"("state", "dueAt");
-- statement-break
CREATE INDEX IF NOT EXISTS "LeadIntakeEvent_leadId_idx" ON "LeadIntakeEvent"("leadId");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "LeadIntakeEvent" ADD CONSTRAINT "LeadIntakeEvent_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "ContactEndpoint" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3),
    "reason" TEXT,
    "source" TEXT,
    "bouncedAt" TIMESTAMP(3),
    "junkAt" TIMESTAMP(3),
    "clearedBy" TEXT,
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactEndpoint_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "ContactEndpoint_endpoint_key" ON "ContactEndpoint"("endpoint");

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "OutreachMessage" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" "OutreachKind" NOT NULL,
    "status" "OutreachStatus" NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "approvedVersionId" TEXT,
    "approvalHash" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "OutreachMessage_dedupeKey_key" ON "OutreachMessage"("dedupeKey");
-- statement-break
CREATE INDEX IF NOT EXISTS "OutreachMessage_leadId_idx" ON "OutreachMessage"("leadId");
-- statement-break
CREATE INDEX IF NOT EXISTS "OutreachMessage_status_idx" ON "OutreachMessage"("status");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "OutreachVersion" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "footer" TEXT NOT NULL,
    "threading" JSONB NOT NULL,
    "templateVersionId" TEXT,
    "renderInputs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachVersion_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "OutreachVersion_messageId_generation_key" ON "OutreachVersion"("messageId", "generation");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "OutreachVersion" ADD CONSTRAINT "OutreachVersion_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "OutreachMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "OutreachAttempt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "rfcMessageId" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "OutreachAttemptOutcome",
    "providerMessageId" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutreachAttempt_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "OutreachAttempt_rfcMessageId_key" ON "OutreachAttempt"("rfcMessageId");
-- statement-break
CREATE INDEX IF NOT EXISTS "OutreachAttempt_messageId_idx" ON "OutreachAttempt"("messageId");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "OutreachAttempt" ADD CONSTRAINT "OutreachAttempt_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "OutreachMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "OutreachTemplate" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "footer" TEXT NOT NULL,
    "fixedPhone" TEXT NOT NULL,
    "bookingBaseUrl" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "testOnly" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutreachTemplate_pkey" PRIMARY KEY ("id")
);

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "OutreachEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachEvent_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE INDEX IF NOT EXISTS "OutreachEvent_leadId_idx" ON "OutreachEvent"("leadId");
-- statement-break
CREATE INDEX IF NOT EXISTS "OutreachEvent_messageId_idx" ON "OutreachEvent"("messageId");
-- statement-break
CREATE INDEX IF NOT EXISTS "OutreachEvent_createdAt_idx" ON "OutreachEvent"("createdAt");

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "OutreachDailyCounter" (
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "OutreachDailyCounter_pkey" PRIMARY KEY ("day")
);

-- statement-break
-- CreateTable
CREATE TABLE IF NOT EXISTS "ReadinessRecord" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "deploySha" TEXT,
    "passed" BOOLEAN NOT NULL,
    "results" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReadinessRecord_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE INDEX IF NOT EXISTS "ReadinessRecord_fingerprint_idx" ON "ReadinessRecord"("fingerprint");
