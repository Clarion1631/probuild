// One-off additive migration for AI Auto-Sort for Unsorted Selection Items
// (docs/superpowers/plans/2026-07-30-selection-ai-sort.md, Phase 2).
// Safe to re-run while the previous build is live — every statement is
// idempotent (ADD COLUMN IF NOT EXISTS). Additive DDL only — no deletes, no
// drops, no destructive rewrites.
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-selection-ai-sort.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const statements = [
    // Not an FK — suggestions are advisory and may go stale (decision
    // deleted/renamed); read paths validate against the project's live
    // decisions and treat a non-matching value as "no suggestion".
    `ALTER TABLE "SelectionProposal" ADD COLUMN IF NOT EXISTS "suggestedDecisionId" TEXT`,
    `ALTER TABLE "SelectionProposal" ADD COLUMN IF NOT EXISTS "suggestedAt" TIMESTAMP(3)`,
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 80));
    }
    console.log("\nSelection AI sort schema applied successfully.");
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
