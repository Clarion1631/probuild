// One-off additive migration for SPEC-c task materials and staging.
// Safe to re-run while the previous build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-task-materials-schema.mjs
//
// Do not run this during implementation handoff. The new Prisma client uses
// TaskMaterial immediately, so this schema must be applied before deploy.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

const statements = [
  `CREATE TABLE IF NOT EXISTS "TaskMaterial" (
     "id" TEXT NOT NULL,
     "taskId" TEXT NOT NULL,
     "text" TEXT NOT NULL,
     "quantity" DECIMAL(65,30),
     "unit" TEXT,
     "location" TEXT,
     "status" TEXT NOT NULL DEFAULT 'pending',
     "sourceKind" TEXT NOT NULL DEFAULT 'manual',
     "sourceEstimateItemId" TEXT,
     "resolutionNote" TEXT,
     "order" INTEGER NOT NULL DEFAULT 0,
     "createdById" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     "statusChangedById" TEXT,
     "statusChangedAt" TIMESTAMP(3),
     CONSTRAINT "TaskMaterial_pkey" PRIMARY KEY ("id")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'TaskMaterial_taskId_fkey'
         AND conrelid = '"TaskMaterial"'::regclass
     ) THEN
       ALTER TABLE "TaskMaterial"
         ADD CONSTRAINT "TaskMaterial_taskId_fkey"
         FOREIGN KEY ("taskId") REFERENCES "ScheduleTask"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'TaskMaterial_createdById_fkey'
         AND conrelid = '"TaskMaterial"'::regclass
     ) THEN
       ALTER TABLE "TaskMaterial"
         ADD CONSTRAINT "TaskMaterial_createdById_fkey"
         FOREIGN KEY ("createdById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'TaskMaterial_statusChangedById_fkey'
         AND conrelid = '"TaskMaterial"'::regclass
     ) THEN
       ALTER TABLE "TaskMaterial"
         ADD CONSTRAINT "TaskMaterial_statusChangedById_fkey"
         FOREIGN KEY ("statusChangedById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "TaskMaterial_taskId_status_idx"
     ON "TaskMaterial" ("taskId", "status")`,
  `CREATE INDEX IF NOT EXISTS "TaskMaterial_taskId_sourceEstimateItemId_idx"
     ON "TaskMaterial" ("taskId", "sourceEstimateItemId")`,
  `CREATE INDEX IF NOT EXISTS "TaskMaterial_createdById_idx"
     ON "TaskMaterial" ("createdById")`,
  `CREATE INDEX IF NOT EXISTS "TaskMaterial_statusChangedById_idx"
     ON "TaskMaterial" ("statusChangedById")`,

  // This table is server-only. RLS with no policies makes the exposed
  // Supabase Data API deny anon/authenticated access. Prisma connects as the
  // database owner through the server-only pooler and is not subject to RLS
  // unless FORCE ROW LEVEL SECURITY is enabled (this script does not force it).
  `ALTER TABLE "TaskMaterial" ENABLE ROW LEVEL SECURITY`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0]);
  }
  console.log("TaskMaterial schema applied successfully.");
} finally {
  await prisma.$disconnect();
}
