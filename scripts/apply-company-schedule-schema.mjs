// One-off additive migration for the Company Pipeline Dashboard feature
// (.specs/PB-pipeline-001-company-dashboard.md).
// Adds nullable columns + indexes only, then backfills the two legacy
// "Paid Ready to Start" statuses onto the new canonical "Waiting to Start".
// Safe to run against the live DB while the deployed (old) client is in use,
// since it never references these columns. Mirrors the CO countersignature
// migration (scripts/apply-co-countersign-schema.mjs).
//
// Run:  node scripts/apply-company-schedule-schema.mjs
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
  // Company-level start marker on the project (nullable — unset means the
  // start date hasn't been picked yet).
  `ALTER TABLE "Project"
     ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3),
     ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP(3)`,
  `CREATE INDEX IF NOT EXISTS "Project_startDate_idx" ON "Project" ("startDate")`,

  // Explicit link from a payment milestone to the schedule task it follows.
  // FK constraints have no IF NOT EXISTS in Postgres — guard with a DO block
  // so the script stays re-runnable.
  `ALTER TABLE "EstimatePaymentSchedule"
     ADD COLUMN IF NOT EXISTS "scheduleTaskId" TEXT`,
  `DO $$ BEGIN
     ALTER TABLE "EstimatePaymentSchedule"
       ADD CONSTRAINT "EstimatePaymentSchedule_scheduleTaskId_fkey"
       FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "EstimatePaymentSchedule_scheduleTaskId_idx" ON "EstimatePaymentSchedule" ("scheduleTaskId")`,

  `ALTER TABLE "PaymentSchedule"
     ADD COLUMN IF NOT EXISTS "scheduleTaskId" TEXT`,
  `DO $$ BEGIN
     ALTER TABLE "PaymentSchedule"
       ADD CONSTRAINT "PaymentSchedule_scheduleTaskId_fkey"
       FOREIGN KEY ("scheduleTaskId") REFERENCES "ScheduleTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "PaymentSchedule_scheduleTaskId_idx" ON "PaymentSchedule" ("scheduleTaskId")`,

  // Backfill stored legacy rows onto the canonical pipeline status (R1 fix 7).
  `UPDATE "Project" SET status = 'Waiting to Start'
     WHERE status IN ('Paid Ready to Start', 'Paid, Ready to Start')`,
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
