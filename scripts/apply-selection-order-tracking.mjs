// One-off additive migration for Selection Order Tracking + Delivery Risk
// (docs/superpowers/plans/2026-07-31-selection-order-tracking.md). Safe to
// re-run while the previous build is live — every statement is idempotent
// (ADD COLUMN IF NOT EXISTS). Additive DDL only — no deletes, no drops, no
// destructive rewrites. Three nullable columns on the existing Decision
// table — no new tables, so no RLS statements are needed here (mirrors
// scripts/apply-selection-templates.mjs's convention for existing tables).
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-selection-order-tracking.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const statements = [
    // ── Decision — order tracking + delivery risk ────────────────────────
    `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "orderedAt" TIMESTAMP(3)`,
    `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "orderedBy" TEXT`,
    `ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "expectedArrivalAt" TIMESTAMP(3)`,
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 80));
    }
    console.log("\nSelection order tracking schema applied successfully.");
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
