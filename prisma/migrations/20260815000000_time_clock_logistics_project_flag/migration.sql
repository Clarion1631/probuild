-- Backfills Prisma migration history for the logistics time-clock project flag.
-- Production was aligned separately; this lets a fresh database built from
-- committed migrations reproduce that shape.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "isLogistics" BOOLEAN NOT NULL DEFAULT false;
