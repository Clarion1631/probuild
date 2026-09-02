// One-off additive migration for MCP PM Phase 1 actor attribution.
// Safe to re-run while the previous build is live.
//
// Run only through release orchestration before deploying the new build:
//   node scripts/apply-mcp-pm-schema.mjs
//
// Do not run this during implementation handoff.
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
  `ALTER TABLE "McpConfirmation"
     ADD COLUMN IF NOT EXISTS "actorLabel" TEXT NOT NULL DEFAULT 'justin-ai'`,
  `ALTER TABLE "TaskPunchItem"
     ADD COLUMN IF NOT EXISTS "createdById" TEXT`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'TaskPunchItem_createdById_fkey'
         AND conrelid = '"TaskPunchItem"'::regclass
     ) THEN
       ALTER TABLE "TaskPunchItem"
         ADD CONSTRAINT "TaskPunchItem_createdById_fkey"
         FOREIGN KEY ("createdById") REFERENCES "User"("id")
         ON DELETE SET NULL ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "TaskPunchItem_createdById_idx"
     ON "TaskPunchItem" ("createdById")`,
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
    console.log("MCP PM schema applied successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
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
