ALTER TABLE "HelpRequest"
  ADD COLUMN IF NOT EXISTS "conversationId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalIssueRef" TEXT;

CREATE INDEX IF NOT EXISTS "HelpRequest_conversationId_idx"
  ON "HelpRequest" ("conversationId");

CREATE INDEX IF NOT EXISTS "HelpRequest_externalIssueRef_idx"
  ON "HelpRequest" ("externalIssueRef");
