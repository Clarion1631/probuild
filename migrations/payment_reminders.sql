-- Payment reminders: additive columns only, no data loss.
-- Project.paymentRemindersEnabled — per-project OPT-IN for the automated reminder cron.
-- Defaults to false for both new and existing rows: reminders only start firing once
-- someone explicitly flips the "Payment Reminders" toggle on a project's Client
-- Dashboard settings page (/projects/[id]/client-portal).
-- PaymentSchedule.lastReminderAt — throttle guard so a milestone gets at most ~1 reminder/week.

BEGIN;

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "paymentRemindersEnabled" BOOLEAN NOT NULL DEFAULT false;

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
