// One-off additive migration for the daily-log-driven time-entry accuracy
// feature. Safe to re-run while the previous build is live — every statement
// is idempotent (ADD COLUMN IF NOT EXISTS). Additive DDL only — no deletes,
// no drops, no destructive rewrites. Nullable columns on existing tables
// only, so no RLS statements are needed (mirrors
// scripts/apply-selection-order-tracking.mjs's convention).
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-time-suggestion-schema.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const statements = [
    // ── DailyLog — next steps + AI task match ────────────────────────────
    `ALTER TABLE "DailyLog" ADD COLUMN IF NOT EXISTS "nextSteps" TEXT`,
    `ALTER TABLE "DailyLog" ADD COLUMN IF NOT EXISTS "aiSuggestedTaskId" TEXT`,
    `ALTER TABLE "DailyLog" ADD COLUMN IF NOT EXISTS "aiSuggestionReason" TEXT`,
    // ── Project — Chat post-back webhook (credential; manager-only) ──────
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "chatWebhookUrl" TEXT`,
    // ── TimeEntry — clock-in suggestion audit ────────────────────────────
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "suggestedScheduleTaskId" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "suggestedCostCodeId" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "suggestedTaskName" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "suggestionSource" TEXT`,
    `ALTER TABLE "TimeEntry" ADD COLUMN IF NOT EXISTS "suggestionOverridden" BOOLEAN NOT NULL DEFAULT false`,
];

async function main() {
    config({ path: join(__dirname, "..", ".env.local") });
    config({ path: join(__dirname, "..", ".env") });

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        for (const sql of statements) {
            await prisma.$executeRawUnsafe(sql);
            console.log("OK:", sql.split("\n")[0].slice(0, 80));
        }
        console.log("\nTime-suggestion schema applied successfully.");
    } catch (e) {
        console.error("Migration failed:", e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    await main();
}
