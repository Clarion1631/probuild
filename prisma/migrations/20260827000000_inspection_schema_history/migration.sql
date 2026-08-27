-- Inspection schema history for fresh-database reproduction in CI.
-- The RLS and CHECK safeguards below are mirrored in the guarded production
-- rollout and asserted through prisma/prisma-blind-spots.json.

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "permitId" TEXT,
    "type" TEXT NOT NULL,
    "scheduledDate" TIMESTAMPTZ(6),
    "performedDate" TIMESTAMPTZ(6),
    "result" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "inspector" TEXT,
    "notes" TEXT,
    "customerNote" TEXT,
    "sharedToPortal" BOOLEAN NOT NULL DEFAULT false,
    "scheduleTaskId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Inspection_projectId_result_idx" ON "Inspection"("projectId", "result");

-- CreateIndex
CREATE INDEX "Inspection_projectId_sharedToPortal_result_idx" ON "Inspection"("projectId", "sharedToPortal", "result");

-- CreateIndex
CREATE INDEX "Inspection_permitId_idx" ON "Inspection"("permitId");

-- CreateIndex
CREATE INDEX "Inspection_scheduleTaskId_idx" ON "Inspection"("scheduleTaskId");

-- CreateIndex
CREATE INDEX "Inspection_createdById_idx" ON "Inspection"("createdById");

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_permitId_fkey" FOREIGN KEY ("permitId") REFERENCES "Permit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_scheduleTaskId_fkey" FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma cannot express these production safeguards.
ALTER TABLE "Inspection" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_result_check"
  CHECK ("result" IN ('SCHEDULED', 'PASSED', 'FAILED', 'PARTIAL'));

ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_required_date_check"
  CHECK (
    ("result" = 'SCHEDULED' AND "scheduledDate" IS NOT NULL)
    OR ("result" IN ('PASSED', 'FAILED', 'PARTIAL') AND "performedDate" IS NOT NULL)
  );
