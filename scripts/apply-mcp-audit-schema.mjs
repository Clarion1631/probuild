// One-off additive migration for per-person MCP connector keys + the
// actorUserId audit column on ActivityLog. Safe to re-run while the previous
// build is live.
//
// Run only through the release orchestrator:
//   node scripts/apply-mcp-audit-schema.mjs
//
// Do not run this during implementation handoff. Deploy this schema BEFORE
// the build that reads/writes McpKey or ActivityLog.actorUserId goes live.
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
  `CREATE TABLE IF NOT EXISTS "McpKey" (
     "id" TEXT NOT NULL,
     "label" TEXT NOT NULL,
     "keyHash" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "lastUsedAt" TIMESTAMP(3),
     "revokedAt" TIMESTAMP(3),
     CONSTRAINT "McpKey_pkey" PRIMARY KEY ("id")
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "McpKey_keyHash_key" ON "McpKey" ("keyHash")`,
  `CREATE INDEX IF NOT EXISTS "McpKey_userId_idx" ON "McpKey" ("userId")`,

  // Guarded FK: only add it if it isn't already present (idempotent re-run).
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'McpKey_userId_fkey'
         AND conrelid = '"McpKey"'::regclass
     ) THEN
       ALTER TABLE "McpKey"
         ADD CONSTRAINT "McpKey_userId_fkey"
         FOREIGN KEY ("userId") REFERENCES "User"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,

  // Metadata-only default-null add: brief ACCESS EXCLUSIVE lock, no rewrite.
  // The lock_timeout keeps it from queueing behind a long read and stalling
  // every writer on a live table.
  `SET lock_timeout = '5s'`,
  `ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "actorUserId" TEXT`,
  // Plain (non-CONCURRENT) build is correct here: ActivityLog is ~200 rows /
  // 216 kB, so the build is sub-millisecond, and CREATE INDEX CONCURRENTLY is
  // unreliable through the pgbouncer transaction pooler this URL uses.
  `CREATE INDEX IF NOT EXISTS "ActivityLog_actorUserId_createdAt_idx" ON "ActivityLog" ("actorUserId", "createdAt")`,
  `SET lock_timeout = '0'`,

  // Server-only table. RLS with no policies denies anon/authenticated access
  // through Supabase's exposed Data API. Prisma uses the database-owner
  // server connection, and this script intentionally does not FORCE RLS.
  `ALTER TABLE "McpKey" ENABLE ROW LEVEL SECURITY`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("applied:", sql.split("\n")[0]);
  }
  console.log("MCP audit schema (McpKey + ActivityLog.actorUserId) applied successfully.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
