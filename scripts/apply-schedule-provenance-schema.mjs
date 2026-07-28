// One-off additive migration for the Crew + Money Overlays feature
// (.specs/PB-pipeline-002-crew-money-overlays.md).
// Adds the generation-provenance column on ScheduleTask (nullable + index only)
// so regenerate can identify generated tasks without touching manual ones.
// Safe to run against the live DB while the deployed (old) client is in use.
// Mirrors scripts/apply-company-schedule-schema.mjs.
//
// Run:  node scripts/apply-schedule-provenance-schema.mjs
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
  // Generation provenance: which estimate generated this task (phase parents,
  // children, flat tasks, and milestone tasks alike). FK constraints have no
  // IF NOT EXISTS in Postgres — guard with a DO block so the script stays
  // re-runnable.
  `ALTER TABLE "ScheduleTask"
     ADD COLUMN IF NOT EXISTS "generatedFromEstimateId" TEXT`,
  `DO $$ BEGIN
     ALTER TABLE "ScheduleTask"
       ADD CONSTRAINT "ScheduleTask_generatedFromEstimateId_fkey"
       FOREIGN KEY ("generatedFromEstimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "ScheduleTask_generatedFromEstimateId_idx" ON "ScheduleTask" ("generatedFromEstimateId")`,
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
