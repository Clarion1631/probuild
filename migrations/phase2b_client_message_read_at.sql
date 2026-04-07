-- Phase 2b: Add readAt to ClientMessage for unread tracking
-- Also back-fills readAt from the legacy Message table for migrated rows
-- (preserves read status on messages that were already read before the migration)

BEGIN;

-- Add readAt column
ALTER TABLE "ClientMessage" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS "ClientMessage_readAt_idx" ON "ClientMessage"("readAt");

-- Back-fill readAt from legacy Message rows that were migrated in phase2
-- (only for project messages that have a matching id in Message)
UPDATE "ClientMessage" cm
SET "readAt" = m."readAt"
FROM "Message" m
WHERE cm.id = m.id
  AND m."readAt" IS NOT NULL
  AND cm."readAt" IS NULL;

-- Verify
SELECT
  COUNT(*) FILTER (WHERE "readAt" IS NOT NULL) AS with_read_at,
  COUNT(*) FILTER (WHERE "readAt" IS NULL)     AS unread,
  COUNT(*)                                      AS total
FROM "ClientMessage";

COMMIT;
