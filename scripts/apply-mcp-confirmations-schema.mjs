// One-off additive migration for SPEC-f single-use MCP confirmations.
// Safe to re-run while the previous build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-mcp-confirmations-schema.mjs
//
// Do not run this during implementation handoff. The MCP schedule tools use
// McpConfirmation immediately, so this schema must be applied before deploy.
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
  `CREATE TABLE IF NOT EXISTS "McpConfirmation" (
     "id" TEXT NOT NULL,
     "token" TEXT NOT NULL,
     "toolName" TEXT NOT NULL,
     "argsHash" TEXT NOT NULL,
     "preview" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "expiresAt" TIMESTAMP(3) NOT NULL,
     "consumedAt" TIMESTAMP(3),
     CONSTRAINT "McpConfirmation_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "McpConfirmation_token_key" UNIQUE ("token")
   )`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'McpConfirmation_token_key'
         AND conrelid = '"McpConfirmation"'::regclass
     ) THEN
       ALTER TABLE "McpConfirmation"
         ADD CONSTRAINT "McpConfirmation_token_key" UNIQUE ("token");
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "McpConfirmation_expiresAt_idx"
     ON "McpConfirmation" ("expiresAt")`,

  // Server-only table. RLS with no policies denies anon/authenticated access
  // through Supabase's exposed Data API. Prisma uses the database-owner
  // server connection, and this script intentionally does not FORCE RLS.
  `ALTER TABLE "McpConfirmation" ENABLE ROW LEVEL SECURITY`,
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
    console.log("McpConfirmation schema applied successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
