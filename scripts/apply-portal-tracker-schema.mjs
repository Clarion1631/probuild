// One-off additive migration for SPEC PR-E portal tracker curation.
// Safe to re-run while the previous build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-portal-tracker-schema.mjs
//
// Do not run this during implementation handoff. The new Prisma client selects
// these columns immediately, so schema must be applied before deployment.
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
  `ALTER TABLE "DailyLog"
     ADD COLUMN IF NOT EXISTS "sharedToPortal" BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS "sharedContentHash" TEXT`,
  `ALTER TABLE "DailyLogPhoto"
     ADD COLUMN IF NOT EXISTS "sharedToPortal" BOOLEAN NOT NULL DEFAULT false`,

  // Both tables are server-only. RLS with no policies denies direct
  // anon/authenticated Data API access; server-side Prisma uses the owner role.
  `ALTER TABLE "DailyLog" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "DailyLogPhoto" ENABLE ROW LEVEL SECURITY`,
];

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
  });

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
      console.log("applied:", sql.split("\n")[0]);
    }
    console.log("Portal tracker schema applied successfully.");
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
