// One-off additive migration for Decision Templates + Schedule-Driven Due
// Dates (docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// Safe to re-run while the previous build is live — every statement is
// idempotent (IF NOT EXISTS / guarded DO $$ blocks). Additive DDL only — no
// deletes, no drops, no destructive rewrites.
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-selection-templates.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const statements = [
    // ── DecisionTemplate ─────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS "DecisionTemplate" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "archivedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    // ── DecisionTemplateItem ─────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS "DecisionTemplateItem" (
        "id" TEXT PRIMARY KEY,
        "templateId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "area" TEXT,
        "defaultLeadTimeDays" INTEGER,
        "scheduleHint" TEXT,
        "order" INTEGER NOT NULL DEFAULT 0
    )`,
    `DO $$ BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'DecisionTemplateItem_templateId_fkey'
              AND conrelid = '"DecisionTemplateItem"'::regclass
        ) THEN
            ALTER TABLE "DecisionTemplateItem"
                ADD CONSTRAINT "DecisionTemplateItem_templateId_fkey"
                FOREIGN KEY ("templateId") REFERENCES "DecisionTemplate"("id")
                ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
    END $$`,
    `CREATE INDEX IF NOT EXISTS "DecisionTemplateItem_templateId_order_idx" ON "DecisionTemplateItem" ("templateId", "order")`,

    // ── Decision — schedule-driven due dates ─────────────────────────────
    `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "scheduleTaskId" TEXT`,
    `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "leadTimeDays" INTEGER`,
    `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3)`,

    // Server-only tables. RLS with no policies denies direct anon/
    // authenticated Data API access; server-side Prisma uses the owner role.
    // Matches the convention in scripts/apply-selection-item-threads.mjs.
    `ALTER TABLE "DecisionTemplate" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "DecisionTemplateItem" ENABLE ROW LEVEL SECURITY`,
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 80));
    }
    console.log("\nSelection templates + due dates schema applied successfully.");
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
