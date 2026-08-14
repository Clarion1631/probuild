// Adds ChangeOrder.revision — a monotonic optimistic-concurrency token for
// approval/billing (replaces the updatedAt-based CAS guard on manual approval,
// which Codex rejected as too coarse: any write bumps updatedAt, including ones
// unrelated to billing inputs). Bumped in every transaction that changes billing
// inputs (items, schedules, pricing, status, signatures); NOT bumped by passive
// writes like viewedAt.
//
// Idempotent: ADD COLUMN IF NOT EXISTS. Additive only — no deletes, no drops,
// no destructive rewrites. Safe to run while the previous build is live; the
// new build's Prisma client selects "revision" immediately after this runs.
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-co-revision-schema.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env.local") });
config({ path: join(__dirname, "..", ".env") });

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const statements = [
    `ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0`,
];

try {
    for (const sql of statements) {
        await prisma.$executeRawUnsafe(sql);
        console.log("OK:", sql.split("\n")[0].slice(0, 80));
    }
    console.log("\nChangeOrder.revision schema applied successfully.");
} catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
