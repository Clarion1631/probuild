// One-off additive migration for the Google Chat → daily log → schedule pipeline.
//   Project.googleChatSpaceId  — maps a Chat job space ("spaces/AAQ…") to its project
//   Project.clientNextSteps(+At) — AI-written, customer-safe "what's next" blurb for the portal
//   DailyLog.source            — "manual" | "mcp" | "chat"; chat rows are ingest-owned
//   DailyLog.chatMessageName   — Chat message resource name; the ingest dedupe key
//   ScheduleTask.progressSource — "human" | "ai"; a human write is durable, AI must skip it
//
// Safe to re-run while the old build is live (IF NOT EXISTS throughout), but the new
// Prisma client selects these columns immediately — apply BEFORE deploying the build.
//   node scripts/apply-chat-field-progress-schema.mjs
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
  `ALTER TABLE "Project"
     ADD COLUMN IF NOT EXISTS "googleChatSpaceId" TEXT`,
  // Partial unique: many projects have no space, so NULLs must not collide.
  `CREATE UNIQUE INDEX IF NOT EXISTS "Project_googleChatSpaceId_key"
     ON "Project" ("googleChatSpaceId")`,
  `ALTER TABLE "Project"
     ADD COLUMN IF NOT EXISTS "clientNextSteps" TEXT`,
  `ALTER TABLE "Project"
     ADD COLUMN IF NOT EXISTS "clientNextStepsAt" TIMESTAMP(3)`,
  // Existing rows are all human/MCP-written; "manual" is the honest default.
  `ALTER TABLE "DailyLog"
     ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE "DailyLog"
     ADD COLUMN IF NOT EXISTS "chatMessageName" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DailyLog_chatMessageName_key"
     ON "DailyLog" ("chatMessageName")`,
  // No backfill: NULL means "never written since provenance existed", which the
  // AI writer treats as writable. Stamping historic rows "human" would freeze
  // every task the moment this ships.
  `ALTER TABLE "ScheduleTask"
     ADD COLUMN IF NOT EXISTS "progressSource" TEXT`,
  // Photo identity for the chat ingest: retry-safe and concurrency-safe.
  // Safe on existing data — the DailyLogPhoto table had zero rows at ship time.
  `CREATE UNIQUE INDEX IF NOT EXISTS "DailyLogPhoto_dailyLogId_url_key"
     ON "DailyLogPhoto" ("dailyLogId", "url")`,
];

try {
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql);
    console.log("✔ applied:", sql.split("\n")[0]);
  }
  console.log("Done.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
