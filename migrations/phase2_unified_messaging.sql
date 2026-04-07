-- Phase 2: Rename LeadMessage → ClientMessage and add optional projectId
-- This unifies lead and project client communication into one model.
-- Existing project Message/MessageThread rows are migrated into ClientMessage.
-- MessageThread/Message tables are KEPT for subcontractor communication only.

BEGIN;

-- 1. Rename the table
ALTER TABLE "LeadMessage" RENAME TO "ClientMessage";

-- 2. Add optional projectId column
ALTER TABLE "ClientMessage" ADD COLUMN "projectId" TEXT;
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE;
CREATE INDEX "ClientMessage_projectId_idx" ON "ClientMessage"("projectId");

-- 3. Migrate existing client-facing project Message rows into ClientMessage
--    (preserves all project-level message history — never loses data)
INSERT INTO "ClientMessage" (
  id, "projectId", "leadId", direction, "senderName", "senderEmail",
  body, channel, "sentViaEmail", "sentViaSms", status, "createdAt"
)
SELECT
  m.id,
  mt."projectId",
  NULL,  -- no leadId for these — they came from project threads
  CASE WHEN m."senderType" = 'CLIENT' THEN 'INBOUND' ELSE 'OUTBOUND' END,
  m."senderName",
  m."senderEmail",
  m.body,
  'app',
  false,
  false,
  'SENT',
  m."createdAt"
FROM "Message" m
JOIN "MessageThread" mt ON m."threadId" = mt.id
WHERE mt."subcontractorId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "ClientMessage" WHERE id = m.id);  -- avoid collision

-- 4. Verify migration
SELECT
  (SELECT COUNT(*) FROM "ClientMessage") AS total_client_messages,
  (SELECT COUNT(*) FROM "ClientMessage" WHERE "leadId" IS NOT NULL AND "projectId" IS NULL) AS lead_messages,
  (SELECT COUNT(*) FROM "ClientMessage" WHERE "projectId" IS NOT NULL) AS project_messages,
  (SELECT COUNT(*) FROM "Message" m JOIN "MessageThread" mt ON m."threadId" = mt.id WHERE mt."subcontractorId" IS NULL) AS source_project_messages;

COMMIT;
