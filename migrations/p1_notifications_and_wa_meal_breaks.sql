-- P1: durable Notification log + WA meal-break compliance fields on TimeEntry.
-- Additive only (new table + nullable/defaulted columns); no existing rows are modified.
-- Applied to prod (ghzdbzdnwjxazvmcefbh) on 2026-05-29 via Supabase migrate.

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'info',
  "title" TEXT NOT NULL,
  "body" TEXT,
  "projectId" TEXT,
  "timeEntryId" TEXT,
  "expenseId" TEXT,
  "actorId" TEXT,
  "dedupeKey" TEXT,
  "channels" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX IF NOT EXISTS "Notification_projectId_idx" ON "Notification"("projectId");
CREATE INDEX IF NOT EXISTS "Notification_readAt_idx" ON "Notification"("readAt");

ALTER TABLE "TimeEntry"
  ADD COLUMN IF NOT EXISTS "mealSkipped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "mealDeductionHours" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "needsReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reviewReason" TEXT;
