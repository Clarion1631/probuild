-- Payment reminders toggle
-- Adds a per-project flag for overdue invoice reminders.

ALTER TABLE "PortalVisibility"
ADD COLUMN IF NOT EXISTS "paymentRemindersEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
