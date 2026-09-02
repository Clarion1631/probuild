// One-off additive migration for the actorUserId audit column on ActivityLog,
// used to attribute MCP connector writes (read_file/get_activity_log etc.) to
// a real ProBuild user instead of only a shared-secret actor label.
//
// Already applied to production on 2026-07-28 — safe to re-run (idempotent
// IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
//
// Run only through the release orchestrator:
//   node scripts/apply-mcp-audit-schema.mjs
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
  // Metadata-only default-null add: brief ACCESS EXCLUSIVE lock, no rewrite.
  // The lock_timeout keeps it from queueing behind a long read and stalling
  // every writer on a live table.
  `SET lock_timeout = '5s'`,
  `ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "actorUserId" TEXT`,
  // Plain (non-CONCURRENT) build is correct here: ActivityLog is a small
  // table, so the build is sub-millisecond, and CREATE INDEX CONCURRENTLY is
  // unreliable through the pgbouncer transaction pooler this URL uses.
  `CREATE INDEX IF NOT EXISTS "ActivityLog_actorUserId_createdAt_idx" ON "ActivityLog" ("actorUserId", "createdAt")`,
  `SET lock_timeout = '0'`,
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
    console.log("MCP audit schema (ActivityLog.actorUserId) applied successfully.");
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
