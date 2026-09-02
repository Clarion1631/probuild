// One-off additive migration for Dispatch A1 shared task details.
// Adds nullable columns only and is safe to re-run while the old client is live.
//
// Run: node scripts/apply-dispatch-a1-schema.mjs
// Do not run this during development handoff; the release orchestrator applies it.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env", ".env.local"]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("DATABASE_URL not found in env or .env files");
}

const statements = [
  `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "doneWhen" TEXT`,
  `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "blockedReason" TEXT`,
  `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "scheduledTime" TEXT`,
  `ALTER TABLE "ScheduleTask" ADD COLUMN IF NOT EXISTS "confirmationStatus" TEXT`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

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
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
