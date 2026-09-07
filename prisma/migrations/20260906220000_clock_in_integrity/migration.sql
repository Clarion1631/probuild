-- Fail closed on existing duplicate open punches. Never delete/close/reprice
-- history to make a uniqueness constraint fit. Manual hours are not open.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "TimeEntry" WHERE "endTime" IS NULL AND "durationHours" IS NULL GROUP BY "userId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Existing duplicate open punches require reviewed correction before clock-in migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TimeEntry_one_open_per_user" ON "TimeEntry"("userId") WHERE "endTime" IS NULL AND "durationHours" IS NULL;

CREATE TABLE IF NOT EXISTS "ClockInRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "timeEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClockInRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClockInRequest_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClockInRequest_userId_requestId_key" ON "ClockInRequest"("userId", "requestId");
CREATE INDEX IF NOT EXISTS "ClockInRequest_timeEntryId_idx" ON "ClockInRequest"("timeEntryId");
ALTER TABLE "ClockInRequest" ENABLE ROW LEVEL SECURITY;
