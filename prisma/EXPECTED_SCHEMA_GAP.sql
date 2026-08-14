-- The KNOWN, ACCEPTED gap between the committed migrations and prisma/schema.prisma.
--
-- prisma/schema.prisma is currently slightly AHEAD of production: PR #370 adopted
-- production's real shape into the schema file, but a handful of indexes and
-- foreign keys that schema.prisma declares were never actually created in prod.
-- This file is that gap, captured verbatim from production on 2026-08-14.
--
-- CI (scripts/check-migrations-match.mjs) asserts that a database built from
-- prisma/migrations/ differs from schema.prisma by EXACTLY this set — which is
-- how we prove the migrations reproduce production and nothing else drifted.
--
-- The follow-up that applies this gap to production should apply it as a normal
-- migration and then DELETE this file (an empty/absent file means zero gap).

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

-- CreateTable
CREATE TABLE "_SelectionProposalStatusBackup" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_SelectionProposalStatusBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessage_twilioMessageSid_key" ON "ClientMessage"("twilioMessageSid");

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

