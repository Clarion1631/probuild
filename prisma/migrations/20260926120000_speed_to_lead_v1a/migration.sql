-- Speed-to-Lead v1a (PB-leads-001) — docs/plans/SPEED-TO-LEAD-V1A.md.
-- Additive only: 5 new enums, 5 new tables (LeadIntakeEvent, LeadAlert,
-- ContactEndpoint, SpeedToLeadEvent, LeadInboxMessage), 2 new Lead columns,
-- 9 new CompanySettings columns. No existing table is dropped, renamed, or has a
-- column altered/dropped/set NOT NULL. Re-runnable: every statement below is
-- IF NOT EXISTS or a duplicate_object-safe DO block. Its twin is
-- scripts/apply-speed-to-lead.mjs — the two carry identical DDL on purpose
-- (repo rule: prod is written by the script, CI's throwaway database is
-- built from this file). Each statement below is separated by a standalone
-- "-- statement-break" delimiter LINE, which is what that script's splitter
-- matches on — the marker text quoted in prose in this header comment is
-- never on a line of its own, so it is never mistaken for a real delimiter.

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
  CREATE TYPE "LeadAlertChannel" AS ENUM ('NTFY', 'CHAT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- statement-break
DO $$ BEGIN
  CREATE TYPE "LeadAlertStatus" AS ENUM ('PENDING', 'SENDING', 'DELIVERED', 'DEAD', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable: LeadIntakeEvent
-- statement-break
CREATE TABLE IF NOT EXISTS "LeadIntakeEvent" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "submissionId" TEXT,
    "source" "LeadIntakeSource" NOT NULL,
    "state" "LeadIntakeState" NOT NULL,
    "dueAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "leadId" TEXT,
    "verdict" "LeadVerdict",
    "reasons" JSONB,
    "payload" JSONB,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
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

-- CreateTable: LeadAlert
-- statement-break
CREATE TABLE IF NOT EXISTS "LeadAlert" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "channel" "LeadAlertChannel" NOT NULL,
    "status" "LeadAlertStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "claimedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "lastErrorCategory" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadAlert_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "LeadAlert_leadId_channel_key" ON "LeadAlert"("leadId", "channel");
-- statement-break
CREATE INDEX IF NOT EXISTS "LeadAlert_status_nextAttemptAt_idx" ON "LeadAlert"("status", "nextAttemptAt");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "LeadAlert" ADD CONSTRAINT "LeadAlert_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable: ContactEndpoint (junk only — v2 may add columns)
-- statement-break
CREATE TABLE IF NOT EXISTS "ContactEndpoint" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "junkAt" TIMESTAMP(3),
    "junkBy" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactEndpoint_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "ContactEndpoint_endpoint_key" ON "ContactEndpoint"("endpoint");

-- CreateTable: SpeedToLeadEvent (append-only)
-- statement-break
CREATE TABLE IF NOT EXISTS "SpeedToLeadEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "kind" TEXT NOT NULL,
    "actor" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),

    CONSTRAINT "SpeedToLeadEvent_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE INDEX IF NOT EXISTS "SpeedToLeadEvent_leadId_idx" ON "SpeedToLeadEvent"("leadId");
-- statement-break
CREATE INDEX IF NOT EXISTS "SpeedToLeadEvent_createdAt_idx" ON "SpeedToLeadEvent"("createdAt");

-- CreateTable: LeadInboxMessage (the lead-inbox scan's per-message ledger)
-- statement-break
CREATE TABLE IF NOT EXISTS "LeadInboxMessage" (
    "gmailMessageId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),

    CONSTRAINT "LeadInboxMessage_pkey" PRIMARY KEY ("gmailMessageId")
);

-- AlterTable: Lead — Booked/Called
-- statement-break
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "bookedAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "calledAt" TIMESTAMP(3);

-- AlterTable: CompanySettings — the gtrsupport@ read-only lead inbox
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxRefreshTokenEnc" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxEmail" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxCutoffAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxScanWatermarkAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollStartedAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxLastPollOk" BOOLEAN;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxFailureCount" INTEGER NOT NULL DEFAULT 0;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "leadInboxNextPollAt" TIMESTAMP(3);

-- RLS — no policies: deny via PostgREST, same as ReceiptRequestCard /
-- ClockInRequest (these hold lead PII). Prisma's diff engine cannot
-- represent RLS at all, so this is checked separately by
-- scripts/check-migrations-match.mjs's blind-spots assertion against
-- prisma/prisma-blind-spots.json — a snapshot of PRODUCTION's actual RLS
-- state. That snapshot will not list these 5 tables until they exist in
-- prod, so this assertion is EXPECTED to fail on this PR until R1 (Justin
-- applies this migration to prod, then re-runs
-- scripts/snapshot-prisma-blind-spots.mjs and commits the refreshed
-- snapshot) — see docs/plans/SPEED-TO-LEAD-V1A.md "RLS ordering".
-- statement-break
ALTER TABLE "LeadIntakeEvent" ENABLE ROW LEVEL SECURITY;
-- statement-break
ALTER TABLE "LeadAlert" ENABLE ROW LEVEL SECURITY;
-- statement-break
ALTER TABLE "ContactEndpoint" ENABLE ROW LEVEL SECURITY;
-- statement-break
ALTER TABLE "SpeedToLeadEvent" ENABLE ROW LEVEL SECURITY;
-- statement-break
ALTER TABLE "LeadInboxMessage" ENABLE ROW LEVEL SECURITY;
