-- Closes the gap that prisma/EXPECTED_SCHEMA_GAP.sql recorded when the
-- 2026-08-14 baseline was taken: seven foreign keys and three indexes that
-- prisma/schema.prisma declares but production never actually had.
--
-- The baseline (20260814000000_baseline_production) was generated FROM
-- PRODUCTION, so it faithfully records prod's shape INCLUDING these omissions.
-- This migration is the correction, exactly as the baseline's header and
-- CLAUDE.md prescribe: a new migration, never an edit to the baseline.
--
-- Five of the seven "drops" below are not removals. Production already has
-- those constraints, but with ON UPDATE NO ACTION where schema.prisma declares
-- ON UPDATE CASCADE; PostgreSQL has no ALTER CONSTRAINT for referential
-- actions, so changing one means DROP + ADD. Ids are cuids and are never
-- rewritten, so the ON UPDATE action is inert in practice — this aligns the
-- catalog with the declaration rather than changing behaviour.
--
-- Two changes are NOT inert and are called out deliberately:
--   * Project_leadId_fkey moves ON DELETE SET NULL -> RESTRICT. Deleting a Lead
--     that has been converted to a Project now fails instead of silently
--     orphaning the Project. RESTRICT is what schema.prisma has declared all
--     along, so the Prisma client already assumes it.
--   * Project_managerId_fkey does not exist in production at all. Until now
--     Project.managerId could reference a deleted User.
--
-- Production applies this via `node scripts/apply-missing-fk-indexes.mjs --prod`
-- (the local write path — see CLAUDE.md "Schema migrations"), then records it
-- with `prisma migrate resolve --applied 20260814120000_missing_fk_indexes`.
--
-- BEGIN/COMMIT is explicit because Prisma does not wrap a PostgreSQL migration
-- file in a transaction for you. Without it a failure partway down — say the
-- Project_managerId_fkey add hitting an orphaned managerId — would leave the six
-- drops applied and their re-adds missing, i.e. a database with FEWER foreign
-- keys than it started with and no record that the migration ran. All of it is
-- transactional DDL in PostgreSQL, so all-or-nothing is available here; the one
-- statement form that could not participate, CREATE INDEX CONCURRENTLY, is
-- deliberately not used in this file (see below).
--
-- These CREATE INDEX statements are NOT CONCURRENTLY. This file only ever runs
-- against a throwaway database — CI's migrations job and any future
-- `migrate deploy` on a fresh instance — where a brief write lock costs nothing
-- and transactional safety is worth more. Production does not run this file at
-- all; scripts/apply-missing-fk-indexes.mjs builds the same indexes
-- CONCURRENTLY, outside any transaction, with a bounded lock_timeout.

BEGIN;

-- DropForeignKey
ALTER TABLE "ClientMessage" DROP CONSTRAINT "ClientMessage_projectId_fkey";

-- DropForeignKey
ALTER TABLE "OfficeTask" DROP CONSTRAINT "OfficeTask_assigneeId_fkey";

-- DropForeignKey
ALTER TABLE "OfficeTask" DROP CONSTRAINT "OfficeTask_columnId_fkey";

-- DropForeignKey
ALTER TABLE "OfficeTask" DROP CONSTRAINT "OfficeTask_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Project" DROP CONSTRAINT "Project_leadId_fkey";

-- DropForeignKey
ALTER TABLE "TaskCommentPhoto" DROP CONSTRAINT "TaskCommentPhoto_commentId_fkey";

-- CreateIndex
CREATE INDEX "ClientMessage_leadId_idx" ON "ClientMessage"("leadId");

-- CreateIndex
CREATE INDEX "ClientMessage_createdAt_idx" ON "ClientMessage"("createdAt");

-- CreateIndex
CREATE INDEX "EstimatePaymentSchedule_estimateId_idx" ON "EstimatePaymentSchedule"("estimateId");

-- AddForeignKey
ALTER TABLE "OfficeTask" ADD CONSTRAINT "OfficeTask_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "OfficeBoardColumn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeTask" ADD CONSTRAINT "OfficeTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeTask" ADD CONSTRAINT "OfficeTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCommentPhoto" ADD CONSTRAINT "TaskCommentPhoto_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TaskComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
