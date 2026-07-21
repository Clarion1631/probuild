// One-off additive migration for the CO → schedule feature
// (.specs/PB-pipeline-003-co-schedule.md).
// Adds CO-task provenance on ScheduleTask and the milestone↔calendar link on
// ChangeOrderPaymentSchedule (nullable + indexes only; old client unaffected).
// Mirrors scripts/apply-schedule-provenance-schema.mjs.
//
// Run:  node scripts/apply-co-schedule-schema.mjs
// (DDL via $executeRawUnsafe over the Supabase transaction pooler — the working
//  path in this project; psql / prisma db push / migrate dev do not work here.)
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const statements = [
  // CO-task provenance (mirrors generatedFromEstimateId): which change order
  // generated this task, so regenerate can identify CO tasks specifically.
  `ALTER TABLE "ScheduleTask"
     ADD COLUMN IF NOT EXISTS "generatedFromChangeOrderId" TEXT`,
  `DO $$ BEGIN
     ALTER TABLE "ScheduleTask"
       ADD CONSTRAINT "ScheduleTask_generatedFromChangeOrderId_fkey"
       FOREIGN KEY ("generatedFromChangeOrderId") REFERENCES "ChangeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "ScheduleTask_generatedFromChangeOrderId_idx" ON "ScheduleTask" ("generatedFromChangeOrderId")`,

  // Milestone↔calendar tie for CO payment rows (mirrors the P1 pattern on
  // EstimatePaymentSchedule / PaymentSchedule).
  `ALTER TABLE "ChangeOrderPaymentSchedule"
     ADD COLUMN IF NOT EXISTS "scheduleTaskId" TEXT`,
  `DO $$ BEGIN
     ALTER TABLE "ChangeOrderPaymentSchedule"
       ADD CONSTRAINT "ChangeOrderPaymentSchedule_scheduleTaskId_fkey"
       FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "ChangeOrderPaymentSchedule_scheduleTaskId_idx" ON "ChangeOrderPaymentSchedule" ("scheduleTaskId")`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("✔ applied:", sql.split("\n")[0]);
  }
  console.log("Done.");
} catch (e) {
  console.error("Migration failed:", e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
