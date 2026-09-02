// One-off additive migration for the Automation Command Center.
// Creates the append-only AutomationEvent table (receipt pushes + sync runs).
// Safe to re-run while the old build is live: pure CREATE IF NOT EXISTS, no
// existing table is touched.
//
//   node scripts/apply-automation-events.mjs
//
// Apply BEFORE deploying the build that selects this table (P2022 otherwise).
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env", ".env.local"]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const statements = [
  `CREATE TABLE IF NOT EXISTS "AutomationEvent" (
     "id"          TEXT NOT NULL,
     "kind"        TEXT NOT NULL,
     "stage"       TEXT,
     "status"      TEXT NOT NULL,
     "reason"      TEXT,
     "source"      TEXT,
     "vendor"      TEXT,
     "projectName" TEXT,
     "docNumber"   TEXT,
     "fileName"    TEXT,
     "amountCents" INTEGER,
     "taxCents"    INTEGER,
     "detail"      TEXT,
     "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
   )`,
  // Re-runnable on a table created by an earlier version of this script.
  `ALTER TABLE "AutomationEvent" ADD COLUMN IF NOT EXISTS "stage" TEXT`,
  `CREATE INDEX IF NOT EXISTS "AutomationEvent_kind_createdAt_idx" ON "AutomationEvent"("kind", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "AutomationEvent_createdAt_idx" ON "AutomationEvent"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "AutomationEvent_docNumber_createdAt_idx" ON "AutomationEvent"("docNumber", "createdAt")`,
  // Server-only table accessed exclusively through Prisma with the service
  // role (which bypasses RLS); enabling RLS closes the anon-access gap the
  // same way apply-task-evidence-schema.mjs did for TaskPunchItem.
  `ALTER TABLE "AutomationEvent" ENABLE ROW LEVEL SECURITY`,
  // Command Center pause switches (pause-only by design; env vars stay the
  // opt-in masters for anything that writes the books).
  `CREATE TABLE IF NOT EXISTS "AutomationSetting" (
     "key"       TEXT NOT NULL,
     "value"     TEXT NOT NULL,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AutomationSetting_pkey" PRIMARY KEY ("key")
   )`,
  `ALTER TABLE "AutomationSetting" ENABLE ROW LEVEL SECURITY`,
];

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
  });

  for (const sql of statements) {
    console.log(sql.split("\n")[0].trim() + " ...");
    await prisma.$executeRawUnsafe(sql);
  }
  console.log("AutomationEvent schema applied.");
  await prisma.$disconnect();
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
