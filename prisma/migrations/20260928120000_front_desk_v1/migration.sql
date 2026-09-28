-- Front Desk v1 (PB-frontdesk-001) — docs/plans/FRONT-DESK-V1.md §5.
-- Additive only: 2 new enum values on EXISTING enums, 3 new enums, 3 new
-- tables (FrontDeskCall, FrontDeskBooking, FrontDeskTransfer), 3 partial
-- unique indexes, 11 new CompanySettings columns. No existing table is
-- dropped, renamed, or has a column altered/dropped/set NOT NULL.
-- Re-runnable: every statement below is IF NOT EXISTS or a
-- duplicate_object-safe DO block. Its twin is scripts/apply-front-desk.mjs —
-- the two carry identical DDL on purpose (repo rule: prod is written by the
-- script, CI's throwaway database is built from this file). Each statement
-- below is separated by a standalone "-- statement-break" delimiter LINE,
-- which is what that script's splitter matches on — the marker text quoted
-- in prose in this header comment is never on a line of its own, so it is
-- never mistaken for a real delimiter.
--
-- ADD VALUE inside a transaction block is allowed on PG12+ (CI's postgres:16
-- and Supabase both qualify). Nothing in this migration's own statements
-- reads either new enum value — the app only starts using them after this
-- transaction commits.

-- AlterEnum: LeadIntakeSource gains FRONT_DESK_CALL
ALTER TYPE "LeadIntakeSource" ADD VALUE IF NOT EXISTS 'FRONT_DESK_CALL';
-- statement-break
-- AlterEnum: LeadAlertChannel gains NTFY_URGENT
ALTER TYPE "LeadAlertChannel" ADD VALUE IF NOT EXISTS 'NTFY_URGENT';

-- CreateEnum
-- statement-break
DO $$ BEGIN
  CREATE TYPE "FrontDeskOutcome" AS ENUM ('BOOKED', 'TRANSFERRED', 'MISSED_TRANSFER', 'MESSAGE', 'SPAM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- statement-break
DO $$ BEGIN
  CREATE TYPE "FrontDeskBookingStatus" AS ENUM ('SUBMITTING', 'BOOKED', 'NOT_BOOKED', 'UNCERTAIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- statement-break
DO $$ BEGIN
  CREATE TYPE "FrontDeskTransferStatus" AS ENUM ('PREPARED', 'DIALING', 'CONNECTED', 'MISSED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable: FrontDeskCall
-- statement-break
CREATE TABLE IF NOT EXISTS "FrontDeskCall" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "callerPhoneE164" TEXT,
    "offeredSlots" JSONB NOT NULL DEFAULT '[]',
    "slotSeq" INTEGER NOT NULL DEFAULT 0,
    "outcome" "FrontDeskOutcome",
    "postCallProcessedAt" TIMESTAMP(3),
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrontDeskCall_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskCall_conversationId_key" ON "FrontDeskCall"("conversationId");
-- statement-break
CREATE INDEX IF NOT EXISTS "FrontDeskCall_leadId_idx" ON "FrontDeskCall"("leadId");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "FrontDeskCall" ADD CONSTRAINT "FrontDeskCall_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable: FrontDeskBooking
-- statement-break
CREATE TABLE IF NOT EXISTS "FrontDeskBooking" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "FrontDeskBookingStatus" NOT NULL,
    "reason" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "eventTypeUri" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "inviteeUri" TEXT,
    "eventUri" TEXT,
    "cancelUrl" TEXT,
    "rescheduleUrl" TEXT,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "lastReconcileAt" TIMESTAMP(3),
    "reconcileStoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrontDeskBooking_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskBooking_conversationId_requestHash_key" ON "FrontDeskBooking"("conversationId", "requestHash");
-- statement-break
-- §2.2 step 3: one active booking per call. Prisma cannot express a partial
-- unique index, so this is appended by hand (§5's note) and re-asserted in
-- the Prisma schema's own comment pointing back here.
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskBooking_one_active_per_call_key" ON "FrontDeskBooking"("conversationId") WHERE "status" IN ('SUBMITTING', 'BOOKED', 'UNCERTAIN');
-- statement-break
-- §2.2 step 6: one active booking per Calendly slot.
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskBooking_one_active_per_slot_key" ON "FrontDeskBooking"("eventTypeUri", "startTime") WHERE "status" IN ('SUBMITTING', 'BOOKED', 'UNCERTAIN');
-- statement-break
CREATE INDEX IF NOT EXISTS "FrontDeskBooking_phoneE164_idx" ON "FrontDeskBooking"("phoneE164");
-- statement-break
CREATE INDEX IF NOT EXISTS "FrontDeskBooking_emailLower_idx" ON "FrontDeskBooking"("emailLower");
-- statement-break
CREATE INDEX IF NOT EXISTS "FrontDeskBooking_status_updatedAt_idx" ON "FrontDeskBooking"("status", "updatedAt");

-- CreateTable: FrontDeskTransfer
-- statement-break
CREATE TABLE IF NOT EXISTS "FrontDeskTransfer" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "FrontDeskTransferStatus" NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "callerName" TEXT NOT NULL,
    "callbackPhoneE164" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "spanish" BOOLEAN NOT NULL DEFAULT false,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bridgeCallSid" TEXT,
    "dialStartedAt" TIMESTAMP(3),
    "screenAcceptedAt" TIMESTAMP(3),
    "dialCallSid" TEXT,
    "dialCallStatus" TEXT,
    "dialBridged" BOOLEAN,
    "resolvedAt" TIMESTAMP(3),
    "reason" TEXT,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrontDeskTransfer_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskTransfer_conversationId_key" ON "FrontDeskTransfer"("conversationId");
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskTransfer_bridgeCallSid_key" ON "FrontDeskTransfer"("bridgeCallSid");
-- statement-break
-- §3.1: at most one PREPARED-or-DIALING transfer, across every call. `(true)`
-- makes this a table-wide singleton predicated on status — the whole point
-- being it has nothing to do with any one column's VALUE. Acceptance test 30
-- proves this actually serializes two concurrent prepares.
CREATE UNIQUE INDEX IF NOT EXISTS "FrontDeskTransfer_one_active_key" ON "FrontDeskTransfer"((true)) WHERE "status" IN ('PREPARED', 'DIALING');
-- statement-break
CREATE INDEX IF NOT EXISTS "FrontDeskTransfer_leadId_idx" ON "FrontDeskTransfer"("leadId");
-- statement-break
DO $$ BEGIN
  ALTER TABLE "FrontDeskTransfer" ADD CONSTRAINT "FrontDeskTransfer_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable: CompanySettings (11 new nullable/defaulted columns)
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskTakingTransfers" BOOLEAN NOT NULL DEFAULT false;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskTakingTransfersBy" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskTakingTransfersAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyTokenEnc" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyTokenSetBy" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyTokenSetAt" TIMESTAMP(3);
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyUserUri" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyPlan" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyEventTypeUri" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyTestEventTypeUri" TEXT;
-- statement-break
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "frontDeskCalendlyAuthFailedAt" TIMESTAMP(3);

-- RLS: enabled, no policies (deny via PostgREST) — same as every
-- LeadIntakeEvent-adjacent table (v1a precedent).
-- statement-break
ALTER TABLE "FrontDeskCall" ENABLE ROW LEVEL SECURITY;
-- statement-break
ALTER TABLE "FrontDeskBooking" ENABLE ROW LEVEL SECURITY;
-- statement-break
ALTER TABLE "FrontDeskTransfer" ENABLE ROW LEVEL SECURITY;
