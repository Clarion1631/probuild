-- Add baseline date fields to ScheduleTask
ALTER TABLE "ScheduleTask" ADD COLUMN "baselineStartDate" TIMESTAMP(3);
ALTER TABLE "ScheduleTask" ADD COLUMN "baselineEndDate" TIMESTAMP(3);
