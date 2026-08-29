-- Per-member dispatch roster switch (replaces the role-based dispatch
-- roster). Owner-controlled on Company → Team members. Additive, idempotent
-- — safe while the previous build is live.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "showOnDispatch" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: preserve current dispatch-roster membership (FIELD_CREW,
-- ACTIVATED) so existing crews don't vanish from the board the moment this
-- ships. MANAGER/ADMIN dispatchable-by-role accounts (Richard, CJ) are left
-- off — the owner opts them in explicitly on the Team page.
UPDATE "User" SET "showOnDispatch" = true WHERE "role" = 'FIELD_CREW' AND "status" = 'ACTIVATED';
