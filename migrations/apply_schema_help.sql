CREATE TABLE IF NOT EXISTS "HelpRequest" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'help',
  "question" TEXT NOT NULL,
  "response" TEXT,
  "currentPage" TEXT,
  "status" TEXT DEFAULT 'open',
  "slackMessageTs" TEXT,
  "completedAt" TIMESTAMPTZ,
  "verifiedAt" TIMESTAMPTZ,
  "changeDescription" TEXT,
  "changeLocation" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT now()
);
