-- Payment reminders: additive columns only, no data loss.
-- Project.paymentRemindersEnabled — per-project opt-out of the automated reminder cron.
-- PaymentSchedule.lastReminderAt — throttle guard so a milestone gets at most ~1 reminder/week.

BEGIN;

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "paymentRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "PaymentSchedule" ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMPTZ;

-- Verify
SELECT
  COUNT(*) FILTER (WHERE "paymentRemindersEnabled") AS reminders_enabled,
  COUNT(*)                                           AS total
FROM "Project";

SELECT
  COUNT(*) FILTER (WHERE "lastReminderAt" IS NOT NULL) AS with_last_reminder,
  COUNT(*)                                              AS total
FROM "PaymentSchedule";

COMMIT;
