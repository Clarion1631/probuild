// One-off additive migration for the logistics-job time-clock feature. Safe to
// re-run while the previous build is live — the statement is idempotent (ADD
// COLUMN IF NOT EXISTS). Additive DDL only — no deletes, no drops, no
// destructive rewrites. A NOT NULL column with a DEFAULT is safe to add to an
// existing table without a table rewrite/lock issue on Postgres (mirrors
// scripts/apply-time-suggestion-schema.mjs's convention).
//
// Run BEFORE deploying the build that ships this schema (see the pre-deploy
// checklist in CLAUDE.md):
//   node scripts/apply-logistics-project-flag.mjs
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const statements = [
    // ── Project — logistics/shop/admin job flag ──────────────────────────
    `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "isLogistics" BOOLEAN NOT NULL DEFAULT false`,
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
        console.log("\nLogistics project flag schema applied successfully.");
    } catch (e) {
        console.error("Migration failed:", e);
        process.exit(1);
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
